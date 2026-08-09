const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// ── Extra Developer Access ──────────────────────────────────────────────────
// Lets MASTER_ID (and only MASTER_ID) grant another user full command access
// equivalent to the Don, WITHOUT that user appearing in any public-facing
// list (family ledger, leaderboard, gang rosters, etc). This is deliberately
// invisible to everyone except the master account.
//
// IMPORTANT: this is still recorded — just privately. It's stored in your
// existing empire_data table under a key that no public command reads or
// displays. That's intentional: an admin backdoor with literally zero record
// means that if your own account is ever compromised, someone can grant
// themselves permanent invisible access and you'd have no way to detect or
// revoke it. Keeping a master-only record lets YOU see/undo grants while
// still keeping them fully hidden from everyone else, including the grantee
// list, audit log channel, and leaderboard.
//
// Table reused: empire_data
//   key = "dev_access_list"   value = { ids: [ { userId, grantedAt } ] }
//
// Nothing here ever touches family_leaderboard, auditlog.js's public channel
// feed, or any other user-visible surface.

const DEV_LIST_KEY = "dev_access_list";
const CONFIRM_TIMEOUT_MS = 60 * 1000;

let supabase;
let MASTER_ID;

// In-memory cache so permission checks elsewhere in the bot (canDo, isModUser,
// isMaster, etc.) can do a synchronous lookup instead of awaiting a DB call
// on every single message/command. Loaded at boot, kept in sync on every
// grant/revoke.
let devIdCache = new Set();

async function _refreshCache() {
  const ids = await _getList();
  devIdCache = new Set(ids.map(e => e.userId));
}

function isDeveloperSync(userId) {
  return devIdCache.has(userId);
}

async function initDevAccess(masterId, supabaseUrl, supabaseKey) {
  MASTER_ID = masterId;
  supabase = createClient(supabaseUrl, supabaseKey, { realtime: { transport: ws } });
  await _refreshCache().catch(e => console.error("[DEVACCESS CACHE INIT]", e.message));
  console.log("🛠️ Dev access system initialized (private, master-only) —", devIdCache.size, "developer(s) loaded");
}

// ── Storage helpers ──────────────────────────────────────────────────────
async function _getList() {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", DEV_LIST_KEY).maybeSingle();
  if (error) { console.error("[DEVACCESS GET]", error.message); return []; }
  return data?.value?.ids || [];
}

async function _saveList(ids) {
  const { error } = await supabase.from("empire_data").upsert(
    { key: DEV_LIST_KEY, value: { ids } },
    { onConflict: "key" }
  );
  if (error) console.error("[DEVACCESS SAVE]", error.message);
}

// ── Public permission check — plug into your command gating alongside isDon ─
async function isDeveloper(userId) {
  if (userId === MASTER_ID) return true;
  return devIdCache.has(userId);
}

async function listDevelopers() {
  return _getList();
}

// ── Grant / revoke (actual DB writes, called only after double-confirm) ────
async function _grant(userId) {
  const ids = await _getList();
  if (ids.some(e => e.userId === userId)) return { success: false, reason: "Already has dev access." };
  ids.push({ userId, grantedAt: new Date().toISOString() });
  await _saveList(ids);
  await _refreshCache();
  return { success: true };
}

async function _revoke(userId) {
  const ids = await _getList();
  if (!ids.some(e => e.userId === userId)) return { success: false, reason: "That user doesn't have dev access." };
  await _saveList(ids.filter(e => e.userId !== userId));
  await _refreshCache();
  return { success: true };
}

// ── Double-confirmation flow (in-memory, per master, expires) ──────────────
// action: "grant" | "revoke"
const pendingConfirmations = new Map(); // confirmId -> { action, targetId, stage, expiresAt }

function _newConfirmId() {
  return Math.random().toString(36).slice(2, 10);
}

