const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { fmt } = require("./economy");

// ── Gangs ──────────────────────────────────────────────────────────────────
// Foundation module — Turf Wars, Alliances, and shared Businesses all attach
// to a gang. A gang is a DB-tracked crew (not a Discord role), portable and
// independent of server role management.
//
// Table: gangs
//   id uuid default gen_random_uuid() primary key, name text unique,
//   leader_id text, treasury bigint default 0, created_at timestamptz default now()
//
// Table: gang_members
//   gang_id uuid references gangs(id) on delete cascade, user_id text unique,
//   role text default 'member',  -- 'leader' | 'officer' | 'member'
//   joined_at timestamptz default now()
//   PRIMARY KEY (gang_id, user_id)
//
// A user can only be in ONE gang at a time (user_id is unique across gang_members).

let supabase;
function initGangs(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  console.log("🕴️ Gangs system initialized");
}

const MAX_GANG_NAME_LEN = 32;

async function getGangByName(name) {
  const { data, error } = await supabase.from("gangs").select("*").ilike("name", name).maybeSingle();
  if (error) { console.error("[GANG GET BY NAME]", error.message); return null; }
  return data;
}

async function getGangById(id) {
  const { data, error } = await supabase.from("gangs").select("*").eq("id", id).maybeSingle();
  if (error) { console.error("[GANG GET BY ID]", error.message); return null; }
  return data;
}

// Returns { gang, membership } or null if the user isn't in a gang.
async function getUserGang(userId) {
  const { data: membership, error } = await supabase.from("gang_members").select("*").eq("user_id", userId).maybeSingle();
  if (error) { console.error("[GANG MEMBERSHIP GET]", error.message); return null; }
  if (!membership) return null;
  const gang = await getGangById(membership.gang_id);
  if (!gang) return null;
  return { gang, membership };
}

async function getMembers(gangId) {
  const { data, error } = await supabase.from("gang_members").select("*").eq("gang_id", gangId).order("joined_at", { ascending: true });
  if (error) { console.error("[GANG MEMBERS]", error.message); return []; }
  return data || [];
}

async function createGang(userId, name) {
  name = (name || "").trim();
  if (!name) return { success: false, reason: "Gang name can't be empty." };
  if (name.length > MAX_GANG_NAME_LEN) return { success: false, reason: `Gang name must be ${MAX_GANG_NAME_LEN} characters or fewer.` };

  const already = await getUserGang(userId);
  if (already) return { success: false, reason: `You're already in **${already.gang.name}**. Leave it first with **Cosa gang leave**.` };

  const existing = await getGangByName(name);
  if (existing) return { success: false, reason: "A gang with that name already exists." };

  const { data: gang, error } = await supabase.from("gangs").insert({ name, leader_id: userId, treasury: 0 }).select().maybeSingle();
  if (error) { console.error("[GANG CREATE]", error.message); return { success: false, reason: "Database error creating gang: " + error.message }; }

  const { error: memberError } = await supabase.from("gang_members").insert({ gang_id: gang.id, user_id: userId, role: "leader" });
  if (memberError) { console.error("[GANG CREATE MEMBER]", memberError.message); return { success: false, reason: "Database error adding you as leader: " + memberError.message }; }

  return { success: true, gang };
}

async function disbandGang(userId) {
  const ug = await getUserGang(userId);
  if (!ug) return { success: false, reason: "You're not in a gang." };
  if (ug.membership.role !== "leader") return { success: false, reason: "Only the gang leader can disband it." };

  const { error } = await supabase.from("gangs").delete().eq("id", ug.gang.id);
  if (error) { console.error("[GANG DISBAND]", error.message); return { success: false, reason: error.message }; }
  return { success: true, gang: ug.gang };
}

// ── Invites (in-memory, expire after 5 min, matches existing challenge pattern) ─
const pendingInvites = new Map(); // key: targetUserId -> { gangId, gangName, invitedBy, createdAt }
function createInvite(targetUserId, gangId, gangName, invitedBy) {
  pendingInvites.set(targetUserId, { gangId, gangName, invitedBy, createdAt: Date.now() });
  setTimeout(() => { if (pendingInvites.has(targetUserId)) pendingInvites.delete(targetUserId); }, 5 * 60000);
}
function getInvite(targetUserId) { return pendingInvites.get(targetUserId) || null; }
function deleteInvite(targetUserId) { pendingInvites.delete(targetUserId); }

