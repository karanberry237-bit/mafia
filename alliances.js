const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const gangs = require("./gangs");

// ── Alliances (between gangs) ─────────────────────────────────────────────
// Allied gangs cannot attack each other's turf and share a small vault
// interest bonus. Alliances can be broken, with a cooldown before either
// gang can re-ally the same partner (discourages alliance-flip abuse).
//
// Table: alliances
//   id uuid default gen_random_uuid() primary key,
//   gang_a_id uuid references gangs(id) on delete cascade,
//   gang_b_id uuid references gangs(id) on delete cascade,
//   status text default 'pending',  -- 'pending' | 'active' | 'broken'
//   created_at timestamptz default now(), broken_at timestamptz
//   UNIQUE (gang_a_id, gang_b_id)   -- store consistently with gang_a_id < gang_b_id

const REALLY_COOLDOWN_DAYS = 3;
const ALLIANCE_INTEREST_BONUS = 0.005; // +0.5% vault interest rate while allied

let supabase;
function initAlliances(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  console.log("🤝 Alliances system initialized");
}

function orderIds(a, b) { return a < b ? [a, b] : [b, a]; }

async function getAllianceBetween(gangIdA, gangIdB) {
  const [a, b] = orderIds(gangIdA, gangIdB);
  const { data, error } = await supabase.from("alliances").select("*").eq("gang_a_id", a).eq("gang_b_id", b).maybeSingle();
  if (error) { console.error("[ALLIANCE GET]", error.message); return null; }
  return data;
}

async function getActiveAlliancesForGang(gangId) {
  const { data, error } = await supabase.from("alliances").select("*").or(`gang_a_id.eq.${gangId},gang_b_id.eq.${gangId}`).eq("status", "active");
  if (error) { console.error("[ALLIANCE LIST]", error.message); return []; }
  return data || [];
}

async function areAllied(gangIdA, gangIdB) {
  const alliance = await getAllianceBetween(gangIdA, gangIdB);
  return !!alliance && alliance.status === "active";
}

// In-memory pending proposals, mirrors gang invite pattern (expire after 1h)
const pendingProposals = new Map(); // targetGangId -> { fromGangId, fromGangName, proposedBy, createdAt }
function proposalKey(targetGangId) { return targetGangId; }

async function proposeAlliance(actorId, targetGangName) {
  const actorGang = await gangs.getUserGang(actorId);
  if (!actorGang) return { success: false, reason: "You're not in a gang." };
  if (actorGang.membership.role !== "leader") return { success: false, reason: "Only the gang leader can propose alliances." };

  const targetGang = await gangs.getGangByName(targetGangName);
  if (!targetGang) return { success: false, reason: "Gang not found." };
  if (targetGang.id === actorGang.gang.id) return { success: false, reason: "Can't ally with your own gang." };

  const existing = await getAllianceBetween(actorGang.gang.id, targetGang.id);
  if (existing && existing.status === "active") return { success: false, reason: "You're already allied with that gang." };
  if (existing && existing.status === "broken" && existing.broken_at) {
    const daysSince = (Date.now() - new Date(existing.broken_at).getTime()) / 86400000;
    if (daysSince < REALLY_COOLDOWN_DAYS) return { success: false, reason: `You broke this alliance recently — can re-ally in ${(REALLY_COOLDOWN_DAYS - daysSince).toFixed(1)}d.` };
  }

  pendingProposals.set(proposalKey(targetGang.id), { fromGangId: actorGang.gang.id, fromGangName: actorGang.gang.name, proposedBy: actorId, createdAt: Date.now() });
  setTimeout(() => { pendingProposals.delete(targetGang.id); }, 60 * 60000);

  return { success: true, targetGang, actorGang: actorGang.gang };
}

async function acceptAlliance(actorId) {
  const actorGang = await gangs.getUserGang(actorId);
  if (!actorGang) return { success: false, reason: "You're not in a gang." };
  if (actorGang.membership.role !== "leader") return { success: false, reason: "Only the gang leader can accept alliances." };

  const proposal = pendingProposals.get(actorGang.gang.id);
  if (!proposal) return { success: false, reason: "No pending alliance proposal for your gang." };

  const [a, b] = orderIds(proposal.fromGangId, actorGang.gang.id);
  const { data, error } = await supabase.from("alliances").upsert(
    { gang_a_id: a, gang_b_id: b, status: "active", broken_at: null },
    { onConflict: "gang_a_id,gang_b_id" }
  ).select().maybeSingle();
  if (error) { console.error("[ALLIANCE ACCEPT]", error.message); return { success: false, reason: error.message }; }

  pendingProposals.delete(actorGang.gang.id);
  return { success: true, alliance: data, fromGangName: proposal.fromGangName };
}

async function breakAlliance(actorId, targetGangName) {
  const actorGang = await gangs.getUserGang(actorId);
  if (!actorGang) return { success: false, reason: "You're not in a gang." };
  if (actorGang.membership.role !== "leader") return { success: false, reason: "Only the gang leader can break alliances." };

  const targetGang = await gangs.getGangByName(targetGangName);
  if (!targetGang) return { success: false, reason: "Gang not found." };

  const [a, b] = orderIds(actorGang.gang.id, targetGang.id);
  const { error } = await supabase.from("alliances").update({ status: "broken", broken_at: new Date().toISOString() }).eq("gang_a_id", a).eq("gang_b_id", b);
  if (error) { console.error("[ALLIANCE BREAK]", error.message); return { success: false, reason: error.message }; }
  return { success: true, targetGang };
}

// Extra vault interest rate to apply while a gang has 1+ active alliances (call from bank.processBank)
async function getAllianceInterestBonus(userId) {
  const userGang = await gangs.getUserGang(userId);
  if (!userGang) return 0;
  const active = await getActiveAlliancesForGang(userGang.gang.id);
  return active.length > 0 ? ALLIANCE_INTEREST_BONUS : 0;
}

module.exports = {
  initAlliances, proposeAlliance, acceptAlliance, breakAlliance,
  getAllianceBetween, getActiveAlliancesForGang, areAllied, getAllianceInterestBonus,
  REALLY_COOLDOWN_DAYS, ALLIANCE_INTEREST_BONUS,
};