function buildConfirmRow(confirmId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`devaccess_confirm:${confirmId}`).setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`devaccess_cancel:${confirmId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
}

// Step 1 — call this from the slash command handler. Returns the first
// confirmation prompt (ephemeral). Only MASTER_ID may call this at all.
function beginGrantFlow(requesterId, targetId) {
  if (requesterId !== MASTER_ID) return { success: false, reason: "🚫 Only the Don himself can do this." };
  if (targetId === MASTER_ID) return { success: false, reason: "You already have full access." };

  const confirmId = _newConfirmId();
  pendingConfirmations.set(confirmId, {
    action: "grant", targetId, requesterId, stage: 1,
    expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
  });
  setTimeout(() => {
    const c = pendingConfirmations.get(confirmId);
    if (c && c.expiresAt <= Date.now()) pendingConfirmations.delete(confirmId);
  }, CONFIRM_TIMEOUT_MS);

  return {
    success: true, confirmId,
    text: `⚠️ **Confirm step 1/2**\nGrant <@${targetId}> full developer access — every command, no restrictions, and it will **not** appear anywhere public (not the family ledger, not the audit log, nowhere).\n\nThis is stored privately so only you can see or revoke it later.`,
    components: [buildConfirmRow(confirmId, "Continue →")],
  };
}

function beginRevokeFlow(requesterId, targetId) {
  if (requesterId !== MASTER_ID) return { success: false, reason: "🚫 Only the Don himself can do this." };

  const confirmId = _newConfirmId();
  pendingConfirmations.set(confirmId, {
    action: "revoke", targetId, requesterId, stage: 1,
    expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
  });
  setTimeout(() => {
    const c = pendingConfirmations.get(confirmId);
    if (c && c.expiresAt <= Date.now()) pendingConfirmations.delete(confirmId);
  }, CONFIRM_TIMEOUT_MS);

  return {
    success: true, confirmId,
    text: `⚠️ **Confirm step 1/2**\nRevoke <@${targetId}>'s developer access?`,
    components: [buildConfirmRow(confirmId, "Continue →")],
  };
}

// Step 2 — called from the button interaction handler when the FIRST
// confirm button is clicked. Advances to the second (final) confirmation.
function advanceConfirmation(confirmId, clickerId) {
  const c = pendingConfirmations.get(confirmId);
  if (!c) return { success: false, reason: "⌛ This confirmation expired or doesn't exist. Start over." };
  if (clickerId !== MASTER_ID) return { success: false, reason: "🚫 Only the Don can confirm this." };
  if (c.expiresAt <= Date.now()) { pendingConfirmations.delete(confirmId); return { success: false, reason: "⌛ Confirmation timed out. Start over." }; }

  if (c.stage === 1) {
    c.stage = 2;
    c.expiresAt = Date.now() + CONFIRM_TIMEOUT_MS;
    const verb = c.action === "grant" ? "GRANT" : "REVOKE";
    return {
      success: true, final: false,
      text: `🔴 **Final confirmation (2/2)** — ${verb} developer access for <@${c.targetId}>?\nThis takes effect immediately.`,
      components: [buildConfirmRow(confirmId, `Confirm ${verb}`)],
    };
  }

  // stage 2 -> execute
  pendingConfirmations.delete(confirmId);
  return { success: true, final: true, action: c.action, targetId: c.targetId };
}

function cancelConfirmation(confirmId, clickerId) {
  const c = pendingConfirmations.get(confirmId);
  if (!c) return { success: false, reason: "Nothing to cancel." };
  if (clickerId !== MASTER_ID) return { success: false, reason: "🚫 Only the Don can cancel this." };
  pendingConfirmations.delete(confirmId);
  return { success: true };
}

// Called after advanceConfirmation() returns final:true — does the real write.
async function executeConfirmedAction(action, targetId) {
  if (action === "grant") return _grant(targetId);
  if (action === "revoke") return _revoke(targetId);
  return { success: false, reason: "Unknown action." };
}

module.exports = {
  initDevAccess, isDeveloper, isDeveloperSync, listDevelopers,
  beginGrantFlow, beginRevokeFlow, advanceConfirmation, cancelConfirmation, executeConfirmedAction,
};
