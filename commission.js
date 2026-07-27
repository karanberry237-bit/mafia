const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const gangs = require("./gangs");
const turf = require("./turf");
const eco = require("./economy");
const rivalnpc = require("./rivalnpc");

// ── The Commission ───────────────────────────────────────────────────────────
// The top gangs (ranked by treasury + turf held) get a seat on the Commission
// each cycle. Their leaders vote on a server-wide tax rate that applies to
// BOTH business income (collected via businesses.collectBusiness) and
// gambling losses (the "house cut" that normally flows entirely to the Don).
// All tax collected during the cycle accumulates in a shared pot, split
// 50/30/20 among the Commission's #1/#2/#3 gangs (by rank) when the cycle
// ends. A new cycle then locks in based on the current standings.
//
// Persisted as a single JSON blob in the existing empire_data table (key
// "commission_state") — no new table/migration needed.
//
// Voting eligibility is checked live against gangs.getUserGang() at vote time,
// not snapshotted — so if a gang's leader changes mid-cycle (new Don/leader
// via gangs.transferLeadership), the new leader automatically inherits voting
// rights with zero extra bookkeeping.
//
// If a Commission member gang disbands mid-cycle, its seat just goes empty —
// no replacement is pulled in, and its share of the pot at payout time is
// simply forfeited (not redistributed to the remaining members).

const CYCLE_MS = 3 * 24 * 60 * 60 * 1000; // every 3 days
const VOTE_WINDOW_MS = 10 * 60 * 1000;    // 10 minutes to vote once a cycle convenes
const TARGET_SIZE = 3;                    // normal Commission size
const MAX_SIZE = 5;                       // hard cap even if TARGET_SIZE is raised later
// Payout split by Commission rank, keyed by how many members are actually
// seated that cycle (fewer gangs on the server = fewer seats = a different
// split table, not just truncating the 5-seat one).
const SPLIT_TABLES = {
  1: [1],
  2: [0.60, 0.40],
  3: [0.50, 0.30, 0.20],
  4: [0.40, 0.28, 0.20, 0.12],
  5: [0.35, 0.25, 0.18, 0.13, 0.09],
};

const TAX_CHOICES = {
  low:    { key: "low",    label: "5% — Light Touch",   rate: 0.05 },
  medium: { key: "medium", label: "10% — Standard Cut", rate: 0.10 },
  high:   { key: "high",   label: "15% — Heavy Skim",   rate: 0.15 },
};
const DEFAULT_TAX_KEY = "low";
const STATE_KEY = "commission_state";

let supabase;
function initCommission(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  refreshCachedTaxRate().catch(() => {});
  console.log("🕴️ Commission system initialized");
}

function freshState(members, carryTaxKey, carryPot = 0) {
  return {
    dormant: false,
    cycleStartAt: Date.now(),
    cycleEndAt: Date.now() + CYCLE_MS,
    voteDeadline: Date.now() + VOTE_WINDOW_MS, // gang leaders have this long to vote before it auto-resolves
    members,                              // [{ gangId, gangName }], ranked #1 first
    votes: {},                             // gangId -> taxKey
    activeTaxKey: carryTaxKey || DEFAULT_TAX_KEY, // stays in effect until THIS cycle resolves its own vote
    pot: carryPot || 0,
  };
}

// The quiet stretch between cycles — the tax rate is locked in, no seats are
// held, and nothing convenes again until nextConveneAt. Tax collected here
// (business income + gambling cuts) still piles into `pot` via addToPot(),
// carrying forward into whichever gangs actually hold a seat next cycle.
function dormantState(taxKey, carryPot, nextConveneAt) {
  return {
    dormant: true,
    activeTaxKey: taxKey || DEFAULT_TAX_KEY,
    pot: carryPot || 0,
    nextConveneAt,
  };
}

async function getState() {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", STATE_KEY).maybeSingle();
  if (error) { console.error("[COMMISSION GET STATE]", error.message); return null; }
  return data?.value || null;
}

async function saveState(state) {
  const { error } = await supabase.from("empire_data").upsert({ key: STATE_KEY, value: state }, { onConflict: "key" });
  if (error) console.error("[COMMISSION SAVE STATE]", error.message);
}

