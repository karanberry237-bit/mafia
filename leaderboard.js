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
//   guild_id text, rank int, discord_id text, region text, country_emoji text,
//   stage text, roblox_id text, roblox_username text, avatar_url text, updated_at timestamptz
//   PRIMARY KEY (guild_id, rank)   <-- composite key, NOT rank alone
//
// ⚠️ MIGRATION NEEDED if you're upgrading from the old single-server version:
//   alter table family_leaderboard drop constraint family_leaderboard_pkey;
//   alter table family_leaderboard add primary key (guild_id, rank);
//   -- (backfill guild_id on any existing rows first, they'll otherwise violate the new PK)
//
// Table: empire_data (already exists in your project) is reused to store the
// posted message's channel_id + message_id under key "leaderboard_message_<guildId>",
// and the per-guild editor allowlist under key "leaderboard_editors_<guildId>".
// DMs / no-guild context fall back to the shared bucket "__dm__".

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

// ── Guild-scoping helper ──────────────────────────────────────────────────────
// Every leaderboard now lives per-guild. DMs (no guild) fall back to a shared
// "__dm__" bucket so the functions never blow up if guildId is undefined.
function gid(guildId) { return guildId || "__dm__"; }

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getAllEntries(guildId) {
  const { data, error } = await supabase.from("family_leaderboard")
    .select("*")
    .eq("guild_id", gid(guildId))
    .order("rank", { ascending: true });
  if (error) {
    console.error("[LEADERBOARD LOAD]", error.message);
    return [];
  }
  return data || [];
}

async function getEntry(guildId, rank) {
  const { data, error } = await supabase.from("family_leaderboard")
    .select("*")
    .eq("guild_id", gid(guildId))
    .eq("rank", rank)
    .maybeSingle();
  if (error) {
    console.error("[LEADERBOARD GET]", error.message);
    return null;
  }
  return data || null;
}

function messageKey(guildId) { return "leaderboard_message_" + gid(guildId); }

async function saveMessageRef(guildId, channelId, messageId) {
  const { error } = await supabase.from("empire_data").upsert(
    { key: messageKey(guildId), value: { channelId, messageId } },
    { onConflict: "key" }
  );
  if (error) console.error("[LEADERBOARD MSG SAVE]", error.message);
}

async function getMessageRef(guildId) {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", messageKey(guildId)).maybeSingle();
  if (error) {
    console.error("[LEADERBOARD MSG GET]", error.message);
    return null;
  }
  return data?.value || null;
}

// ── Leaderboard Editors (permission allowlist, separate from Don-only powers) ─
// Editors are per-guild: someone granted editor rights in Server A has no
// leaderboard powers in Server B unless granted there too.
function editorsKey(guildId) { return "leaderboard_editors_" + gid(guildId); }

async function getEditorIds(guildId) {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", editorsKey(guildId)).maybeSingle();
  if (error) {
    console.error("[LEADERBOARD EDITORS GET]", error.message);
    return [];
  }
  return data?.value?.ids || [];
}

async function addEditor(guildId, userId) {
  const ids = await getEditorIds(guildId);
  if (ids.includes(userId)) return { success: true, alreadyPresent: true, ids };
  const updated = [...ids, userId];
  const { error } = await supabase.from("empire_data").upsert(
    { key: editorsKey(guildId), value: { ids: updated } },
    { onConflict: "key" }
  );
  if (error) {
    console.error("[LEADERBOARD EDITORS ADD]", error.message);
    return { success: false, reason: error.message };
  }
  return { success: true, ids: updated };
}

async function removeEditor(guildId, userId) {
  const ids = await getEditorIds(guildId);
  if (!ids.includes(userId)) return { success: true, wasPresent: false, ids };
  const updated = ids.filter(id => id !== userId);
  const { error } = await supabase.from("empire_data").upsert(
    { key: editorsKey(guildId), value: { ids: updated } },
    { onConflict: "key" }
  );
  if (error) {
    console.error("[LEADERBOARD EDITORS REMOVE]", error.message);
    return { success: false, reason: error.message };
  }
  return { success: true, wasPresent: true, ids: updated };
}

