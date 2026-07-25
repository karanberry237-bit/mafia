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

function formatGangCard(gang, members) {
  const leader = members.find(m => m.role === "leader");
  const officers = members.filter(m => m.role === "officer");
  const rank = members.filter(m => m.role === "member");
  let out = `🕴️ **${gang.name}**\n`;
  out += `💰 Treasury: ${fmt(gang.treasury)} Cash\n`;
  out += `👑 Leader: <@${leader ? leader.user_id : gang.leader_id}>\n`;
  if (officers.length) out += `⭐ Officers: ${officers.map(o => `<@${o.user_id}>`).join(", ")}\n`;
  out += `👥 Members (${members.length}): ${rank.map(m => `<@${m.user_id}>`).join(", ") || "—"}`;
  return out;
}

module.exports = {
  initGangs, createGang, disbandGang, getUserGang, getGangById, getGangByName, getMembers,
  inviteMember, acceptInvite, getInvite, deleteInvite, leaveGang, kickMember, promoteMember, transferLeadership,
  addToGangTreasury, deductFromGangTreasury, depositToGang, formatGangCard,
};