// Ranks every gang by treasury + turf held (each controlled zone counts as a
// flat Cash-equivalent bonus toward rank, so turf actually matters here too).
const TURF_RANK_WEIGHT = 200000;
async function rankGangs() {
  const allGangs = await gangs.getAllGangs();
  const zones = await turf.getAllZones();
  const turfCountByGang = new Map();
  for (const z of zones) {
    if (!z.controller_gang_id) continue;
    turfCountByGang.set(z.controller_gang_id, (turfCountByGang.get(z.controller_gang_id) || 0) + 1);
  }
  return allGangs
    .map(g => ({ gangId: g.id, gangName: g.name, score: (g.treasury || 0) + (turfCountByGang.get(g.id) || 0) * TURF_RANK_WEIGHT }))
    .sort((a, b) => b.score - a.score);
}

async function pickCommissionMembers() {
  const ranked = await rankGangs();
  const size = Math.min(TARGET_SIZE, MAX_SIZE, ranked.length);
  return ranked.slice(0, size).map(g => ({ gangId: g.gangId, gangName: g.gangName }));
}

// The Barzinis are an NPC gang and can never have a real leader casting a
// vote — their "leader" is a sentinel ID no Discord account can ever match,
// so a Barzini-held seat would otherwise sit permanently silent. That makes
// a no-votes/abstain outcome far more likely than it should be, especially
// on smaller servers where they're likely to hold a seat often. So if they
// land a seat, their vote is auto-cast for them — always pushing for the
// heaviest tax rate, since a rival crime family has no reason to be generous
// to the rest of the server's economy.
function applyNpcAutoVotes(state) {
  for (const member of state.members) {
    if (member.gangName === rivalnpc.BARZINI_NAME) {
      state.votes[member.gangId] = "high";
    }
  }
}

// Call this ~10 minutes after a cycle convenes (scheduled per-cycle by the
// caller, keyed off cycleStartAt). Resolves the cycle with whatever votes
// were cast in that window — same tally/abstain rules as any other
// resolution path. Safe to call even if the cycle already resolved some
// other way (vote completion, meeting, force-vote, or the 3-day timer) —
// expectedCycleStartAt guards against double-resolving a cycle that's
// already moved on.
async function checkVoteWindowExpiry(expectedCycleStartAt) {
  const state = await getState();
  if (!state || state.dormant) return null;
  if (state.cycleStartAt !== expectedCycleStartAt) return null; // this cycle already resolved and a new one is in progress
  if (Date.now() < (state.voteDeadline || 0)) return null; // window hasn't closed yet
  return await endCycleAndPayout();
}

// Starts a brand-new cycle from scratch (first-ever boot, or state got wiped).
async function startNewCycle() {
  const members = await pickCommissionMembers();
  const state = freshState(members);
  applyNpcAutoVotes(state);
  await saveState(state);
  await refreshCachedTaxRate();
  return state;
}