async function inviteMember(inviterId, targetUserId) {
  const inviterGang = await getUserGang(inviterId);
  if (!inviterGang) return { success: false, reason: "You're not in a gang." };
  if (inviterGang.membership.role === "member") return { success: false, reason: "Only leaders/officers can invite members." };

  const targetGang = await getUserGang(targetUserId);
  if (targetGang) return { success: false, reason: "That user is already in a gang." };

  createInvite(targetUserId, inviterGang.gang.id, inviterGang.gang.name, inviterId);
  return { success: true, gang: inviterGang.gang };
}

async function acceptInvite(userId) {
  const invite = getInvite(userId);
  if (!invite) return { success: false, reason: "You have no pending gang invite (or it expired)." };
  const already = await getUserGang(userId);
  if (already) { deleteInvite(userId); return { success: false, reason: "You're already in a gang." }; }

  const { error } = await supabase.from("gang_members").insert({ gang_id: invite.gangId, user_id: userId, role: "member" });
  if (error) { console.error("[GANG ACCEPT]", error.message); return { success: false, reason: "Database error: " + error.message }; }
  deleteInvite(userId);
  const gang = await getGangById(invite.gangId);
  return { success: true, gang };
}

async function leaveGang(userId) {
  const ug = await getUserGang(userId);
  if (!ug) return { success: false, reason: "You're not in a gang." };
  if (ug.membership.role === "leader") {
    const members = await getMembers(ug.gang.id);
    if (members.length > 1) return { success: false, reason: "You're the leader — promote someone else or use **Cosa gang disband** first." };
  }
  const { error } = await supabase.from("gang_members").delete().eq("gang_id", ug.gang.id).eq("user_id", userId);
  if (error) { console.error("[GANG LEAVE]", error.message); return { success: false, reason: error.message }; }

  // Sole member leaving = gang auto-disbands
  const remaining = await getMembers(ug.gang.id);
  if (remaining.length === 0) await supabase.from("gangs").delete().eq("id", ug.gang.id);

  return { success: true, gang: ug.gang };
}

async function kickMember(actorId, targetUserId) {
  const actorGang = await getUserGang(actorId);
  if (!actorGang) return { success: false, reason: "You're not in a gang." };
  if (actorGang.membership.role === "member") return { success: false, reason: "Only leaders/officers can kick." };
  if (targetUserId === actorId) return { success: false, reason: "You can't kick yourself — use **Cosa gang leave**." };

  const targetGang = await getUserGang(targetUserId);
  if (!targetGang || targetGang.gang.id !== actorGang.gang.id) return { success: false, reason: "That user isn't in your gang." };
  if (targetGang.membership.role === "leader") return { success: false, reason: "You can't kick the leader." };

  const { error } = await supabase.from("gang_members").delete().eq("gang_id", actorGang.gang.id).eq("user_id", targetUserId);
  if (error) { console.error("[GANG KICK]", error.message); return { success: false, reason: error.message }; }
  return { success: true, gang: actorGang.gang };
}

async function promoteMember(actorId, targetUserId, newRole) {
  if (!["officer", "member"].includes(newRole)) return { success: false, reason: "Invalid role." };
  const actorGang = await getUserGang(actorId);
  if (!actorGang || actorGang.membership.role !== "leader") return { success: false, reason: "Only the gang leader can change ranks." };

  const targetGang = await getUserGang(targetUserId);
  if (!targetGang || targetGang.gang.id !== actorGang.gang.id) return { success: false, reason: "That user isn't in your gang." };

  const { error } = await supabase.from("gang_members").update({ role: newRole }).eq("gang_id", actorGang.gang.id).eq("user_id", targetUserId);
  if (error) { console.error("[GANG PROMOTE]", error.message); return { success: false, reason: error.message }; }
  return { success: true };
}

