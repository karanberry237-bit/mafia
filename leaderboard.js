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
//   channel_id text, rank int, discord_id text, region text, country_emoji text,
//   stage text, roblox_id text, roblox_username text, avatar_url text, updated_at timestamptz
//   PRIMARY KEY (channel_id, rank)   <-- composite key, NOT rank alone
//
// Leaderboards are scoped PER CHANNEL (not per-server) — e.g. a ping-based
// game server bot can run one leaderboard per region channel, all independent.
//
// ⚠️ MIGRATION NEEDED if you're upgrading from an older version of this file:
//   -- if you're coming from the very first version (rank-only PK):
//   alter table family_leaderboard add column if not exists channel_id text;
//   update family_leaderboard set channel_id = '<pick a channel id per row>'; -- backfill
//   alter table family_leaderboard drop constraint family_leaderboard_pkey;
//   alter table family_leaderboard add primary key (channel_id, rank);
//   -- if you're coming from the guild-scoped version, rename the guild_id
//   -- column to channel_id — its old values won't match real channel IDs, so
//   -- also re-run /leaderboard set for each entry, or manually backfill.
//
// Table: empire_data (already exists in your project) is reused to store the
// posted message's channel_id + message_id under key "leaderboard_message_<channelId>",
// and the per-channel editor allowlist under key "leaderboard_editors_<channelId>".
// DMs / no-channel context fall back to the shared bucket "__dm__".

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

// ── Channel-scoping helper ─────────────────────────────────────────────────────
// Every leaderboard now lives per-channel. DMs (no channel context passed in)
// fall back to a shared "__dm__" bucket so functions never blow up.
function cid(channelId) { return channelId || "__dm__"; }

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getAllEntries(channelId) {
  const { data, error } = await supabase.from("family_leaderboard")
    .select("*")
    .eq("channel_id", cid(channelId))
    .order("rank", { ascending: true });
  if (error) {
    console.error("[LEADERBOARD LOAD]", error.message);
    return [];
  }
  return data || [];
}

async function getEntry(channelId, rank) {
  const { data, error } = await supabase.from("family_leaderboard")
    .select("*")
    .eq("channel_id", cid(channelId))
    .eq("rank", rank)
    .maybeSingle();
  if (error) {
    console.error("[LEADERBOARD GET]", error.message);
    return null;
  }
  return data || null;
}

function messageKey(channelId) { return "leaderboard_message_" + cid(channelId); }

async function saveMessageRef(channelId, messageId) {
  const c = cid(channelId);
  const { error } = await supabase.from("empire_data").upsert(
    { key: messageKey(c), value: { channelId: c, messageId } },
    { onConflict: "key" }
  );
  if (error) console.error("[LEADERBOARD MSG SAVE]", error.message);
}

async function getMessageRef(channelId) {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", messageKey(channelId)).maybeSingle();
  if (error) {
    console.error("[LEADERBOARD MSG GET]", error.message);
    return null;
  }
  return data?.value || null;
}

// ── Leaderboard Editors (permission allowlist, separate from Don-only powers) ─
// Editors are per-channel: someone granted editor rights in Channel A has no
// leaderboard powers in Channel B unless granted there too.
function editorsKey(channelId) { return "leaderboard_editors_" + cid(channelId); }

async function getEditorIds(channelId) {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", editorsKey(channelId)).maybeSingle();
  if (error) {
    console.error("[LEADERBOARD EDITORS GET]", error.message);
    return [];
  }
  return data?.value?.ids || [];
}

async function addEditor(channelId, userId) {
  const ids = await getEditorIds(channelId);
  if (ids.includes(userId)) return { success: true, alreadyPresent: true, ids };
  const updated = [...ids, userId];
  const { error } = await supabase.from("empire_data").upsert(
    { key: editorsKey(channelId), value: { ids: updated } },
    { onConflict: "key" }
  );
  if (error) {
    console.error("[LEADERBOARD EDITORS ADD]", error.message);
    return { success: false, reason: error.message };
  }
  return { success: true, ids: updated };
}

async function removeEditor(channelId, userId) {
  const ids = await getEditorIds(channelId);
  if (!ids.includes(userId)) return { success: true, wasPresent: false, ids };
  const updated = ids.filter(id => id !== userId);
  const { error } = await supabase.from("empire_data").upsert(
    { key: editorsKey(channelId), value: { ids: updated } },
    { onConflict: "key" }
  );
  if (error) {
    console.error("[LEADERBOARD EDITORS REMOVE]", error.message);
    return { success: false, reason: error.message };
  }
  return { success: true, wasPresent: true, ids: updated };
}

async function isEditor(channelId, userId) {
  const ids = await getEditorIds(channelId);
  return ids.includes(userId);
}

// ── Embed rendering ───────────────────────────────────────────────────────────
const RANK_COLORS = [0xF1C40F, 0xC0C0C0, 0xCD7F32, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2, 0x5865F2];

