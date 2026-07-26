const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const gangs = require("./gangs");
const turf = require("./turf");
const eco = require("./economy");

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

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000; // weekly
const TARGET_SIZE = 3;                    // normal Commission size
const MAX_SIZE = 5;                       // hard cap even if TARGET_SIZE is raised later
const SPLIT_RATIOS = [0.5, 0.3, 0.2];     // by Commission rank #1/#2/#3 — only as many as exist

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

function freshState(members, carryTaxKey) {
  return {
    cycleStartAt: Date.now(),
    cycleEndAt: Date.now() + CYCLE_MS,
    members,                              // [{ gangId, gangName }], ranked #1 first
    votes: {},                             // gangId -> taxKey
    activeTaxKey: carryTaxKey || DEFAULT_TAX_KEY, // stays in effect until THIS cycle resolves its own vote
    pot: 0,
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

// Starts a brand-new cycle from scratch (first-ever boot, or state got wiped).
async function startNewCycle() {
  const members = await pickCommissionMembers();
  const state = freshState(members);
  await saveState(state);
  await refreshCachedTaxRate();
  return state;
}

// Resolves the current cycle's vote, pays out the pot, and starts the next
// cycle. Returns a summary object for the announcement message, or null if
// there was no active cycle to end.
async function endCycleAndPayout() {
  const state = await getState();
  if (!state) return null;

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

  // Payout — 50/30/20 by Commission rank. A gang that disbanded mid-cycle
  // (getGangById returns null) simply forfeits its share.
  const payouts = [];
  if (state.pot > 0) {
    for (let i = 0; i < state.members.length && i < SPLIT_RATIOS.length; i++) {
      const member = state.members[i];
      const gang = await gangs.getGangById(member.gangId);
      if (!gang) { payouts.push({ ...member, amount: 0, forfeited: true }); continue; }
      const share = Math.floor(state.pot * SPLIT_RATIOS[i]);
      if (share > 0) await gangs.addToGangTreasury(member.gangId, share);
      payouts.push({ ...member, amount: share, forfeited: false });
    }
  }

  const summary = { previousMembers: state.members, payouts, resolvedTaxKey, pot: state.pot };

  // Start the next cycle immediately, carrying the resolved tax rate forward
  // as the baseline until this new cycle resolves its own vote.
  const members = await pickCommissionMembers();
  const newState = freshState(members, resolvedTaxKey);
  await saveState(newState);
  await refreshCachedTaxRate();

  return summary;
}

// Call this periodically (e.g. hourly) — a cheap no-op if the cycle isn't
// over yet. Returns a payout summary only on the tick where a cycle actually
// rolled over (for announcing), otherwise null.
async function checkCycleRollover() {
  let state = await getState();
  if (!state) { await startNewCycle(); return null; }
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
  const ug = await gangs.getUserGang(userId);
  if (!ug || ug.membership.role !== "leader") return { success: false, reason: "Only a gang leader can vote on Commission policy." };
  const isMember = state.members.some(m => m.gangId === ug.gang.id);
  if (!isMember) return { success: false, reason: "Your gang isn't on the Commission this cycle." };

  state.votes[ug.gang.id] = taxKey;
  await saveState(state);
  return { success: true, gangName: ug.gang.name, taxKey };
}

function formatCommissionStatus(state) {
  if (!state) return "🕴️ The Commission hasn't convened yet.";
  const lines = state.members.map((m, i) => {
    const voted = state.votes[m.gangId];
    return `**#${i + 1}** ${m.gangName}${voted ? ` — voted **${TAX_CHOICES[voted].label}**` : " — hasn't voted yet"}`;
  });
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
    (lines.length ? lines.join("\n") : "*No gangs held a seat this cycle.*") +
    `\n\n*A new Commission has convened based on current standings.*`
  );
}

module.exports = {
  initCommission, TAX_CHOICES, DEFAULT_TAX_KEY, CYCLE_MS,
  getState, startNewCycle, checkCycleRollover, endCycleAndPayout,
  castVote, addToPot, getActiveTaxRate, refreshCachedTaxRate,
  formatCommissionStatus, formatPayoutSummary, rankGangs,
};
