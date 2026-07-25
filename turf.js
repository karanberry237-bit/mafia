const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { fmt } = require("./economy");
const gangs = require("./gangs");

// ── Turf Wars ──────────────────────────────────────────────────────────────
// A fixed set of named zones. Controlled by a GANG (not an individual).
// Unclaimed turf can just be claimed. Claimed turf must be attacked, and
// defenders get a home-field edge. Controlled turf pays the gang treasury on
// the daily tick. Inactive control auto-releases after a set number of days.
//
// Table: turf_zones
//   name text primary key, tier int,  -- higher tier = more valuable/contested
//   controller_gang_id uuid references gangs(id) on delete set null,
//   claimed_at timestamptz, last_income_at timestamptz, last_attacked_at timestamptz

const ZONES = [
  { name: "The Docks",      tier: 1, income: 30_000,  claimCost: 60_000 },
  { name: "Little Italy",   tier: 1, income: 35_000,  claimCost: 70_000 },
  { name: "Chinatown",      tier: 2, income: 60_000,  claimCost: 130_000 },
  { name: "The Strip",      tier: 2, income: 65_000,  claimCost: 140_000 },
  { name: "Uptown",         tier: 3, income: 110_000, claimCost: 250_000 },
  { name: "The Warehouse District", tier: 3, income: 120_000, claimCost: 260_000 },
  { name: "Financial District", tier: 4, income: 200_000, claimCost: 450_000 },
  { name: "The Boardwalk",  tier: 4, income: 220_000, claimCost: 480_000 },
];

const ATTACK_COOLDOWN_HOURS = 6;
const INACTIVITY_RELEASE_DAYS = 7;
const DEFENDER_EDGE = 0.15; // flat % edge for the defending gang
const ATTACK_BASE_CHANCE = 0.45;

let supabase;
function initTurf(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  console.log("🗺️ Turf Wars system initialized");
}

function getZoneDef(name) {
  return ZONES.find(z => z.name.toLowerCase() === name.toLowerCase()) || null;
}

async function ensureZonesSeeded() {
  for (const z of ZONES) {
    await supabase.from("turf_zones").upsert(
      { name: z.name, tier: z.tier, controller_gang_id: null, claimed_at: null, last_income_at: new Date().toISOString(), last_attacked_at: null },
      { onConflict: "name", ignoreDuplicates: true }
    );
  }
}

async function getZone(name) {
  const { data, error } = await supabase.from("turf_zones").select("*").ilike("name", name).maybeSingle();
  if (error) { console.error("[TURF GET]", error.message); return null; }
  return data;
}

async function getAllZones() {
  const { data, error } = await supabase.from("turf_zones").select("*").order("tier", { ascending: true });
  if (error) { console.error("[TURF LIST]", error.message); return []; }
  return data || [];
}

async function claimZone(userId, zoneName) {
  const zoneDef = getZoneDef(zoneName);
  if (!zoneDef) return { success: false, reason: "Unknown zone. Use **/turf list** to see zones." };

  const userGang = await gangs.getUserGang(userId);
  if (!userGang) return { success: false, reason: "You need to be in a gang to claim turf." };
  if (userGang.membership.role === "member") return { success: false, reason: "Only leaders/officers can claim turf on behalf of the gang." };

  const zone = await getZone(zoneDef.name);
  if (!zone) return { success: false, reason: "Zone not found — ask an admin to run turf setup." };
  if (zone.controller_gang_id) return { success: false, reason: `**${zone.name}** is already controlled. Use **/turf attack** instead.` };

  const deducted = await gangs.deductFromGangTreasury(userGang.gang.id, zoneDef.claimCost);
  if (!deducted) return { success: false, reason: `Gang treasury needs **${fmt(zoneDef.claimCost)}** to claim this zone.` };

  const { error } = await supabase.from("turf_zones").update({
    controller_gang_id: userGang.gang.id,
    claimed_at: new Date().toISOString(),
    last_income_at: new Date().toISOString(),
  }).eq("name", zone.name);
  if (error) { console.error("[TURF CLAIM]", error.message); return { success: false, reason: error.message }; }

  return { success: true, zone: zoneDef, gang: userGang.gang };
}

function attackCooldownKey(gangId, zoneName) { return gangId + ":" + zoneName; }
const attackCooldowns = new Map();