// Resolves the current cycle's vote, pays out the pot, and starts the next
// cycle. Returns a summary object for the announcement message, or null if
// there was no active cycle to end.
async function endCycleAndPayout() {
  const state = await getState();
  if (!state || state.dormant) return null; // nothing active to resolve
  pendingMeeting = null; // any in-flight meeting is moot once the cycle actually resolves

  // Resolve vote: majority among CAST votes wins; a tie (or nobody voted)
  // means abstain — the tax rate carries over unchanged.
  const tally = new Map();
  for (const taxKey of Object.values(state.votes)) {
    tally.set(taxKey, (tally.get(taxKey) || 0) + 1);
  }
  let resolvedTaxKey = state.activeTaxKey;
  if (tally.size > 0) {
    const maxVotes = Math.max(...tally.values());
    const winners = [...tally.entries()].filter(([, c]) => c === maxVotes);
    if (winners.length === 1) resolvedTaxKey = winners[0][0];
    // else: genuine tie among the top choices -> abstain, keep previous rate
  }

  // Payout — split table matches however many seats were actually filled
  // this cycle. A gang that disbanded mid-cycle (getGangById returns null)
  // simply forfeits its share. Seated gangs are listed here even when the
  // pot is empty (share = 0) — an empty pot isn't the same thing as no
  // gangs holding a seat, and the summary should say so correctly.
  const payouts = [];
  const ratios = SPLIT_TABLES[state.members.length] || SPLIT_TABLES[MAX_SIZE];
  for (let i = 0; i < state.members.length && i < ratios.length; i++) {
    const member = state.members[i];
    const gang = await gangs.getGangById(member.gangId);
    if (!gang) { payouts.push({ ...member, amount: 0, forfeited: true }); continue; }
    const share = state.pot > 0 ? Math.floor(state.pot * ratios[i]) : 0;
    if (share > 0) await gangs.addToGangTreasury(member.gangId, share);
    payouts.push({ ...member, amount: share, forfeited: false });
  }

  const summary = { previousMembers: state.members, payouts, resolvedTaxKey, pot: state.pot };

  // Go dormant for the rest of the full 3-day cycle — NO new voting session
  // starts right now, no matter how this one resolved (full real-gang vote,
  // meeting, force-vote, or the 3-day timer itself). This is the behavior
  // that was actually broken before: a new cycle used to reconvene
  // immediately after every resolution, so a fully-voted or forced
  // resolution looked like it was looping straight back into another vote
  // instead of the resolved tax rate just holding quietly for the full 3
  // days. Any tax collected while dormant keeps accumulating in `pot` via
  // addToPot() and carries forward into the gangs that hold a seat next
  // cycle. checkCycleRollover is what actually reconvenes things once
  // nextConveneAt arrives.
  const next = dormantState(resolvedTaxKey, 0, Date.now() + CYCLE_MS);
  await saveState(next);
  await refreshCachedTaxRate();

  summary.newState = null; // nothing convenes right now — see checkCycleRollover
  return summary;
}

// Call this periodically (e.g. hourly) — a cheap no-op if nothing's due yet.
// Returns { previousMembers, payouts, resolvedTaxKey, pot, newState: null }
// when a live cycle's timer just expired (goes dormant — see
// endCycleAndPayout), { newState } when a dormant period just ended and a
// fresh cycle convened (or on the very first cycle ever, nothing to resolve
// yet), or null if nothing happened this tick.
async function checkCycleRollover() {
  let state = await getState();
  if (!state) {
    const newState = await startNewCycle();
    return { newState };
  }
  if (state.dormant) {
    if (Date.now() < state.nextConveneAt) return null; // still resting between cycles
    const members = await pickCommissionMembers();
    const newState = freshState(members, state.activeTaxKey, state.pot);
    applyNpcAutoVotes(newState);
    await saveState(newState);
    await refreshCachedTaxRate();
    return { newState };
  }
  if (Date.now() < state.cycleEndAt) return null;
  return await endCycleAndPayout();
}

// ── Active tax rate (cached in memory) ──────────────────────────────────────
// Gambling's house-cut fires synchronously and often — no DB round trip on
// every spin. The cache is refreshed whenever the active rate could have
// changed (init + every cycle rollover).
let cachedTaxRate = TAX_CHOICES[DEFAULT_TAX_KEY].rate;
async function refreshCachedTaxRate() {
  const state = await getState();
  const key = state?.activeTaxKey || DEFAULT_TAX_KEY;
  cachedTaxRate = (TAX_CHOICES[key] || TAX_CHOICES[DEFAULT_TAX_KEY]).rate;
}
function getActiveTaxRate() {
  return cachedTaxRate;
}

async function addToPot(amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return;
  const state = await getState();
  if (!state) return;
  state.pot = (state.pot || 0) + amount;
  await saveState(state);
}

