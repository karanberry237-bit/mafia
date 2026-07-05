// ═══════════════════════════════════════════════════════════════════════════════
// leaderboard.js — Family Rankings Leaderboard (#1-#10, single message, editable)
// Guild-scoped: every entry, rank slot, and posted message is per-Discord-server.
// ═══════════════════════════════════════════════════════════════════════════════
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { EmbedBuilder } = require("discord.js");

let supabase;
let discordClient;
let MASTER_ID;
let BLOXLINK_API_KEY;
let BLOXLINK_GUILD_ID;

const MAX_RANKS = 10;

// Table: family_leaderboard
//   guild_id text, rank int, discord_id text, region text, country_emoji text,
//   stage text, roblox_id text, roblox_username text, avatar_url text, updated_at timestamptz
//   PRIMARY KEY (guild_id, rank)
//
// Table: empire_data (already exists in your project) is reused to store each
// guild's posted message's channel_id + message_id under key "leaderboard_message_<guildId>".

function initLeaderboard({ masterId, supabaseUrl, supabaseKey, clientRef, bloxlinkApiKey, bloxlinkGuildId }) {
  MASTER_ID = masterId;
  discordClient = clientRef;
  BLOXLINK_API_KEY = bloxlinkApiKey;
  BLOXLINK_GUILD_ID = bloxlinkGuildId;
  supabase = createClient(supabaseUrl, supabaseKey, { realtime: { transport: ws } });
  console.log("🏆 Leaderboard system initialized");
}

function requireGuildId(guildId) {
  if (!guildId) throw new Error("guildId is required for leaderboard operations (leaderboard is per-server).");
  return guildId;
}

