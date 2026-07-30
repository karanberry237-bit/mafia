const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { fmt } = require("./economy");
const gangs = require("./gangs");
const businesses = require("./businesses");
const turf = require("./turf");
const bank = require("./bank");

// ── Bounties ───────────────────────────────────────────────────────────────
// Place a price on someone's head. Whoever successfully robs that target
// (via economy.attemptRob) collects the pooled bounty on top of their steal.
// Multiple people can stack bounties on the same target — pooled into one row.
//
// Table: bounties
//   target_id text primary key, total_amount bigint default 0,
//   placed_by jsonb default '[]',  -- [{ user_id, amount, placed_at }]
//   created_at timestamptz default now(), expires_at timestamptz

const BOUNTY_EXPIRY_DAYS = 3;
const BOUNTY_POST_FEE_PCT = 0.05; // 5% non-refundable posting fee

// ── Bounty debuffs ───────────────────────────────────────────────────────────
// Getting successfully collected on isn't just a Cash loss anymore — it's a
// stretch of being a marked target. Only kicks in once the bounty that got
// collected was actually worth something (small bounties stay Cash-only),
// and it scales in two tiers: a "Marked" tier for solid bounties, and a much
// nastier "Most Wanted" tier once the pooled bounty crosses 100M.
const MIN_BOUNTY_FOR_DEBUFF = 10_000_000;    // 10m minimum pooled bounty to trigger the debuffs at all
const MAJOR_BOUNTY_THRESHOLD = 100_000_000;  // 100m+ pooled bounty triggers the harsh "Most Wanted" tier
const DEBUFF_DURATION_MS = 60 * 60 * 1000;         // 1 hour — minor tier
const MAJOR_DEBUFF_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours — major tier
const WITHDRAWAL_LOCK_MS = 6 * 60 * 60 * 1000;       // 6 hours — major tier bank/gang vault lockout

const DEBUFF_TIERS = {
  minor: {
    label: "🎯 Marked",
    durationMs: DEBUFF_DURATION_MS,
    robBonus: 0.25,        // matches economy.MARKED_ROB_BONUS
    gangPct: 0.5,           // -50% gang business/turf income
    leaderOnly: true,       // only drags the gang down if the target IS the leader
    bankFreeze: false,
  },
  major: {
    label: "🚨 MOST WANTED",
    durationMs: MAJOR_DEBUFF_DURATION_MS,
    robBonus: 0.45,         // way easier to rob for 3 hours
    gangPct: 0.75,          // -75% gang business/turf income
    leaderOnly: false,      // even a regular member getting hit for 100M+ tanks the whole crew
    bankFreeze: true,        // target's bank vault earns zero interest for the duration
    withdrawLockMs: WITHDRAWAL_LOCK_MS, // target's bank AND their gang's treasury lock for 6h — no withdrawals
  },
};

// "Marked" — the target personally becomes an easier rob target for the
// debuff's duration (see economy.attemptRob's markedBonus param). Stores the
// rob-success bonus alongside the expiry so major-tier marks hit harder.
const markedUsers = new Map(); // userId -> { expiresAt, robBonus }
function markUser(userId, durationMs, robBonus = DEBUFF_TIERS.minor.robBonus) {
  const expiresAt = Date.now() + durationMs;
  markedUsers.set(userId, { expiresAt, robBonus });
  setTimeout(() => {
    const cur = markedUsers.get(userId);
    if (cur && cur.expiresAt === expiresAt) markedUsers.delete(userId);
  }, durationMs);
}
function isMarked(userId) {
  const m = markedUsers.get(userId);
  return !!m && m.expiresAt > Date.now();
}
function getMarkedRemainingMs(userId) {
  const m = markedUsers.get(userId);
  return m ? Math.max(0, m.expiresAt - Date.now()) : 0;
}
function getMarkedBonus(userId) {
  const m = markedUsers.get(userId);
  return (m && m.expiresAt > Date.now()) ? m.robBonus : 0;
}
function clearMark(userId) {
  return markedUsers.delete(userId);
}