// Only the CURRENT leader of a Commission-member gang can vote — checked live
// each time, so leadership changes (new Don/leader) just work automatically.
async function castVote(userId, taxKey) {
  if (!TAX_CHOICES[taxKey]) return { success: false, reason: "Invalid tax choice." };
  const state = await getState();
  if (!state) return { success: false, reason: "The Commission hasn't convened yet." };
  if (state.dormant) return { success: false, reason: `The Commission isn't in session right now — it reconvenes in ${formatCountdown(state.nextConveneAt)}.` };
  const ug = await gangs.getUserGang(userId);
  if (!ug || ug.membership.role !== "leader") return { success: false, reason: "Only a gang leader can vote on Commission policy." };
  const isMember = state.members.some(m => m.gangId === ug.gang.id);
  if (!isMember) return { success: false, reason: "Your gang isn't on the Commission this cycle." };

  state.votes[ug.gang.id] = taxKey;
  await saveState(state);

  // Early-resolve once every REAL (non-Barzini) gang leader has voted — but
  // only real votes count toward that check. The Barzinis auto-cast their
  // vote the instant a cycle convenes, so counting their vote toward "has
  // everyone voted" meant a single real gang's vote could look like full
  // participation and instantly end + reconvene the cycle, over and over
  // (the original loop bug). Requiring every REAL seat specifically fixes
  // that: the Barzinis' seat, if they have one, no longer counts as "already
  // voted" for this check, so this only fires once actual gang leaders have
  // all weighed in.
  const realMemberIds = state.members.filter(m => m.gangName !== rivalnpc.BARZINI_NAME).map(m => m.gangId);
  const allRealVoted = realMemberIds.length > 0 && realMemberIds.every(id => Object.prototype.hasOwnProperty.call(state.votes, id));
  if (allRealVoted) {
    const summary = await endCycleAndPayout();
    return { success: true, gangName: ug.gang.name, taxKey, autoResolved: true, summary };
  }

  return { success: true, gangName: ug.gang.name, taxKey, autoResolved: false };
}

function formatCountdown(targetMs) {
  const ms = Math.max(0, (targetMs || 0) - Date.now());
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hrs}h ${mins}m`;
}

async function formatCommissionStatus(state) {
  if (!state) return "🕴️ The Commission hasn't convened yet.";
  if (state.dormant) {
    const activeLabel = (TAX_CHOICES[state.activeTaxKey] || TAX_CHOICES[DEFAULT_TAX_KEY]).label;
    return (
      `🕴️ **THE COMMISSION**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `The Commission isn't in session — locked-in tax rate *(business + gambling)*: **${activeLabel}**\n` +
      `Pot building for next cycle: **💵 ${eco.fmt(state.pot || 0)} Cash**\n` +
      `Reconvenes in **${formatCountdown(state.nextConveneAt)}**.`
    );
  }
  const lines = [];
  for (let i = 0; i < state.members.length; i++) {
    const m = state.members[i];
    const voted = state.votes[m.gangId];
    lines.push(`**#${i + 1}** ${m.gangName}${voted ? ` — voted **${TAX_CHOICES[voted].label}**` : " — hasn't voted yet"}`);
    if (m.gangName !== rivalnpc.BARZINI_NAME) {
      const gang = await gangs.getGangById(m.gangId);
      const members = await gangs.getMembers(m.gangId);
      const rest = members.filter(mem => mem.user_id !== gang?.leader_id);
      if (rest.length) lines.push(`　└ ${rest.map(mem => `<@${mem.user_id}>`).join(", ")}`);
    }
  }
  const activeLabel = (TAX_CHOICES[state.activeTaxKey] || TAX_CHOICES[DEFAULT_TAX_KEY]).label;
  const timeLeft = Math.max(0, state.cycleEndAt - Date.now());
  const daysLeft = (timeLeft / 86400000).toFixed(1);
  return (
    `🕴️ **THE COMMISSION**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Active tax rate *(business + gambling)*: **${activeLabel}**\n` +
    `Pot this cycle: **💵 ${eco.fmt(state.pot || 0)} Cash**\n` +
    `Cycle ends in **${daysLeft}d**\n\n` +
    (lines.length ? lines.join("\n") : "*No gangs currently qualify for a seat.*")
  );
}

// ── Dramatic closing line ────────────────────────────────────────────────────
// A flavor-text sting posted to general right after a cycle's payout summary,
// separate from the plain numbers — gives the resolution some theater.
const DRAMATIC_LINES = [
  "The smoke clears from the back room. Deals were made, promises were broken, and the ledgers have been settled — for now.",
  "Gavel down. The old arrangement is dead; a new one takes its place before the ink even dries.",
  "Handshakes all around the table — the kind that mean absolutely nothing until the next envelope changes hands.",
  "The pot's been split, the grudges noted, and the families go back to watching each other's every move.",
  "Another sit-down survived without bloodshed. Whether that lasts until the next cycle is anyone's guess.",
  "The books are closed on this cycle. Somewhere, a gang that came up short is already planning its next move.",
];