// ── Roblox / Bloxlink lookup ──────────────────────────────────────────────────
async function resolveRoblox(discordId) {
  if (!BLOXLINK_API_KEY || !BLOXLINK_GUILD_ID) return null;
  try {
    const res = await fetch(
      `https://api.blox.link/v4/public/guilds/${BLOXLINK_GUILD_ID}/discord-to-roblox/${discordId}`,
      { headers: { Authorization: BLOXLINK_API_KEY } }
    );
    const data = await res.json();
    if (!data || !data.robloxID) return null;

    const robloxId = data.robloxID;

    // Username
    let username = null;
    try {
      const uRes = await fetch(`https://users.roblox.com/v1/users/${robloxId}`);
      const uData = await uRes.json();
      username = uData?.name || null;
    } catch (e) { console.error("[LEADERBOARD ROBLOX USERNAME]", e.message); }

    // Avatar headshot
    let avatarUrl = null;
    try {
      const aRes = await fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`
      );
      const aData = await aRes.json();
      avatarUrl = aData?.data?.[0]?.imageUrl || null;
    } catch (e) { console.error("[LEADERBOARD ROBLOX AVATAR]", e.message); }

    return { robloxId, username, avatarUrl };
  } catch (e) {
    console.error("[LEADERBOARD BLOXLINK]", e.message);
    return null;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
// NOTE: every function below checks `error` explicitly. supabase-js v2 does NOT
// throw on query failures — it resolves with { data, error }. A try/catch around
// a supabase call will basically never catch a bad query; it only catches genuine
// JS/network exceptions. That silent-failure gap was the root cause of "set says
// success but the row never actually saved" — upsert/select errors (missing table,
// RLS block, bad onConflict target) were swallowed and treated as success.

async function getAllEntries(guildId) {
  requireGuildId(guildId);
  const { data, error } = await supabase
    .from("family_leaderboard")
    .select("*")
    .eq("guild_id", guildId)
    .order("rank", { ascending: true });
  if (error) {
    console.error("[LEADERBOARD LOAD]", error.message, error.code, error.details);
    return [];
  }
  return data || [];
}

async function getEntry(guildId, rank) {
  requireGuildId(guildId);
  const { data, error } = await supabase
    .from("family_leaderboard")
    .select("*")
    .eq("guild_id", guildId)
    .eq("rank", rank)
    .maybeSingle();
  if (error) {
    console.error("[LEADERBOARD GET]", error.message, error.code, error.details);
    return null;
  }
  return data || null;
}

function messageKey(guildId) {
  return `leaderboard_message_${guildId}`;
}

async function saveMessageRef(guildId, channelId, messageId) {
  requireGuildId(guildId);
  const { error } = await supabase
    .from("empire_data")
    .upsert({ key: messageKey(guildId), value: { channelId, messageId } }, { onConflict: "key" });
  if (error) console.error("[LEADERBOARD MSG SAVE]", error.message, error.code, error.details);
}

async function getMessageRef(guildId) {
  requireGuildId(guildId);
  const { data, error } = await supabase
    .from("empire_data")
    .select("value")
    .eq("key", messageKey(guildId))
    .maybeSingle();
  if (error) {
    console.error("[LEADERBOARD MSG GET]", error.message, error.code, error.details);
    return null;
  }
  return data?.value || null;
}

// ── Embed rendering ───────────────────────────────────────────────────────────
const RANK_COLORS = [0xF1C40F, 0xC0C0C0, 0xCD7F32, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2];

function buildEmbed(entry) {
  const nameLine = entry.roblox_id
    ? `[${entry.roblox_username || "Unknown"}](https://www.roblox.com/users/${entry.roblox_id}/profile)`
    : `<@${entry.discord_id}>`;

  const embed = new EmbedBuilder()
    .setColor(RANK_COLORS[entry.rank - 1] || 0x5865F2)
    .setDescription(
      `**#${entry.rank} ${nameLine}**\n` +
      `<@${entry.discord_id}>\n` +
      `Region: - **${entry.region || "—"}**\n` +
      `Country: - ${entry.country_emoji || "—"}\n` +
      `Stage: - **${entry.stage || "—"}**`
    );
  if (entry.avatar_url) embed.setThumbnail(entry.avatar_url);
  return embed;
}

async function renderEmbeds(guildId) {
  const entries = await getAllEntries(guildId);
  return entries.map(buildEmbed);
}

// ── Public actions ────────────────────────────────────────────────────────────
// All public functions now take guildId as the first argument.

// Adds/overwrites an entry at a rank slot, resolves Roblox info, then updates the live message.
async function setEntry(guildId, rank, discordId, region, countryEmoji, stage) {
  requireGuildId(guildId);
  if (rank < 1 || rank > MAX_RANKS) return { success: false, reason: `Rank must be between 1 and ${MAX_RANKS}.` };

  const roblox = await resolveRoblox(discordId);

  const row = {
    guild_id: guildId,
    rank,
    discord_id: discordId,
    region,
    country_emoji: countryEmoji,
    stage,
    roblox_id: roblox?.robloxId || null,
    roblox_username: roblox?.username || null,
    avatar_url: roblox?.avatarUrl || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("family_leaderboard")
    .upsert(row, { onConflict: "guild_id,rank" });
  if (error) {
    console.error("[LEADERBOARD SET]", error.message, error.code, error.details);
    return { success: false, reason: "Database error while saving: " + error.message };
  }

  const updated = await updateLiveMessage(guildId);
  return { success: true, roblox, messageUpdated: updated };
}

async function removeEntry(guildId, rank) {
  requireGuildId(guildId);
  const { error } = await supabase
    .from("family_leaderboard")
    .delete()
    .eq("guild_id", guildId)
    .eq("rank", rank);
  if (error) {
    console.error("[LEADERBOARD REMOVE]", error.message, error.code, error.details);
    return { success: false, reason: "Database error while removing: " + error.message };
  }
  const updated = await updateLiveMessage(guildId);
  return { success: true, messageUpdated: updated };
}

async function clearAll(guildId) {
  requireGuildId(guildId);
  const { error } = await supabase
    .from("family_leaderboard")
    .delete()
    .eq("guild_id", guildId);
  if (error) {
    console.error("[LEADERBOARD CLEAR]", error.message, error.code, error.details);
    return { success: false, reason: "Database error while clearing: " + error.message };
  }
  await updateLiveMessage(guildId);
  return { success: true };
}

// Posts a brand-new leaderboard message in the given channel (used once, or if the old message got deleted).
async function postLeaderboard(guildId, channel) {
  requireGuildId(guildId);
  const embeds = await renderEmbeds(guildId);
  if (embeds.length === 0) {
    return { success: false, reason: "No leaderboard entries yet. Add some with `cosa lb set`." };
  }
  try {
    const msg = await channel.send({ embeds });
    await saveMessageRef(guildId, channel.id, msg.id);
    return { success: true, message: msg };
  } catch (e) {
    console.error("[LEADERBOARD POST]", e.message);
    return { success: false, reason: "Failed to send leaderboard message: " + e.message };
  }
}

// Re-renders and edits the existing live message in place. Returns true if it succeeded.
async function updateLiveMessage(guildId) {
  requireGuildId(guildId);
  const ref = await getMessageRef(guildId);
  if (!ref) return false; // nothing posted yet — caller should use postLeaderboard first
  try {
    const channel = await discordClient.channels.fetch(ref.channelId).catch(() => null);
    if (!channel) return false;
    const message = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!message) return false;
    const embeds = await renderEmbeds(guildId);
    if (embeds.length === 0) {
      await message.edit({ embeds: [], content: "🏆 *No entries on the leaderboard right now.*" }).catch(() => {});
      return true;
    }
    await message.edit({ embeds, content: "" });
    return true;
  } catch (e) {
    console.error("[LEADERBOARD UPDATE]", e.message);
    return false;
  }
}

// Re-fetches Roblox avatar/username for every entry (in case someone re-verified) and re-renders.
async function refreshAll(guildId) {
  requireGuildId(guildId);
  const entries = await getAllEntries(guildId);
  for (const entry of entries) {
    const roblox = await resolveRoblox(entry.discord_id);
    if (roblox) {
      const { error } = await supabase
        .from("family_leaderboard")
        .update({
          roblox_id: roblox.robloxId,
          roblox_username: roblox.username,
          avatar_url: roblox.avatarUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("guild_id", guildId)
        .eq("rank", entry.rank);
      if (error) console.error("[LEADERBOARD REFRESH]", error.message, error.code, error.details);
    }
  }
  const updated = await updateLiveMessage(guildId);
  return { success: true, count: entries.length, messageUpdated: updated };
}

module.exports = {
  initLeaderboard,
  setEntry,
  removeEntry,
  clearAll,
  postLeaderboard,
  updateLiveMessage,
  refreshAll,
  getAllEntries,
  getEntry,
  MAX_RANKS,
};