function getAttackCooldownRemaining(gangId, zoneName) {
  const last = attackCooldowns.get(attackCooldownKey(gangId, zoneName));
  if (!last) return 0;
  const elapsedHours = (Date.now() - last) / (1000 * 60 * 60);
  return Math.max(0, ATTACK_COOLDOWN_HOURS - elapsedHours);
}

async function attackZone(userId, zoneName) {
  const zoneDef = getZoneDef(zoneName);
  if (!zoneDef) return { success: false, reason: "Unknown zone." };

  const attackerGang = await gangs.getUserGang(userId);
  if (!attackerGang) return { success: false, reason: "You need to be in a gang to attack turf." };
  if (attackerGang.membership.role === "member") return { success: false, reason: "Only leaders/officers can lead an attack." };

  const zone = await getZone(zoneDef.name);
  if (!zone) return { success: false, reason: "Zone not found." };
  if (!zone.controller_gang_id) return { success: false, reason: `**${zone.name}** is unclaimed — use **/turf claim** instead.` };
  if (zone.controller_gang_id === attackerGang.gang.id) return { success: false, reason: "You already control this zone." };

  const remaining = getAttackCooldownRemaining(attackerGang.gang.id, zone.name);
  if (remaining > 0) return { success: false, reason: `Still regrouping. Attack again in ${remaining.toFixed(1)}h.` };

  attackCooldowns.set(attackCooldownKey(attackerGang.gang.id, zone.name), Date.now());

  const defenderGang = await gangs.getGangById(zone.controller_gang_id);
  const successChance = Math.max(0.1, ATTACK_BASE_CHANCE - DEFENDER_EDGE);
  const won = Math.random() < successChance;

  if (won) {
    const { error } = await supabase.from("turf_zones").update({
      controller_gang_id: attackerGang.gang.id,
      claimed_at: new Date().toISOString(),
      last_income_at: new Date().toISOString(),
      last_attacked_at: new Date().toISOString(),
    }).eq("name", zone.name);
    if (error) console.error("[TURF ATTACK WIN]", error.message);
  } else {
    await supabase.from("turf_zones").update({ last_attacked_at: new Date().toISOString() }).eq("name", zone.name);
  }

  return { success: true, won, zone: zoneDef, attackerGang: attackerGang.gang, defenderGang };
}

// ── Daily processing: pay income to controllers, release inactive turf ─────
async function runDailyTurfProcessing() {
  const zones = await getAllZones();
  const now = Date.now();
  let paid = 0, released = 0;

  for (const zone of zones) {
    if (!zone.controller_gang_id) continue;

    const lastIncome = zone.last_income_at ? new Date(zone.last_income_at).getTime() : 0;
    const hoursSince = (now - lastIncome) / (1000 * 60 * 60);
    if (hoursSince < 24) continue;

    const zoneDef = getZoneDef(zone.name);
    if (!zoneDef) continue;

    // Inactivity release: no claim/attack activity on this zone for X days -> release
    const lastActivity = Math.max(
      zone.claimed_at ? new Date(zone.claimed_at).getTime() : 0,
      zone.last_attacked_at ? new Date(zone.last_attacked_at).getTime() : 0
    );
    const daysSinceActivity = (now - lastActivity) / (1000 * 60 * 60 * 24);
    if (daysSinceActivity >= INACTIVITY_RELEASE_DAYS) {
      await supabase.from("turf_zones").update({ controller_gang_id: null, claimed_at: null }).eq("name", zone.name);
      released++;
      continue;
    }

    await gangs.addToGangTreasury(zone.controller_gang_id, zoneDef.income);
    await supabase.from("turf_zones").update({ last_income_at: new Date().toISOString() }).eq("name", zone.name);
    paid++;
  }
  console.log(`[TURF] Daily processing complete — paid ${paid}, released ${released}`);
}

function formatZoneList(zones) {
  return zones.map(z => {
    const def = getZoneDef(z.name);
    const status = z.controller_gang_id ? `🏴 controlled` : "🏳️ unclaimed";
    return `**${z.name}** (Tier ${z.tier}) — ${status} | 💵 ${fmt(def.income)}/day | claim: ${fmt(def.claimCost)}`;
  }).join("\n");
}

module.exports = {
  initTurf, ZONES, ensureZonesSeeded, getZoneDef, getZone, getAllZones,
  claimZone, attackZone, getAttackCooldownRemaining, runDailyTurfProcessing, formatZoneList,
  ATTACK_COOLDOWN_HOURS, INACTIVITY_RELEASE_DAYS,
};
