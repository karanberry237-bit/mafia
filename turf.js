const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { fmt } = require("./economy");
const gangs = require("./gangs");

// ── Turf Wars ──────────────────────────────────────────────────────────────
// A fixed set of named zones, PER DISCORD SERVER. Controlled by a GANG (not
// an individual). Unclaimed turf can just be claimed. Claimed turf must be
// attacked, and defenders get a home-field edge. Controlled turf pays the
// gang treasury on the daily tick. Inactive control auto-releases after a
// set number of days.
//
// Table: turf_zones
//   guild_id text, name text, tier int,  -- higher tier = more valuable/contested
//   controller_gang_id uuid references gangs(id) on delete set null,
//   claimed_at timestamptz, last_income_at timestamptz, last_attacked_at timestamptz
//   PRIMARY KEY (guild_id, name)
//
// ⚠️ MIGRATION NEEDED if you're upgrading from the old global (non-guild-
// scoped) version of this file — every Discord server the bot was in was
// sharing the exact same 8 zones, so gangs from completely unrelated servers
// were fighting over (and stealing) each other's turf without either server
// even being aware the other existed. Since the zone list is also changing
// (2 new zones, 4x income), just wipe and let the bot reseed fresh:
//   truncate table turf_zones;
//   alter table turf_zones drop constraint if exists turf_zones_pkey;
//   alter table turf_zones add column if not exists guild_id text;
//   alter table turf_zones add primary key (guild_id, name);

