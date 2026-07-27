const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const turf = require("./turf");
const gangs = require("./gangs");

// ── Rival NPC Family — The Barzinis ─────────────────────────────────────────
// A passive AI faction that occasionally muscles in on turf without any
// player controlling it. Seeded as a REAL row in the gangs table (so it can
// legitimately hold turf_zones.controller_gang_id, and players can attack it
// with the existing turf.attackZone flow — no special-casing needed there),
// but with a sentinel leader_id that can never match a real Discord user, so
// nobody can join it, lead it, or withdraw its treasury. It can also show up
// in gang rankings (including the Commission) like any other gang — a rival
// family occasionally contesting a Commission seat is a feature, not a bug.

const BARZINI_NAME = "The Barzinis";
const BARZINI_LEADER_ID = "NPC_BARZINI"; // sentinel — not a valid Discord snowflake, can never be a real user
const RAID_CHANCE_UNCLAIMED = 0.15;      // per unclaimed zone, per daily check
const RAID_CHANCE_WEAK_HOLD = 0.08;      // extra chance to muscle in on a player-held zone that looks undefended
const WEAK_HOLD_INACTIVITY_DAYS = 3;     // "undefended" = no claim/attack activity in this many days

let supabase;
function initRivalNpc(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  console.log("🕶️ Rival NPC Family (the Barzinis) initialized");
}

async function ensureBarzinisExist() {
  let barzinis = await gangs.getGangByName(BARZINI_NAME);
  if (!barzinis) {
    const { data, error } = await supabase.from("gangs").insert({ name: BARZINI_NAME, leader_id: BARZINI_LEADER_ID, treasury: 0 }).select().maybeSingle();
    if (error) { console.error("[BARZINI SEED]", error.message); return null; }
    barzinis = data;
    console.log("🕶️ The Barzinis have entered the city.");
  }
  return barzinis;
}

// Call this on the same daily cadence as turf.runDailyTurfProcessing(). Rolls
// a chance per unclaimed zone for the Barzinis to quietly move in, and a
// smaller chance per player-held zone that's seen no claim/attack activity
// in a while to get muscled in on instead. Covers every guild's zones in one
// pass (each row carries its own guild_id) and groups the flavor-text events
// by guild, calling announceFn(guildId, text) once per guild that had any
// activity — so each server's raid report goes to that server's own channel
// instead of one combined message landing in just one place.
async function runRivalRaids(announceFn) {
  const barzinis = await ensureBarzinisExist();
  if (!barzinis) return {};

  const zones = await turf.getAllZones();
  const eventsByGuild = {};
  const addEvent = (guildId, text) => {
    if (!eventsByGuild[guildId]) eventsByGuild[guildId] = [];
    eventsByGuild[guildId].push(text);
  };

  for (const zone of zones) {
    if (zone.controller_gang_id === barzinis.id) continue; // already theirs

    if (!zone.controller_gang_id) {
      if (Math.random() < RAID_CHANCE_UNCLAIMED) {
        await supabase.from("turf_zones").update({
          controller_gang_id: barzinis.id,
          claimed_at: new Date().toISOString(),
          last_income_at: new Date().toISOString(),
        }).eq("guild_id", zone.guild_id).eq("name", zone.name);
        addEvent(zone.guild_id, `🕶️ **The Barzinis** quietly moved into unclaimed **${zone.name}**.`);
      }
      continue;
    }

    const lastActivity = Math.max(
      zone.claimed_at ? new Date(zone.claimed_at).getTime() : 0,
      zone.last_attacked_at ? new Date(zone.last_attacked_at).getTime() : 0
    );
    const daysSinceActivity = (Date.now() - lastActivity) / 86400000;
    if (daysSinceActivity >= WEAK_HOLD_INACTIVITY_DAYS && Math.random() < RAID_CHANCE_WEAK_HOLD) {
      const previousGang = await gangs.getGangById(zone.controller_gang_id);
      await supabase.from("turf_zones").update({
        controller_gang_id: barzinis.id,
        claimed_at: new Date().toISOString(),
        last_income_at: new Date().toISOString(),
        last_attacked_at: new Date().toISOString(),
      }).eq("guild_id", zone.guild_id).eq("name", zone.name);
      addEvent(zone.guild_id, `🕶️ **The Barzinis** moved on **${zone.name}** while ${previousGang ? `**${previousGang.name}**` : "its owners"} weren't watching.`);
    }
  }

  if (typeof announceFn === "function") {
    for (const [guildId, events] of Object.entries(eventsByGuild)) {
      if (events.length) await announceFn(guildId, events.join("\n")).catch(() => {});
    }
  }
  return eventsByGuild;
}

module.exports = { initRivalNpc, ensureBarzinisExist, runRivalRaids, BARZINI_NAME, BARZINI_LEADER_ID };
