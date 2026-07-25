const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { fmt } = require("./economy");

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
  return { collected: bounty.total_amount, placedBy: bounty.placed_by };
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
};