function buildEmbed(entry) {
  const displayName = entry.roblox_username || `<@${entry.discord_id}>`;

  const embed = new EmbedBuilder()
    .setColor(RANK_COLORS[entry.rank - 1] || 0x5865F2)
    .setTitle(`#${entry.rank} ${displayName}`)
    .setDescription(
      `| <@${entry.discord_id}> |\n` +
      `<< | .${displayName}. | >>\n\n` +
      `Region: **${entry.region || "—"}**\n` +
      `Country: ${entry.country_emoji || "—"}\n` +
      `Stage: **${entry.stage || "—"}**`
    );
  if (entry.avatar_url) embed.setThumbnail(entry.avatar_url);
  return embed;
}

async function renderEmbeds(channelId) {
  const entries = await getAllEntries(channelId);
  return entries.map(buildEmbed);
}

// ── Public actions ────────────────────────────────────────────────────────────

// Adds/overwrites an entry at a rank slot, resolves Roblox info, then updates the live message.
// channelId is required — rank slots are scoped per-channel (channelId + rank together, not rank alone).
async function setEntry(channelId, rank, discordId, region, countryEmoji, stage) {
  const c = cid(channelId);
  console.log("[LB SET DEBUG] channel=", c, "| rank=", rank, "| typeof=", typeof rank, "| MAX_RANKS=", MAX_RANKS, "| typeof MAX_RANKS=", typeof MAX_RANKS, "| rank<1:", rank < 1, "| rank>MAX_RANKS:", rank > MAX_RANKS);
  if (rank < 1 || rank > MAX_RANKS) return { success: false, reason: `Rank must be between 1 and ${MAX_RANKS}.` };

  const roblox = await resolveRoblox(discordId);

  const row = {
    channel_id: c,
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

  const { error: upsertError } = await supabase.from("family_leaderboard").upsert(row, { onConflict: "channel_id,rank" });
  if (upsertError) {
    console.error("[LEADERBOARD SET]", upsertError.message);
    return { success: false, reason: "Database error while saving: " + upsertError.message };
  }

  const updated = await updateLiveMessage(c);
  return { success: true, roblox, messageUpdated: updated };
}

async function removeEntry(channelId, rank) {
  const c = cid(channelId);
  const { error } = await supabase.from("family_leaderboard").delete().eq("channel_id", c).eq("rank", rank);
  if (error) {
    console.error("[LEADERBOARD REMOVE]", error.message);
    return { success: false, reason: "Database error while removing: " + error.message };
  }
  const updated = await updateLiveMessage(c);
  return { success: true, messageUpdated: updated };
}

async function clearAll(channelId) {
  const c = cid(channelId);
  const { error } = await supabase.from("family_leaderboard").delete().eq("channel_id", c);
  if (error) {
    console.error("[LEADERBOARD CLEAR]", error.message);
    return { success: false, reason: error.message };
  }
  await updateLiveMessage(c);
  return { success: true };
}

// Posts a brand-new leaderboard message in the given channel (used once, or if the old message got deleted).
async function postLeaderboard(channelId, channel) {
  const c = cid(channelId);
  const embeds = await renderEmbeds(c);
  if (embeds.length === 0) {
    return { success: false, reason: "No leaderboard entries yet for this channel. Add some with `/leaderboard set`." };
  }
  try {
    const msg = await channel.send({ embeds });
    await saveMessageRef(c, msg.id);
    return { success: true, message: msg };
  } catch (e) {
    console.error("[LEADERBOARD POST]", e.message);
    return { success: false, reason: "Failed to send leaderboard message: " + e.message };
  }
}

// Re-renders and edits the existing live message in place. Returns true if it succeeded.
async function updateLiveMessage(channelId) {
  const c = cid(channelId);
  const ref = await getMessageRef(c);
  if (!ref) return false; // nothing posted yet for this channel — caller should use postLeaderboard first
  try {
    const channel = await discordClient.channels.fetch(ref.channelId).catch(() => null);
    if (!channel) return false;
    const message = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!message) return false;
    const embeds = await renderEmbeds(c);
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

// Re-fetches Roblox avatar/username for every entry in this channel (in case someone re-verified) and re-renders.
async function refreshAll(channelId) {
  const c = cid(channelId);
  const entries = await getAllEntries(c);
  for (const entry of entries) {
    const roblox = await resolveRoblox(entry.discord_id);
    if (roblox) {
      const { error } = await supabase.from("family_leaderboard").update({
        roblox_id: roblox.robloxId,
        roblox_username: roblox.username,
        avatar_url: roblox.avatarUrl,
        updated_at: new Date().toISOString(),
      }).eq("channel_id", c).eq("rank", entry.rank);
      if (error) console.error("[LEADERBOARD REFRESH]", error.message);
    }
  }
  const updated = await updateLiveMessage(c);
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