function getDramaticClosingLine(summary) {
  const line = DRAMATIC_LINES[Math.floor(Math.random() * DRAMATIC_LINES.length)];
  const topPayout = summary?.payouts?.find(p => !p.forfeited && p.amount > 0);
  const topLine = topPayout ? `\n**${topPayout.gangName}** walks away the biggest winner this cycle.` : "";
  return `🥃 *${line}*${topLine}`;
}

function formatPayoutSummary(summary) {
  if (!summary) return null;
  const taxLabel = (TAX_CHOICES[summary.resolvedTaxKey] || TAX_CHOICES[DEFAULT_TAX_KEY]).label;
  const lines = summary.payouts.map((p, i) =>
    p.forfeited
      ? `**#${i + 1}** ${p.gangName} — *disbanded, share forfeited*`
      : `**#${i + 1}** ${p.gangName} — 💵 ${eco.fmt(p.amount)} Cash`
  );
  return (
    `🕴️ **THE COMMISSION CYCLE HAS ENDED**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Pot collected: **💵 ${eco.fmt(summary.pot)} Cash**\n` +
    `Resolved tax rate going forward: **${taxLabel}**\n\n` +
    (lines.length ? lines.join("\n") : "*No gangs held a seat this cycle.*")
  );
}

// Announces a freshly-seated Commission and actually pings each seated
// gang's current leader (fetched live, not from any stored snapshot, so a
// mid-cycle leadership change is still reflected correctly here). The
// Barzinis never get a ping — there's no real Discord account behind their
// "leader" — and their auto-cast vote is noted instead.
async function formatConvenedAnnouncement(state) {
  if (!state) return null;
  const lines = [];
  for (const m of state.members) {
    if (m.gangName === rivalnpc.BARZINI_NAME) {
      lines.push(`**${m.gangName}** — a rival family with no leader to summon (already cast their vote).`);
      continue;
    }
    const gang = await gangs.getGangById(m.gangId);
    const leaderMention = gang?.leader_id ? `<@${gang.leader_id}>` : "*(unknown leader)*";
    lines.push(`**${m.gangName}** — ${leaderMention}`);

    // List the rest of the gang below its leader so the whole crew sees
    // they've got a seat at the table this cycle, not just the leader.
    const members = await gangs.getMembers(m.gangId);
    const rest = members.filter(mem => mem.user_id !== gang?.leader_id);
    if (rest.length) {
      lines.push(`　└ ${rest.map(mem => `<@${mem.user_id}>`).join(", ")}`);
    }
  }
  const daysLeft = Math.max(0, (state.cycleEndAt - Date.now()) / 86400000).toFixed(1);
  return (
    `🕴️ **THE COMMISSION HAS CONVENED**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    (lines.length ? lines.join("\n") : "*No gangs currently qualify for a seat.*") +
    `\n\n⏱️ You have **10 minutes** to vote with **/commission vote** — after that, the vote resolves automatically ` +
    `with whatever's been cast (majority wins; a tie or no votes carries the current rate forward). ` +
    `Cycle otherwise closes in **${daysLeft}d** ` +
    `(or sooner via **/commission call-meeting**, or the Don's **/commission force-vote**).`
  );
}

// ── Call a meeting ───────────────────────────────────────────────────────────
// Any current Commission leader can call an early vote instead of waiting out
// the full cycle. Calling it counts as an automatic "yes" from their own
// gang. If a majority of the CURRENT Commission's members agree within the
// window, the cycle resolves immediately (same resolution path as a normal
// timer rollover or the Don's force-vote). If majority never arrives before
// the window closes, it just fizzles — the normal timer keeps running
// untouched. 3-day cooldown per gang (not per person), so a leadership
// change doesn't reset it.
const MEETING_WINDOW_MS = 60 * 60 * 1000;   // 1 hour to reach majority
const MEETING_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days per gang
const meetingCooldowns = new Map(); // gangId -> timestamp of last call
let pendingMeeting = null; // { calledByGangId, calledByGangName, acceptedGangIds: Set, expiresAt }

function majorityNeeded(memberCount) {
  return Math.floor(memberCount / 2) + 1;
}

function getMeetingCooldownRemaining(gangId) {
  const last = meetingCooldowns.get(gangId) || 0;
  return Math.max(0, MEETING_COOLDOWN_MS - (Date.now() - last));
}