// Picks the strongest tier the given pooled bounty amount qualifies for,
// or null if it's below the minimum for any debuff at all.
function getDebuffTier(bountyAmount) {
  if (bountyAmount >= MAJOR_BOUNTY_THRESHOLD) return DEBUFF_TIERS.major;
  if (bountyAmount >= MIN_BOUNTY_FOR_DEBUFF) return DEBUFF_TIERS.minor;
  return null;
}

let supabase;
function initBounties(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  console.log("🎯 Bounties system initialized");
}

async function getBounty(targetId) {
  const { data, error } = await supabase.from("bounties").select("*").eq("target_id", targetId).maybeSingle();
  if (error) { console.error("[BOUNTY GET]", error.message); return null; }
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null; // expired, treat as gone
  return data;
}

async function getAllActiveBounties() {
  const { data, error } = await supabase.from("bounties").select("*").order("total_amount", { ascending: false });
  if (error) { console.error("[BOUNTY LIST]", error.message); return []; }
  const now = Date.now();
  return (data || []).filter(b => new Date(b.expires_at).getTime() > now);
}

async function placeBounty(placerId, targetId, amount, deductFromWallet, addToTreasury, masterId) {
  if (placerId === targetId) return { success: false, reason: "You can't place a bounty on yourself." };
  if (amount <= 0) return { success: false, reason: "Bounty amount must be positive." };

  const deducted = await deductFromWallet(placerId, amount);
  if (!deducted) return { success: false, reason: "Insufficient funds." };

  const fee = Math.floor(amount * BOUNTY_POST_FEE_PCT);
  const pooled = amount - fee;
  if (fee > 0 && addToTreasury) await addToTreasury(masterId, fee); // posting fee -> Don's cut

  let existing = await getBounty(targetId);
  const entry = { user_id: placerId, amount: pooled, placed_at: new Date().toISOString() };

  if (existing) {
    const placedBy = [...(existing.placed_by || []), entry];
    const { data, error } = await supabase.from("bounties").update({
      total_amount: existing.total_amount + pooled,
      placed_by: placedBy,
      expires_at: new Date(Date.now() + BOUNTY_EXPIRY_DAYS * 86400000).toISOString(), // refresh expiry
    }).eq("target_id", targetId).select().maybeSingle();
    if (error) { console.error("[BOUNTY STACK]", error.message); return { success: false, reason: error.message }; }
    return { success: true, bounty: data, fee };
  }

  const { data, error } = await supabase.from("bounties").upsert({
    target_id: targetId,
    total_amount: pooled,
    placed_by: [entry],
    expires_at: new Date(Date.now() + BOUNTY_EXPIRY_DAYS * 86400000).toISOString(),
  }, { onConflict: "target_id" }).select().maybeSingle();
  if (error) { console.error("[BOUNTY PLACE]", error.message); return { success: false, reason: error.message }; }
  return { success: true, bounty: data, fee };
}