// Transfer leadership (needed before old leader can leave/step down)
async function transferLeadership(actorId, targetUserId) {
  const actorGang = await getUserGang(actorId);
  if (!actorGang || actorGang.membership.role !== "leader") return { success: false, reason: "Only the current leader can transfer leadership." };
  const targetGang = await getUserGang(targetUserId);
  if (!targetGang || targetGang.gang.id !== actorGang.gang.id) return { success: false, reason: "That user isn't in your gang." };

  await supabase.from("gang_members").update({ role: "leader" }).eq("gang_id", actorGang.gang.id).eq("user_id", targetUserId);
  await supabase.from("gang_members").update({ role: "officer" }).eq("gang_id", actorGang.gang.id).eq("user_id", actorId);
  await supabase.from("gangs").update({ leader_id: targetUserId }).eq("id", actorGang.gang.id);
  return { success: true };
}

// ── Gang treasury (shared pool — turf income, business income, member deposits) ─
async function addToGangTreasury(gangId, amount) {
  const gang = await getGangById(gangId);
  if (!gang) return null;
  const { data, error } = await supabase.from("gangs").update({ treasury: gang.treasury + Math.floor(amount) }).eq("id", gangId).select().maybeSingle();
  if (error) { console.error("[GANG TREASURY ADD]", error.message); return null; }
  return data;
}

async function deductFromGangTreasury(gangId, amount) {
  const gang = await getGangById(gangId);
  if (!gang || gang.treasury < amount) return null;
  const { data, error } = await supabase.from("gangs").update({ treasury: gang.treasury - Math.floor(amount) }).eq("id", gangId).select().maybeSingle();
  if (error) { console.error("[GANG TREASURY DEDUCT]", error.message); return null; }
  return data;
}

async function depositToGang(userId, amount, deductFromWallet) {
  const ug = await getUserGang(userId);
  if (!ug) return { success: false, reason: "You're not in a gang." };
  const deducted = await deductFromWallet(userId, amount);
  if (!deducted) return { success: false, reason: "Insufficient funds." };
  const updated = await addToGangTreasury(ug.gang.id, amount);
  return { success: true, gang: updated };
}

// ── Leader treasury withdrawal — once every 3 days per gang ────────────────
const WITHDRAW_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const withdrawCooldowns = new Map(); // gangId -> timestamp of last withdrawal

function getWithdrawCooldownRemaining(gangId) {
  const last = withdrawCooldowns.get(gangId) || 0;
  return Math.max(0, WITHDRAW_COOLDOWN_MS - (Date.now() - last));
}

async function withdrawFromTreasury(userId, amount, addCopper) {
  const ug = await getUserGang(userId);
  if (!ug) return { success: false, reason: "You're not in a gang." };
  if (ug.membership.role !== "leader") return { success: false, reason: "Only the gang leader can withdraw from the treasury." };
  if (!amount || amount <= 0) return { success: false, reason: "Withdrawal amount must be positive." };

  const remaining = getWithdrawCooldownRemaining(ug.gang.id);
  if (remaining > 0) {
    const hrs = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    return { success: false, reason: `The treasury was already tapped recently — try again in **${hrs}h ${mins}m**.` };
  }

  const updated = await deductFromGangTreasury(ug.gang.id, amount);
  if (!updated) return { success: false, reason: "The treasury doesn't have that much Cash." };

  withdrawCooldowns.set(ug.gang.id, Date.now());
  if (addCopper) await addCopper(userId, amount);
  return { success: true, gang: updated, amount };
}

// Returns every gang row — used by the Commission system to rank gangs.
async function getAllGangs() {
  const { data, error } = await supabase.from("gangs").select("*");
  if (error) { console.error("[GANG LIST ALL]", error.message); return []; }
  return data || [];
}

// ── Gang flag colors ─────────────────────────────────────────────────────────
// Every gang gets a colored flag emoji, assigned deterministically from its
// own id — no new DB column or migration needed, existing gangs get one
// automatically the moment this is deployed since it's computed on the fly
// rather than stored. Two gangs can land on the same color if the palette's
// exhausted, which is an acceptable tradeoff for not needing a schema change.
const FLAG_PALETTE = ["🟥", "🟧", "🟨", "🟩", "🟦", "🟪", "🟫", "⬛", "⬜"];
function getGangFlag(gangId) {
  let hash = 0;
  const str = String(gangId || "");
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return FLAG_PALETTE[Math.abs(hash) % FLAG_PALETTE.length];
}

