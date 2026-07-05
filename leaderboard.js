// ═══════════════════════════════════════════════════════════════════════════════
// leaderboard.js — Family Rankings Leaderboard (#1-#10, single message, editable)
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
//   rank int PRIMARY KEY, discord_id text, region text, country_emoji text,
//   stage text, roblox_id text, roblox_username text, avatar_url text, updated_at timestamptz
//
// Table: empire_data (already exists in your project) is reused to store the
// posted message's channel_id + message_id under key "leaderboard_message".

function initLeaderboard({ masterId, supabaseUrl, supabaseKey, clientRef, bloxlinkApiKey, bloxlinkGuildId }) {
  MASTER_ID = masterId;
  discordClient = clientRef;
  BLOXLINK_API_KEY = bloxlinkApiKey;
  BLOXLINK_GUILD_ID = bloxlinkGuildId;
  supabase = createClient(supabaseUrl, supabaseKey, { realtime: { transport: ws } });
  console.log("🏆 Leaderboard system initialized");
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
    } catch {}

    // Avatar headshot
    let avatarUrl = null;
    try {
      const aRes = await fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`
      );
      const aData = await aRes.json();
      avatarUrl = aData?.data?.[0]?.imageUrl || null;
    } catch {}

    return { robloxId, username, avatarUrl };
  } catch (e) {
    console.error("[LEADERBOARD BLOXLINK]", e.message);
    return null;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getAllEntries() {
  const { data, error } = await supabase.from("family_leaderboard").select("*").order("rank", { ascending: true });
  if (error) {
    console.error("[LEADERBOARD LOAD]", error.message);
    return [];
  }
  return data || [];
}

async function getEntry(rank) {
  const { data, error } = await supabase.from("family_leaderboard").select("*").eq("rank", rank).maybeSingle();
  if (error) {
    console.error("[LEADERBOARD GET]", error.message);
    return null;
  }
  return data || null;
}

async function saveMessageRef(channelId, messageId) {
  const { error } = await supabase.from("empire_data").upsert(
    { key: "leaderboard_message", value: { channelId, messageId } },
    { onConflict: "key" }
  );
  if (error) console.error("[LEADERBOARD MSG SAVE]", error.message);
}

async function getMessageRef() {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", "leaderboard_message").maybeSingle();
  if (error) {
    console.error("[LEADERBOARD MSG GET]", error.message);
    return null;
  }
  return data?.value || null;
}

// ── Leaderboard Editors (permission allowlist, separate from Don-only powers) ─
const EDITORS_KEY = "leaderboard_editors";

async function getEditorIds() {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", EDITORS_KEY).maybeSingle();
  if (error) {
    console.error("[LEADERBOARD EDITORS GET]", error.message);
    return [];
  }
  return data?.value?.ids || [];
}

async function addEditor(userId) {
  const ids = await getEditorIds();
  if (ids.includes(userId)) return { success: true, alreadyPresent: true, ids };
  const updated = [...ids, userId];
  const { error } = await supabase.from("empire_data").upsert(
    { key: EDITORS_KEY, value: { ids: updated } },
    { onConflict: "key" }
  );
  if (error) {
    console.error("[LEADERBOARD EDITORS ADD]", error.message);
    return { success: false, reason: error.message };
  }
  return { success: true, ids: updated };
}

async function removeEditor(userId) {
  const ids = await getEditorIds();
  if (!ids.includes(userId)) return { success: true, wasPresent: false, ids };
  const updated = ids.filter(id => id !== userId);
  const { error } = await supabase.from("empire_data").upsert(
    { key: EDITORS_KEY, value: { ids: updated } },
    { onConflict: "key" }
  );
  if (error) {
    console.error("[LEADERBOARD EDITORS REMOVE]", error.message);
    return { success: false, reason: error.message };
  }
  return { success: true, wasPresent: true, ids: updated };
}

async function isEditor(userId) {
  const ids = await getEditorIds();
  return ids.includes(userId);
}

// ── Embed rendering ───────────────────────────────────────────────────────────
const RANK_COLORS = [0xF1C40F, 0xC0C0C0, 0xCD7F32, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2];

function buildEmbed(entry) {
  const displayName = entry.roblox_username || `<@${entry.discord_id}>`;
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

async function renderEmbeds() {
  const entries = await getAllEntries();
  return entries.map(buildEmbed);
}

// ── Public actions ────────────────────────────────────────────────────────────

// Adds/overwrites an entry at a rank slot, resolves Roblox info, then updates the live message.
async function setEntry(rank, discordId, region, countryEmoji, stage, guildId) {
  console.log("[LB SET DEBUG] rank=", rank, "| typeof=", typeof rank, "| MAX_RANKS=", MAX_RANKS, "| typeof MAX_RANKS=", typeof MAX_RANKS, "| rank<1:", rank < 1, "| rank>MAX_RANKS:", rank > MAX_RANKS);
  if (rank < 1 || rank > MAX_RANKS) return { success: false, reason: `Rank must be between 1 and ${MAX_RANKS}.` };

  const roblox = await resolveRoblox(discordId);

  const row = {
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
  if (guildId) row.guild_id = guildId;

  const { error: upsertError } = await supabase.from("family_leaderboard").upsert(row, { onConflict: "rank" });
  if (upsertError) {
    console.error("[LEADERBOARD SET]", upsertError.message);
    return { success: false, reason: "Database error while saving: " + upsertError.message };
  }

  const updated = await updateLiveMessage();
  return { success: true, roblox, messageUpdated: updated };
}

async function removeEntry(rank) {
  const { error } = await supabase.from("family_leaderboard").delete().eq("rank", rank);
  if (error) {
    console.error("[LEADERBOARD REMOVE]", error.message);
    return { success: false, reason: "Database error while removing: " + error.message };
  }
  const updated = await updateLiveMessage();
  return { success: true, messageUpdated: updated };
}

async function clearAll() {
  const { error } = await supabase.from("family_leaderboard").delete().neq("rank", -1);
  if (error) {
    console.error("[LEADERBOARD CLEAR]", error.message);
    return { success: false, reason: error.message };
  }
  await updateLiveMessage();
  return { success: true };
}

// Posts a brand-new leaderboard message in the given channel (used once, or if the old message got deleted).
async function postLeaderboard(channel) {
  const embeds = await renderEmbeds();
  if (embeds.length === 0) {
    return { success: false, reason: "No leaderboard entries yet. Add some with `cosa lb set`." };
  }
  try {
    const msg = await channel.send({ embeds });
    await saveMessageRef(channel.id, msg.id);
    return { success: true, message: msg };
  } catch (e) {
    console.error("[LEADERBOARD POST]", e.message);
    return { success: false, reason: "Failed to send leaderboard message: " + e.message };
  }
}

// Re-renders and edits the existing live message in place. Returns true if it succeeded.
async function updateLiveMessage() {
  const ref = await getMessageRef();
  if (!ref) return false; // nothing posted yet — caller should use postLeaderboard first
  try {
    const channel = await discordClient.channels.fetch(ref.channelId).catch(() => null);
    if (!channel) return false;
    const message = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!message) return false;
    const embeds = await renderEmbeds();
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
async function refreshAll() {
  const entries = await getAllEntries();
  for (const entry of entries) {
    const roblox = await resolveRoblox(entry.discord_id);
    if (roblox) {
      const { error } = await supabase.from("family_leaderboard").update({
        roblox_id: roblox.robloxId,
        roblox_username: roblox.username,
        avatar_url: roblox.avatarUrl,
        updated_at: new Date().toISOString(),
      }).eq("rank", entry.rank);
      if (error) console.error("[LEADERBOARD REFRESH]", error.message);
    }
  }
  const updated = await updateLiveMessage();
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
  getEditorIds,
  addEditor,
  removeEditor,
  isEditor,
  MAX_RANKS,
};