// Called from the rob flow on a SUCCESSFUL rob — pays the bounty to the robber and clears it.
async function collectBounty(targetId, collectorId, addCopper) {
  const bounty = await getBounty(targetId);
  if (!bounty || bounty.total_amount <= 0) return { collected: 0 };

  await addCopper(collectorId, bounty.total_amount);
  await supabase.from("bounties").delete().eq("target_id", targetId);

  let marked = false;
  let major = false;
  let gangDebuffed = false;
  let gangName = null;
  let bankFrozen = false;
  let bankWithdrawLocked = false;
  let gangWithdrawLocked = false;

  // Debuffs only trigger once the collected bounty was actually worth
  // something — small bounties stay a pure Cash payout, no downside for
  // the target beyond losing the pool. Bounties of 100M+ escalate into the
  // much harsher "Most Wanted" tier.
  const tier = getDebuffTier(bounty.total_amount);
  if (tier) {
    markUser(targetId, tier.durationMs, tier.robBonus);
    marked = true;
    major = tier === DEBUFF_TIERS.major;

    // Minor tier only drags the gang down if the target IS the leader.
    // Major tier ("Most Wanted") hits the gang even off a regular member —
    // a 100M+ bounty landing on anyone in the crew is bad enough news.
    try {
      const ug = await gangs.getUserGang(targetId);
      if (ug && (ug.membership.role === "leader" || !tier.leaderOnly)) {
        businesses.applyGangDebuff(ug.gang.id, tier.durationMs, tier.gangPct);
        turf.applyGangDebuff(ug.gang.id, tier.durationMs, tier.gangPct);
        gangDebuffed = true;
        gangName = ug.gang.name;
      }
    } catch (e) {
      console.error("[BOUNTY GANG DEBUFF]", e.message);
    }

    // Major tier only: their bank vault stops earning interest AND locks
    // out withdrawals entirely for 6 hours — deposits still work, but
    // nothing comes back out.
    if (tier.bankFreeze) {
      try {
        bank.applyInterestFreeze(targetId, tier.durationMs);
        bankFrozen = true;
      } catch (e) {
        console.error("[BOUNTY BANK FREEZE]", e.message);
      }
    }
    if (tier.withdrawLockMs) {
      try {
        bank.applyWithdrawLock(targetId, tier.withdrawLockMs);
        bankWithdrawLocked = true;
        // If they're in a gang, the gang's treasury locks too — the whole
        // crew's Cash is frozen right along with their own.
        const ugForLock = await gangs.getUserGang(targetId);
        if (ugForLock) {
          gangs.applyTreasuryWithdrawLock(ugForLock.gang.id, tier.withdrawLockMs);
          gangWithdrawLocked = true;
        }
      } catch (e) {
        console.error("[BOUNTY WITHDRAW LOCK]", e.message);
      }
    }
  }

  return {
    collected: bounty.total_amount, placedBy: bounty.placed_by,
    marked, major, gangDebuffed, gangName, bankFrozen, bankWithdrawLocked, gangWithdrawLocked,
    tierLabel: tier ? tier.label : null, durationMs: tier ? tier.durationMs : 0,
    withdrawLockMs: tier ? (tier.withdrawLockMs || 0) : 0,
  };
}

// Refunds expired bounties (call this on a daily tick, mirrors bank.runDailyBankProcessing).
async function refundExpiredBounties(addCopper) {
  const { data, error } = await supabase.from("bounties").select("*");
  if (error) { console.error("[BOUNTY EXPIRE CHECK]", error.message); return; }
  const now = Date.now();
  let refunded = 0;
  for (const b of data || []) {
    if (new Date(b.expires_at).getTime() >= now) continue;
    for (const entry of b.placed_by || []) {
      await addCopper(entry.user_id, entry.amount);
    }
    await supabase.from("bounties").delete().eq("target_id", b.target_id);
    refunded++;
  }
  if (refunded > 0) console.log("[BOUNTY] Refunded " + refunded + " expired bounties");
}

function formatBountyBoard(bounties) {
  if (bounties.length === 0) return "🎯 *No active bounties right now.*";
  return bounties.slice(0, 10).map((b, i) =>
    `**#${i + 1}** <@${b.target_id}> — 💵 ${fmt(b.total_amount)} Cash (${(b.placed_by || []).length} contributor${(b.placed_by || []).length === 1 ? "" : "s"})`
  ).join("\n");
}

module.exports = {
  initBounties, getBounty, getAllActiveBounties, placeBounty, collectBounty,
  refundExpiredBounties, formatBountyBoard, BOUNTY_EXPIRY_DAYS,
  isMarked, getMarkedRemainingMs, getMarkedBonus, getDebuffTier, clearMark,
  MIN_BOUNTY_FOR_DEBUFF, DEBUFF_DURATION_MS,
  MAJOR_BOUNTY_THRESHOLD, MAJOR_DEBUFF_DURATION_MS, WITHDRAWAL_LOCK_MS, DEBUFF_TIERS,
};