function clearExpiredMeeting() {
  if (pendingMeeting && Date.now() > pendingMeeting.expiresAt) pendingMeeting = null;
}

function getMeetingStatus() {
  clearExpiredMeeting();
  return pendingMeeting;
}

async function callMeeting(userId) {
  clearExpiredMeeting();
  const state = await getState();
  if (!state) return { success: false, reason: "The Commission hasn't convened yet." };
  if (state.dormant) return { success: false, reason: `The Commission isn't in session right now — it reconvenes in ${formatCountdown(state.nextConveneAt)}.` };
  const ug = await gangs.getUserGang(userId);
  if (!ug || ug.membership.role !== "leader") return { success: false, reason: "Only a gang leader can call a Commission meeting." };
  const isMember = state.members.some(m => m.gangId === ug.gang.id);
  if (!isMember) return { success: false, reason: "Your gang isn't on the Commission this cycle." };
  if (pendingMeeting) return { success: false, reason: "A meeting is already in session — other Commission leaders can still accept it with **/commission accept-meeting**." };

  const remaining = getMeetingCooldownRemaining(ug.gang.id);
  if (remaining > 0) {
    const hrs = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    return { success: false, reason: `**${ug.gang.name}** already called a meeting recently — try again in **${hrs}h ${mins}m**.` };
  }

  meetingCooldowns.set(ug.gang.id, Date.now());
  pendingMeeting = {
    calledByGangId: ug.gang.id,
    calledByGangName: ug.gang.name,
    acceptedGangIds: new Set([ug.gang.id]),
    expiresAt: Date.now() + MEETING_WINDOW_MS,
  };

  const needed = majorityNeeded(state.members.length);
  if (pendingMeeting.acceptedGangIds.size >= needed) {
    const summary = await endCycleAndPayout();
    return { success: true, resolved: true, summary, gangName: ug.gang.name };
  }
  return { success: true, resolved: false, gangName: ug.gang.name, acceptedCount: pendingMeeting.acceptedGangIds.size, neededTotal: needed };
}

async function acceptMeeting(userId) {
  clearExpiredMeeting();
  if (!pendingMeeting) return { success: false, reason: "No Commission meeting is currently in session." };
  const state = await getState();
  if (!state) return { success: false, reason: "The Commission hasn't convened yet." };
  if (state.dormant) return { success: false, reason: `The Commission isn't in session right now — it reconvenes in ${formatCountdown(state.nextConveneAt)}.` };
  const ug = await gangs.getUserGang(userId);
  if (!ug || ug.membership.role !== "leader") return { success: false, reason: "Only a gang leader can respond to a Commission meeting." };
  const isMember = state.members.some(m => m.gangId === ug.gang.id);
  if (!isMember) return { success: false, reason: "Your gang isn't on the Commission this cycle." };

  pendingMeeting.acceptedGangIds.add(ug.gang.id);
  const needed = majorityNeeded(state.members.length);
  if (pendingMeeting.acceptedGangIds.size >= needed) {
    const summary = await endCycleAndPayout();
    return { success: true, resolved: true, summary, gangName: ug.gang.name };
  }
  return { success: true, resolved: false, gangName: ug.gang.name, acceptedCount: pendingMeeting.acceptedGangIds.size, neededTotal: needed };
}

function formatMeetingStatus() {
  const m = getMeetingStatus();
  if (!m) return "🕴️ No Commission meeting is currently in session.";
  const minsLeft = Math.max(0, Math.ceil((m.expiresAt - Date.now()) / 60000));
  return `🕴️ **${m.calledByGangName}** called a Commission meeting — **${m.acceptedGangIds.size}** gang(s) agreed so far. Closes in **${minsLeft}m** if majority isn't reached.`;
}

module.exports = {
  initCommission, TAX_CHOICES, DEFAULT_TAX_KEY, CYCLE_MS, VOTE_WINDOW_MS,
  getState, startNewCycle, checkCycleRollover, checkVoteWindowExpiry, endCycleAndPayout,
  castVote, addToPot, getActiveTaxRate, refreshCachedTaxRate,
  formatCommissionStatus, formatPayoutSummary, formatConvenedAnnouncement, getDramaticClosingLine, rankGangs,
  callMeeting, acceptMeeting, getMeetingStatus, formatMeetingStatus, getMeetingCooldownRemaining,
};