async function isEditor(guildId, userId) {
  const ids = await getEditorIds(guildId);
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

async function renderEmbeds(guildId) {
  const entries = await getAllEntries(guildId);
  return entries.map(buildEmbed);
}

// ── Public actions ────────────────────────────────────────────────────────────

// Adds/overwrites an entry at a rank slot, resolves Roblox info, then updates the live message.
// guildId is required now — rank slots are scoped per-guild (guildId + rank together, not rank alone).
async function setEntry(guildId, rank, discordId, region, countryEmoji, stage) {
  const g = gid(guildId);
  console.log("[LB SET DEBUG] guild=", g, "| rank=", rank, "| typeof=", typeof rank, "| MAX_RANKS=", MAX_RANKS, "| typeof MAX_RANKS=", typeof MAX_RANKS, "| rank<1:", rank < 1, "| rank>MAX_RANKS:", rank > MAX_RANKS);
  if (rank < 1 || rank > MAX_RANKS) return { success: false, reason: `Rank must be between 1 and ${MAX_RANKS}.` };

  const roblox = await resolveRoblox(discordId);

  const row = {
    guild_id: g,
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

  const { error: upsertError } = await supabase.from("family_leaderboard").upsert(row, { onConflict: "guild_id,rank" });
  if (upsertError) {
    console.error("[LEADERBOARD SET]", upsertError.message);
    return { success: false, reason: "Database error while saving: " + upsertError.message };
  }

  const updated = await updateLiveMessage(g);
  return { success: true, roblox, messageUpdated: updated };
}

async function removeEntry(guildId, rank) {
  const g = gid(guildId);
  const { error } = await supabase.from("family_leaderboard").delete().eq("guild_id", g).eq("rank", rank);
  if (error) {
    console.error("[LEADERBOARD REMOVE]", error.message);
    return { success: false, reason: "Database error while removing: " + error.message };
  }
  const updated = await updateLiveMessage(g);
  return { success: true, messageUpdated: updated };
}

async function clearAll(guildId) {
  const g = gid(guildId);
  const { error } = await supabase.from("family_leaderboard").delete().eq("guild_id", g);
  if (error) {
    console.error("[LEADERBOARD CLEAR]", error.message);
    return { success: false, reason: error.message };
  }
  await updateLiveMessage(g);
  return { success: true };
}

// Posts a brand-new leaderboard message in the given channel (used once, or if the old message got deleted).
async function postLeaderboard(guildId, channel) {
  const g = gid(guildId);
  const embeds = await renderEmbeds(g);
  if (embeds.length === 0) {
    return { success: false, reason: "No leaderboard entries yet for this server. Add some with `/leaderboard set`." };
  }
  try {
    const msg = await channel.send({ embeds });
    await saveMessageRef(g, channel.id, msg.id);
    return { success: true, message: msg };
  } catch (e) {
    console.error("[LEADERBOARD POST]", e.message);
    return { success: false, reason: "Failed to send leaderboard message: " + e.message };
  }
}

// Re-renders and edits the existing live message in place. Returns true if it succeeded.
async function updateLiveMessage(guildId) {
  const g = gid(guildId);
  const ref = await getMessageRef(g);
  if (!ref) return false; // nothing posted yet for this guild — caller should use postLeaderboard first
  try {
    const channel = await discordClient.channels.fetch(ref.channelId).catch(() => null);
    if (!channel) return false;
    const message = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!message) return false;
    const embeds = await renderEmbeds(g);
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

// Re-fetches Roblox avatar/username for every entry in this guild (in case someone re-verified) and re-renders.
async function refreshAll(guildId) {
  const g = gid(guildId);
  const entries = await getAllEntries(g);
  for (const entry of entries) {
    const roblox = await resolveRoblox(entry.discord_id);
    if (roblox) {
      const { error } = await supabase.from("family_leaderboard").update({
        roblox_id: roblox.robloxId,
        roblox_username: roblox.username,
        avatar_url: roblox.avatarUrl,
        updated_at: new Date().toISOString(),
      }).eq("guild_id", g).eq("rank", entry.rank);
      if (error) console.error("[LEADERBOARD REFRESH]", error.message);
    }
  }
  const updated = await updateLiveMessage(g);
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