function formatGangCard(gang, members) {
  const leader = members.find(m => m.role === "leader");
  const officers = members.filter(m => m.role === "officer");
  const rank = members.filter(m => m.role === "member");
  let out = `${getGangFlag(gang.id)} 🕴️ **${gang.name}**\n`;
  out += `💰 Treasury: ${fmt(gang.treasury)} Cash\n`;
  out += `👑 Leader: <@${leader ? leader.user_id : gang.leader_id}>\n`;
  if (officers.length) out += `⭐ Officers: ${officers.map(o => `<@${o.user_id}>`).join(", ")}\n`;
  out += `👥 Members (${members.length}): ${rank.map(m => `<@${m.user_id}>`).join(", ") || "—"}`;
  return out;
}

// Ranks every gang by treasury (the plain, guild-independent measure of a
// gang's strength — turf itself is now per-server, so it's left out of this
// global ranking and shown separately where relevant, e.g. the Commission).
async function getGangLeaderboard() {
  const all = await getAllGangs();
  return all.sort((a, b) => (b.treasury || 0) - (a.treasury || 0));
}

function formatGangLeaderboard(list) {
  if (!list.length) return "🏴 No gangs exist yet.";
  return list.slice(0, 15).map((g, i) =>
    `**#${i + 1}** ${getGangFlag(g.id)} **${g.name}** — 💵 ${fmt(g.treasury || 0)} Cash`
  ).join("\n");
}

// ── Bribes (rival gang leaders poaching members) ────────────────────────────
// A gang leader can pay a RIVAL gang's regular member (not their leader —
// leadership has to change hands the normal way first) straight Cash to
// jump ship immediately. Simple and instant: pay them, they leave their old
// gang (auto-disbanding it if they were the last member), and join yours.
async function offerBribe(actorId, targetUserId, amount, deductFromWallet, addCopper) {
  if (!amount || amount <= 0) return { success: false, reason: "Bribe amount must be positive." };
  if (targetUserId === actorId) return { success: false, reason: "You can't bribe yourself." };

  const actorGang = await getUserGang(actorId);
  if (!actorGang) return { success: false, reason: "You're not in a gang." };
  if (actorGang.membership.role !== "leader") return { success: false, reason: "Only the gang leader can offer a bribe." };

  const targetGang = await getUserGang(targetUserId);
  if (!targetGang) return { success: false, reason: "That user isn't in a gang." };
  if (targetGang.gang.id === actorGang.gang.id) return { success: false, reason: "They're already in your gang." };
  if (targetGang.membership.role === "leader") return { success: false, reason: "You can't bribe a gang leader away — they'd have to transfer leadership first." };

  const deducted = await deductFromWallet(actorId, amount);
  if (!deducted) return { success: false, reason: "Insufficient funds to offer that bribe." };

  const oldGangId = targetGang.gang.id;
  const oldGangName = targetGang.gang.name;

  const { error: leaveError } = await supabase.from("gang_members").delete().eq("gang_id", oldGangId).eq("user_id", targetUserId);
  if (leaveError) {
    console.error("[BRIBE LEAVE]", leaveError.message);
    await addCopper(actorId, amount); // refund — the move failed, don't just eat their Cash
    return { success: false, reason: "Database error moving them over — refunded. " + leaveError.message };
  }

  const remaining = await getMembers(oldGangId);
  if (remaining.length === 0) await supabase.from("gangs").delete().eq("id", oldGangId);

  const { error: joinError } = await supabase.from("gang_members").insert({ gang_id: actorGang.gang.id, user_id: targetUserId, role: "member" });
  if (joinError) {
    console.error("[BRIBE JOIN]", joinError.message);
    await addCopper(actorId, amount); // refund — they didn't actually end up in your gang
    return { success: false, reason: "Database error moving them over — refunded. " + joinError.message };
  }

  await addCopper(targetUserId, amount);

  return { success: true, amount, oldGangName, newGangName: actorGang.gang.name, targetGang: targetGang.gang, actorGang: actorGang.gang };
}

module.exports = {
  initGangs, createGang, disbandGang, getUserGang, getGangById, getGangByName, getMembers,
  inviteMember, acceptInvite, getInvite, deleteInvite, leaveGang, kickMember, promoteMember, transferLeadership,
  addToGangTreasury, deductFromGangTreasury, depositToGang, formatGangCard,
  withdrawFromTreasury, getWithdrawCooldownRemaining, WITHDRAW_COOLDOWN_MS, getAllGangs,
  getGangFlag, getGangLeaderboard, formatGangLeaderboard,
  offerBribe,
};