const ZONES = [
  { name: "The Docks",              tier: 1, income: 120_000,   claimCost: 60_000 },
  { name: "Little Italy",           tier: 1, income: 140_000,   claimCost: 70_000 },
  { name: "Chinatown",              tier: 2, income: 240_000,   claimCost: 130_000 },
  { name: "The Strip",              tier: 2, income: 260_000,   claimCost: 140_000 },
  { name: "Uptown",                 tier: 3, income: 440_000,   claimCost: 250_000 },
  { name: "The Warehouse District", tier: 3, income: 480_000,   claimCost: 260_000 },
  { name: "Financial District",     tier: 4, income: 800_000,   claimCost: 450_000 },
  { name: "The Boardwalk",          tier: 4, income: 880_000,   claimCost: 480_000 },
  { name: "The Velvet Lounge",      tier: 5, income: 1_300_000, claimCost: 750_000 },
  { name: "The Airport",            tier: 6, income: 2_000_000, claimCost: 1_200_000 },
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

// ── Gang debuff ──────────────────────────────────────────────────────────────
// Set by bounties.collectBounty when a big enough bounty gets collected on a
// GANG LEADER — knocks the gang's turf income down for the debuff's
// duration. Applied at daily-payout time, same as businesses.js's version.
const GANG_TURF_DEBUFF_PCT = 0.5; // -50% turf income while debuffed (default/minor tier)
const gangTurfDebuffs = new Map(); // gangId -> { expiresAt, pct }
function applyGangDebuff(gangId, durationMs, pct = GANG_TURF_DEBUFF_PCT) {
  gangTurfDebuffs.set(gangId, { expiresAt: Date.now() + durationMs, pct });
}
function isGangDebuffed(gangId) {
  const d = gangTurfDebuffs.get(gangId);
  return !!d && d.expiresAt > Date.now();
}
function getGangDebuffPct(gangId) {
  const d = gangTurfDebuffs.get(gangId);
  return (d && d.expiresAt > Date.now()) ? d.pct : 0;
}

function getZoneDef(name) {
  return ZONES.find(z => z.name.toLowerCase() === name.toLowerCase()) || null;
}

// Seeds every zone for ONE specific guild. Called once per guild the bot is
// in (at boot, and whenever it joins a new server) — every server gets its
// own independent set of zones instead of one shared global set.
async function ensureZonesSeeded(guildId) {
  for (const z of ZONES) {
    await supabase.from("turf_zones").upsert(
      { guild_id: guildId, name: z.name, tier: z.tier, controller_gang_id: null, claimed_at: null, last_income_at: new Date().toISOString(), last_attacked_at: null },
      { onConflict: "guild_id,name", ignoreDuplicates: true }
    );
  }
}

async function getZone(guildId, name) {
  const { data, error } = await supabase.from("turf_zones").select("*").eq("guild_id", guildId).ilike("name", name).maybeSingle();
  if (error) { console.error("[TURF GET]", error.message); return null; }
  return data;
}

// Pass a guildId to get just that server's zones (normal usage everywhere).
// Omit it only for cross-server aggregates (e.g. Commission ranking a gang's
// total turf held across every server it's active in).
async function getAllZones(guildId) {
  let q = supabase.from("turf_zones").select("*").order("tier", { ascending: true });
  if (guildId) q = q.eq("guild_id", guildId);
  const { data, error } = await q;
  if (error) { console.error("[TURF LIST]", error.message); return []; }
  return data || [];
}

async function claimZone(userId, guildId, zoneName) {
  const zoneDef = getZoneDef(zoneName);
  if (!zoneDef) return { success: false, reason: "Unknown zone. Use **Cosa turf list** to see zones." };

  const userGang = await gangs.getUserGang(userId);
  if (!userGang) return { success: false, reason: "You need to be in a gang to claim turf." };
  if (userGang.membership.role === "member") return { success: false, reason: "Only leaders/officers can claim turf on behalf of the gang." };

  const zone = await getZone(guildId, zoneDef.name);
  if (!zone) return { success: false, reason: "Zone not found — ask an admin to run turf setup." };
  if (zone.controller_gang_id) return { success: false, reason: `**${zone.name}** is already controlled. Use **Cosa turf attack** instead.` };

  const deducted = await gangs.deductFromGangTreasury(userGang.gang.id, zoneDef.claimCost);
  if (!deducted) return { success: false, reason: `Gang treasury needs **${fmt(zoneDef.claimCost)}** to claim this zone.` };

  const { error } = await supabase.from("turf_zones").update({
    controller_gang_id: userGang.gang.id,
    claimed_at: new Date().toISOString(),
    last_income_at: new Date().toISOString(),
  }).eq("guild_id", guildId).eq("name", zone.name);
  if (error) { console.error("[TURF CLAIM]", error.message); return { success: false, reason: error.message }; }

  return { success: true, zone: zoneDef, gang: userGang.gang };
}

function attackCooldownKey(gangId, guildId, zoneName) { return gangId + ":" + guildId + ":" + zoneName; }
const attackCooldowns = new Map();

function getAttackCooldownRemaining(gangId, guildId, zoneName) {
  const last = attackCooldowns.get(attackCooldownKey(gangId, guildId, zoneName));
  if (!last) return 0;
  const elapsedHours = (Date.now() - last) / (1000 * 60 * 60);
  return Math.max(0, ATTACK_COOLDOWN_HOURS - elapsedHours);
}

// Clears a gang's attack cooldown on one specific zone — used by the Don's
// "skip cooldown?" button prompt.
function clearAttackCooldown(gangId, guildId, zoneName) {
  attackCooldowns.delete(attackCooldownKey(gangId, guildId, zoneName));
}

// bonusChance: flat addition to success chance, e.g. for a Don-led attack
// getting a personal edge on top of the normal odds.
async function attackZone(userId, guildId, zoneName, bonusChance = 0) {
  const zoneDef = getZoneDef(zoneName);
  if (!zoneDef) return { success: false, reason: "Unknown zone." };

  const attackerGang = await gangs.getUserGang(userId);
  if (!attackerGang) return { success: false, reason: "You need to be in a gang to attack turf." };
  if (attackerGang.membership.role === "member") return { success: false, reason: "Only leaders/officers can lead an attack." };

  const zone = await getZone(guildId, zoneDef.name);
  if (!zone) return { success: false, reason: "Zone not found." };
  if (!zone.controller_gang_id) return { success: false, reason: `**${zone.name}** is unclaimed — use **Cosa turf claim** instead.` };
  if (zone.controller_gang_id === attackerGang.gang.id) return { success: false, reason: "You already control this zone." };

  const remaining = getAttackCooldownRemaining(attackerGang.gang.id, guildId, zone.name);
  if (remaining > 0) return { success: false, reason: `Still regrouping. Attack again in ${remaining.toFixed(1)}h.`, cooldownBlocked: true, remaining, gangId: attackerGang.gang.id };

  attackCooldowns.set(attackCooldownKey(attackerGang.gang.id, guildId, zone.name), Date.now());

  const defenderGang = await gangs.getGangById(zone.controller_gang_id);
  const successChance = Math.max(0.1, Math.min(0.95, ATTACK_BASE_CHANCE - DEFENDER_EDGE + bonusChance));
  const won = Math.random() < successChance;

  if (won) {
    const { error } = await supabase.from("turf_zones").update({
      controller_gang_id: attackerGang.gang.id,
      claimed_at: new Date().toISOString(),
      last_income_at: new Date().toISOString(),
      last_attacked_at: new Date().toISOString(),
    }).eq("guild_id", guildId).eq("name", zone.name);
    if (error) console.error("[TURF ATTACK WIN]", error.message);
  } else {
    await supabase.from("turf_zones").update({ last_attacked_at: new Date().toISOString() }).eq("guild_id", guildId).eq("name", zone.name);
  }

  return { success: true, won, zone: zoneDef, attackerGang: attackerGang.gang, defenderGang };
}

// ── Daily processing: pay income to controllers, release inactive turf ─────
// Runs across EVERY guild's zones in one pass — no guildId filter needed
// here since every row already carries its own guild_id and is handled
// independently regardless of which server it belongs to.
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
      await supabase.from("turf_zones").update({ controller_gang_id: null, claimed_at: null }).eq("guild_id", zone.guild_id).eq("name", zone.name);
      released++;
      continue;
    }

    await gangs.addToGangTreasury(zone.controller_gang_id, isGangDebuffed(zone.controller_gang_id) ? Math.floor(zoneDef.income * (1 - getGangDebuffPct(zone.controller_gang_id))) : zoneDef.income);
    await supabase.from("turf_zones").update({ last_income_at: new Date().toISOString() }).eq("guild_id", zone.guild_id).eq("name", zone.name);
    paid++;
  }
  console.log(`[TURF] Daily processing complete — paid ${paid}, released ${released}`);
}

async function formatZoneList(zones) {
  const lines = [];
  for (const z of zones) {
    const def = getZoneDef(z.name);
    let status = "🏳️ unclaimed";
    if (z.controller_gang_id) {
      const controller = await gangs.getGangById(z.controller_gang_id);
      status = controller ? `${gangs.getGangFlag(controller.id)} **${controller.name}**` : "🏴 controlled";
    }
    lines.push(`**${z.name}** (Tier ${z.tier}) — ${status} | 💵 ${fmt(def.income)}/day | claim: ${fmt(def.claimCost)}`);
  }
  return lines.join("\n");
}

module.exports = {
  initTurf, ZONES, ensureZonesSeeded, getZoneDef, getZone, getAllZones,
  claimZone, attackZone, getAttackCooldownRemaining, clearAttackCooldown, runDailyTurfProcessing, formatZoneList,
  ATTACK_COOLDOWN_HOURS, INACTIVITY_RELEASE_DAYS,
  applyGangDebuff, isGangDebuffed, getGangDebuffPct,
};
