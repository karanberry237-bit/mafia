const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

// ── Currency System ───────────────────────────────────────────────────────────
// Single flat currency: Cash. 1 is just 1 — no denominations, no conversion.
// `copper`/`silver`/`gold`/`stellar` remain the Supabase column names (renaming
// requires a migration), but only `copper` is ever used now. Old wallets that
// still have a balance sitting in silver/gold/stellar (from before the
// flatten) are folded into `copper` automatically the moment they're read —
// nobody's balance disappears, it just all becomes Cash going forward.
function formatWallet(wallet) {
  return `💵 ${fmt(Math.floor(wallet.copper || 0))} Cash`;
}

function walletToCopper(wallet) {
  return Math.floor(
    (wallet.copper  || 0) +
    (wallet.silver  || 0) * 100 +
    (wallet.gold    || 0) * 10000 +
    (wallet.stellar || 0) * 1000000
  );
}

function fromCopper(copper) {
  return { copper: Math.floor(copper), silver: 0, gold: 0, stellar: 0 };
}

function parseBet(amount) {
  if (amount === null || amount === undefined) return null;
  const str = String(amount).trim();
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(k|m|b)?$/i);
  if (!m) {
    // Fallback for plain ints that don't match the shorthand pattern
    const num = parseInt(str);
    return (!isNaN(num) && num > 0) ? num : null;
  }
  let num = parseFloat(m[1]);
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") num *= 1e3;
  else if (suffix === "m") num *= 1e6;
  else if (suffix === "b") num *= 1e9;
  num = Math.floor(num);
  return num > 0 ? num : null;
}

// ── Supabase Wallet Store ─────────────────────────────────────────────────────
let supabase;
function initEconomy(supabaseUrl, supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, { realtime: { transport: ws } });
    console.log("✅ Economy system initialized");
  } catch (e) {
    console.error("[ECONOMY] Init failed:", e.message);
  }
}

// ── Per-user wallet lock ──────────────────────────────────────────────────────
// addCopper/deductCopper/saveWallet all do a plain read-then-write with no
// atomicity — if two calls for the SAME user overlap (e.g. a spammed command,
// or a deliberate "claim daily twice via Second Wind" flow racing against
// itself), the second write can read a stale balance and silently clobber the
// first one's money. This serializes every wallet-mutating call per user so
// that can't happen, without needing any DB-level locking.
const userWalletLocks = new Map(); // userId -> chained Promise
function withUserLock(userId, fn) {
  const prev = userWalletLocks.get(userId) || Promise.resolve();
  const run = prev.then(fn, fn); // run fn regardless of whether the prior op succeeded
  userWalletLocks.set(userId, run.catch(() => {})); // keep the chain alive even on error
  return run;
}

async function getWallet(userId) {
  const empty = { user_id: userId, copper: 0, silver: 0, gold: 0, stellar: 0, last_daily: null, total_earned: 0, debt: 0 };
  if (!supabase) return empty;
  const { data, error } = await supabase.from("wallets").select("*").eq("user_id", userId);
  if (error) {
    console.error("[GET WALLET ERROR]", error.message);
    return empty;
  }
  if (!data || data.length === 0) return empty;
  // Flatten on read — a wallet with a leftover balance in silver/gold/stellar
  // from before the flatten shows up as Cash immediately, not just after its
  // next transaction.
  const w = data[0];
  return { ...w, copper: walletToCopper(w), silver: 0, gold: 0, stellar: 0 };
}

async function saveWallet(wallet) {
  if (!supabase) return;
  const { error } = await supabase.from("wallets").upsert(wallet, { onConflict: "user_id" });
  if (error) console.error("[SAVE WALLET]", error.message);
}

async function getDebt(userId) {
  const w = await getWallet(userId);
  return w.debt || 0;
}

async function addDebt(userId, amount) {
  try {
    const w = await getWallet(userId);
    const newW = { ...w, debt: (w.debt || 0) + amount };
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[ADD DEBT]", e.message); return null; }
}

async function payDebt(userId, amount) {
  try {
    const w = await getWallet(userId);
    const currentDebt = w.debt || 0;
    const pay = Math.min(amount, currentDebt);
    const newW = { ...w, debt: currentDebt - pay };
    // Also deduct from balance
    const totalCopper = walletToCopper(w);
    if (totalCopper < pay) return null;
    Object.assign(newW, fromCopper(totalCopper - pay));
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[PAY DEBT]", e.message); return null; }
}

function formatDebt(debt) {
  if (!debt || debt === 0) return null;
  return "🔴 **YOU OWE THE FAMILY: " + fmt(debt) + " Cash**";
}

async function addCopper(userId, copperAmount) {
  return withUserLock(userId, async () => {
    try {
      const w = await getWallet(userId);
      const total = walletToCopper(w) + copperAmount;
      const newW = { ...w, ...fromCopper(total), total_earned: (w.total_earned || 0) + Math.max(0, copperAmount) };
      await saveWallet(newW);
      return newW;
    } catch (e) { console.error("[ADD COPPER]", e.message); return null; }
  });
}

async function deductCopper(userId, copperAmount) {
  return withUserLock(userId, async () => {
    try {
      const w = await getWallet(userId);
      const total = walletToCopper(w);
      if (total < copperAmount) return null;
      const newW = { ...w, ...fromCopper(total - copperAmount) };
      await saveWallet(newW);
      return newW;
    } catch (e) { console.error("[DEDUCT COPPER]", e.message); return null; }
  });
}

// Atomically credits the daily reward AND stamps last_daily in ONE locked
// read-modify-write, instead of calling addCopper() then a separate
// saveWallet() for last_daily (two unlocked writes with a gap between them —
// exactly the kind of gap that let a Second-Wind-triggered second claim
// silently lose its money to a race in testing).
async function claimDaily(userId, copperAmount) {
  return withUserLock(userId, async () => {
    try {
      const w = await getWallet(userId);
      const total = walletToCopper(w) + copperAmount;
      const newW = {
        ...w,
        ...fromCopper(total),
        total_earned: (w.total_earned || 0) + Math.max(0, copperAmount),
        last_daily: new Date().toISOString(),
      };
      await saveWallet(newW);
      return newW;
    } catch (e) { console.error("[CLAIM DAILY]", e.message); return null; }
  });
}

// Bulk-clears last_daily for every wallet in one shot — used by the Don-only
// "reset economy cooldowns" command so everyone can claim their daily again
// right after a full economy wipe.
async function resetAllDailyCooldowns() {
  try {
    const { error } = await supabase.from("wallets").update({ last_daily: null }).not("user_id", "is", null);
    if (error) throw error;
    return true;
  } catch (e) { console.error("[RESET DAILY CD]", e.message); return false; }
}

async function getLeaderboard(limit = 10) {
  // Order by "copper" as a first-pass filter (cheap on the DB side), but pull
  // extra rows and re-sort in JS by TRUE current balance (walletToCopper —
  // flattens any legacy silver/gold/stellar left over from before the
  // currency flatten). Sorting by total_earned here was the bug: that's a
  // lifetime stat that drifts from current balance the moment someone
  // spends, gambles, or gets robbed, so the displayed order looked scrambled
  // even though the sort itself was "working."
  const { data, error } = await supabase.from("wallets").select("*").order("copper", { ascending: false }).limit(Math.max(limit * 5, 50));
  if (error) {
    console.error("[GET LEADERBOARD ERROR]", error.message);
    return [];
  }
  const sorted = (data || [])
    .map(w => ({ ...w, _balance: walletToCopper(w) }))
    .sort((a, b) => b._balance - a._balance)
    .slice(0, limit);
  return sorted;
}

// ── Daily Rewards by Rank ─────────────────────────────────────────────────────
// Mirrors the 10-tier Family ladder. Flat Cash amounts now (same effective
// values as the old tiered rewards, just no denominations to think in).
// Don Clint's cut is effectively bottomless.
const DAILY_REWARDS = {
  streetrat:   100,
  associate:   500,
  soldier:     1000,
  mademan:     3000,
  enforcer:    10000,
  capo:        100000,
  underboss:   200000,
  consigliere: 1000000,
  boss:        5000000,
  donclint:    999_000_000_000_000, // 999 Trillion — the Don doesn't do dailies, he does GDPs
};

function getDailyAmount(rankKey) {
  return DAILY_REWARDS[rankKey] || DAILY_REWARDS.streetrat;
}

// ── Short-form number formatting ──────────────────────────────────────────────
// Turns big Cash amounts into compact strings: 1000 -> "1k", 2500000 -> "2.5m",
// 1000000000 -> "1b". One decimal place, only when it isn't a round number
// (so "2m", not "2.0m"). Floors rather than rounds so we never overflow a unit
// (e.g. 999,999 shows "999.9k", never "1000k"). Below 1000 it's printed as-is.
function fmt(n) {
  n = Math.floor(Number(n) || 0);
  const neg = n < 0;
  n = Math.abs(n);
  const unit = (x, suffix) => {
    const r = Math.floor(x * 10) / 10; // 1 decimal, floored
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + suffix;
  };
  let out;
  if (n < 1e3)       out = String(n);
  else if (n < 1e6)  out = unit(n / 1e3, "k");
  else if (n < 1e9)  out = unit(n / 1e6, "m");
  else if (n < 1e12) out = unit(n / 1e9, "b");
  else               out = unit(n / 1e12, "t");
  return (neg ? "-" : "") + out;
}

// ── Notoriety (activity leveling) ─────────────────────────────────────────────
// A second ladder, separate from the Family rank. Earned purely by USING Cosa —
// economy commands and just talking to her. Higher notoriety = a flat daily-cut
// bonus that STACKS on top of your rank's daily. Grindy on purpose: Kingpin is
// meant to take a dedicated player a month or two.
//
// `xp` on each tier is the CUMULATIVE XP required to reach it.
const NOTORIETY_TIERS = [
  { key: "nobody",      name: "Nobody",      emoji: "🚬", xp: 0,      dailyBonus: 0        },
  { key: "whisper",     name: "Whisper",     emoji: "🍃", xp: 300,    dailyBonus: 5000     },
  { key: "known",       name: "Known",       emoji: "👀", xp: 1200,   dailyBonus: 25000    },
  { key: "respected",   name: "Respected",   emoji: "🤝", xp: 3500,   dailyBonus: 75000    },
  { key: "connected",   name: "Connected",   emoji: "🕸️", xp: 9000,   dailyBonus: 200000   },
  { key: "feared",      name: "Feared",      emoji: "😰", xp: 22000,  dailyBonus: 600000   },
  { key: "notorious",   name: "Notorious",   emoji: "📰", xp: 55000,  dailyBonus: 1500000  },
  { key: "untouchable", name: "Untouchable", emoji: "🛡️", xp: 120000, dailyBonus: 5000000  },
  { key: "legend",      name: "Legend",      emoji: "🌟", xp: 210000, dailyBonus: 15000000 },
  { key: "kingpin",     name: "Kingpin",     emoji: "👑", xp: 360000, dailyBonus: 50000000 },
];

// In-memory cache of per-user XP and economy bans, backed by a single
// empire_data row ("notoriety_data"). Loaded once at startup, written back on a
// throttle so per-message XP grants don't hammer the DB.
const _xpCache = new Map();     // userId -> total xp (number)
const _ecoBans = new Set();     // userIds banned from the economy
const _xpCooldowns = new Map(); // userId -> timestamp of last XP grant (anti-spam)
let _notorietyDirty = false;
let _notorietyLoaded = false;

// Per-source anti-spam windows. Talking is cheap so it's throttled hard;
// commands cost a real cooldown/action already, so a light window just stops
// someone macro-spamming `cosa balance` for infinite XP.
const XP_COOLDOWNS = { chat: 40 * 1000, command: 8 * 1000 };
// XP granted per grant, by source (kept modest so Kingpin stays a 1-2 month grind).
const XP_AMOUNTS = { chat: [6, 10], command: [12, 20] };

async function loadNotoriety() {
  if (!supabase) { _notorietyLoaded = true; return; }
  try {
    const { data } = await supabase.from("empire_data").select("value").eq("key", "notoriety_data").maybeSingle();
    const v = data?.value || {};
    _xpCache.clear();
    for (const [uid, xp] of Object.entries(v.xp || {})) _xpCache.set(uid, Number(xp) || 0);
    _ecoBans.clear();
    for (const uid of (v.bans || [])) _ecoBans.add(uid);
    console.log(`✅ Notoriety loaded — ${_xpCache.size} players, ${_ecoBans.size} banned`);
  } catch (e) {
    console.error("[NOTORIETY LOAD]", e.message);
  }
  _notorietyLoaded = true;
  // Periodic flush — only writes when something actually changed.
  setInterval(() => { if (_notorietyDirty) saveNotoriety().catch(() => {}); }, 20000);
}

async function saveNotoriety() {
  if (!supabase || !_notorietyLoaded) return;
  try {
    const value = { xp: Object.fromEntries(_xpCache), bans: [..._ecoBans] };
    await supabase.from("empire_data").upsert({ key: "notoriety_data", value }, { onConflict: "key" });
    _notorietyDirty = false;
  } catch (e) {
    console.error("[NOTORIETY SAVE]", e.message);
  }
}

function getXP(userId) {
  return _xpCache.get(userId) || 0;
}

// Which tier an XP total falls into.
function getNotorietyTier(xp) {
  let tier = NOTORIETY_TIERS[0];
  for (const t of NOTORIETY_TIERS) { if (xp >= t.xp) tier = t; else break; }
  return tier;
}

// The next tier up (or null if already Kingpin), for progress display.
function getNextNotorietyTier(xp) {
  for (const t of NOTORIETY_TIERS) { if (xp < t.xp) return t; }
  return null;
}

function getNotorietyBonus(userId) {
  return getNotorietyTier(getXP(userId)).dailyBonus;
}

// Grant XP for using Cosa. `source` is "chat" or "command"; each has its own
// anti-spam window. The XP amount is rolled from XP_AMOUNTS for that source.
// Returns { leveledUp, tier } so callers can announce a promotion. `null` tier
// change on a cooldowned/no-op call.
function addXP(userId, source = "command") {
  const cur = getNotorietyTier(getXP(userId));
  if (!userId) return { leveledUp: false, tier: cur };
  const cd = XP_COOLDOWNS[source] || 0;
  const key = userId + ":" + source;
  const last = _xpCooldowns.get(key) || 0;
  if (Date.now() - last < cd) return { leveledUp: false, tier: cur };
  _xpCooldowns.set(key, Date.now());
  const [lo, hi] = XP_AMOUNTS[source] || XP_AMOUNTS.command;
  const amount = lo + Math.floor(Math.random() * (hi - lo + 1));
  const before = getXP(userId);
  const after = before + amount;
  _xpCache.set(userId, after);
  _notorietyDirty = true;
  const afterTier = getNotorietyTier(after);
  return { leveledUp: afterTier.key !== cur.key, tier: afterTier, prevTier: cur, xp: after, gained: amount };
}

// Admin: hard-set a user's XP (snaps them to whatever tier that lands in).
function setXP(userId, amount) {
  _xpCache.set(userId, Math.max(0, Math.floor(amount)));
  _notorietyDirty = true;
  saveNotoriety().catch(() => {});
  return getNotorietyTier(getXP(userId));
}

// A human-readable list of every valid tier — reused by the admin command's
// error message so a typo always comes back with "here's every valid option."
function formatTierList() {
  return NOTORIETY_TIERS.map(t => `${t.emoji} \`${t.key}\` (${t.name})`).join(", ");
}

// Simple Levenshtein distance — used to catch typos like "kingpn" -> "kingpin"
// or "ntorious" -> "notorious" without needing an exact match.
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Fuzzy-resolve a tier from typed input. Tries exact key/name match first,
// then falls back to closest Levenshtein match against key + name (typo
// tolerance scales a little with word length so "king"->"kingpin" doesn't
// falsely match while "kingpn"->"kingpin" does).
function resolveNotorietyTier(input) {
  if (!input) return { tier: null, corrected: false };
  const q = input.toLowerCase().trim();

  const exact = NOTORIETY_TIERS.find(t => t.key === q || t.name.toLowerCase() === q);
  if (exact) return { tier: exact, corrected: false };

  let best = null, bestDist = Infinity;
  for (const t of NOTORIETY_TIERS) {
    const dKey = levenshtein(q, t.key);
    const dName = levenshtein(q, t.name.toLowerCase());
    const d = Math.min(dKey, dName);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  const threshold = Math.max(2, Math.ceil(Math.min(best?.key.length || 0, q.length) * 0.4));
  if (best && bestDist <= threshold) return { tier: best, corrected: true, distance: bestDist };
  return { tier: null, corrected: false };
}

// Admin: set a user straight to a named notoriety tier. Typo-tolerant —
// returns { tier, corrected, from } on a fuzzy match, or null if nothing
// close enough was found (caller should show formatTierList() in that case).
function setNotorietyTier(userId, tierKey) {
  const { tier, corrected } = resolveNotorietyTier(tierKey);
  if (!tier) return null;
  const result = setXP(userId, tier.xp);
  return { ...result, corrected, inputWas: tierKey };
}

function isEcoBanned(userId) {
  return _ecoBans.has(userId);
}

function setEcoBan(userId, banned) {
  if (banned) _ecoBans.add(userId); else _ecoBans.delete(userId);
  _notorietyDirty = true;
  saveNotoriety().catch(() => {});
}

// ── Slots ─────────────────────────────────────────────────────────────────────
// Weights tuned so matching two commons is frequent, jackpots are rare.
// Total weight ~100. Skull symbol reduced from 37→15 so near-misses feel fair.
const SLOT_SYMBOLS = [
  { emoji: "🤵", weight: 3,  multiplier: 10  }, // rare jackpot — the Don himself
  { emoji: "💎", weight: 6,  multiplier: 6   },
  { emoji: "🔫", weight: 10, multiplier: 4   },
  { emoji: "🥃", weight: 16, multiplier: 2.5 },
  { emoji: "🎩", weight: 22, multiplier: 1.5 },
  { emoji: "🚬", weight: 24, multiplier: 1   },
  { emoji: "💵", weight: 27, multiplier: 0.5 }, // partial return on pair
  { emoji: "💀", weight: 8,  multiplier: 0   }, // loss, further reduced
];

// Loaded Dice luck buff: shifts 10% of the two losing symbols' combined
// weight (💀 and 💵) over to the winning symbols, proportionally. This is a
// flat probability shift, not a reroll/dodge — a bad spin can still happen,
// it's just 10% less likely than normal.
const LUCK_BUFF_PCT = 0.10;
let _luckySlotTable = null;
function getLuckySlotTable() {
  if (_luckySlotTable) return _luckySlotTable;
  const losing = SLOT_SYMBOLS.filter(s => s.multiplier <= 0.5);
  const winning = SLOT_SYMBOLS.filter(s => s.multiplier > 0.5);
  const losingWeight = losing.reduce((a, s) => a + s.weight, 0);
  const winningWeight = winning.reduce((a, s) => a + s.weight, 0);
  const shift = losingWeight * LUCK_BUFF_PCT;
  _luckySlotTable = SLOT_SYMBOLS.map(s => {
    if (s.multiplier <= 0.5) return { ...s, weight: s.weight - (s.weight / losingWeight) * shift };
    return { ...s, weight: s.weight + (s.weight / winningWeight) * shift };
  });
  return _luckySlotTable;
}
function spinSlot(charmActive = false) {
  const table = charmActive ? getLuckySlotTable() : SLOT_SYMBOLS;
  const totalWeight = table.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * totalWeight;
  for (const s of table) { r -= s.weight; if (r <= 0) return s; }
  return table[table.length - 1];
}

function playSlots(bet, charmActive = false, houseFavorActive = false) {
  const reels = [spinSlot(charmActive), spinSlot(charmActive), spinSlot(charmActive)];
  // House Favor: guarantee no 💀 (total-loss) symbol makes it into the final result
  if (houseFavorActive) {
    for (let i = 0; i < reels.length; i++) {
      let tries = 0;
      while (reels[i].multiplier === 0 && tries < 8) {
        reels[i] = spinSlot();
        tries++;
      }
    }
  }
  const display = reels.map(r => r.emoji).join(" | ");
  let multiplier = 0;
  let isJackpot = false;
  if (reels[0].emoji === reels[1].emoji && reels[1].emoji === reels[2].emoji) {
    multiplier = reels[0].multiplier * 3; // jackpot
    isJackpot = multiplier > 1;
  } else if (reels[0].emoji === reels[1].emoji) {
    multiplier = reels[0].multiplier * 0.5; // pair uses the matched symbol's payout
  } else if (reels[1].emoji === reels[2].emoji) {
    multiplier = reels[1].multiplier * 0.5;
  } else if (reels[0].emoji === reels[2].emoji) {
    multiplier = reels[0].multiplier * 0.5;
  }
  const winnings = Math.floor(bet * multiplier);
  return { display, multiplier, winnings, isJackpot };
}

// ── Wheel ─────────────────────────────────────────────────────────────────────
// Max is now 5x. 0.5x counts as a loss (loaded dice shifts weight away from it).
// 3x and 5x are rare but reachable. Total weight = 1000 for clean math.
const WHEEL_SEGMENTS = [
  { label: "💀 WIPED OUT",  multiplier: 0,   weight: 180 },
  { label: "☠️ WIPED OUT",  multiplier: 0,   weight: 150 },
  { label: "0.5x 😬",       multiplier: 0.5, weight: 170 }, // treated as loss for loaded dice
  { label: "1x",            multiplier: 1,   weight: 250 },
  { label: "2x",            multiplier: 2,   weight: 150 },
  { label: "3x 🔥",         multiplier: 3,   weight: 70  },
  { label: "5x ⚡",         multiplier: 5,   weight: 30  },
];

// Same flat-shift approach as the slots luck buff: moves 10% of the losing
// segments' (0x, 0x, 0.5x) combined weight over to the winning segments
// (1x+), proportionally. No dodging/rerolling a bad spin — just 10% less
// likely to land on one.
let _luckyWheelTable = null;
function getLuckyWheelTable() {
  if (_luckyWheelTable) return _luckyWheelTable;
  const losing = WHEEL_SEGMENTS.filter(s => s.multiplier <= 0.5);
  const winning = WHEEL_SEGMENTS.filter(s => s.multiplier > 0.5);
  const losingWeight = losing.reduce((a, s) => a + s.weight, 0);
  const winningWeight = winning.reduce((a, s) => a + s.weight, 0);
  const shift = losingWeight * LUCK_BUFF_PCT;
  _luckyWheelTable = WHEEL_SEGMENTS.map(s => {
    if (s.multiplier <= 0.5) return { ...s, weight: s.weight - (s.weight / losingWeight) * shift };
    return { ...s, weight: s.weight + (s.weight / winningWeight) * shift };
  });
  return _luckyWheelTable;
}

function spinWheel(houseFavorActive = false, charmActive = false) {
  function roll() {
    const table = charmActive ? getLuckyWheelTable() : WHEEL_SEGMENTS;
    const total = table.reduce((a, s) => a + s.weight, 0);
    let r = Math.random() * total;
    for (const s of table) { r -= s.weight; if (r <= 0) return s; }
    return table[0];
  }
  let seg = roll();
  // House Favor: a would-be wipeout becomes a straight 1x instead of a
  // reroll. Rerolling from the full table was the actual bug — removing the
  // 0x segments and renormalizing over what's left proportionally inflates
  // EVERY other outcome, including 2x/3x/5x, so House Favor was quietly also
  // boosting jackpot odds (~25% -> ~37%) on top of removing downside risk.
  // Converting straight to 1x guarantees "no wipeout" without touching the
  // odds of anything else — 2x+ stays exactly as rare as it normally is.
  if (houseFavorActive && seg.multiplier === 0) {
    seg = WHEEL_SEGMENTS.find(s => s.multiplier === 1) || seg;
  }
  return seg;
}

// ── Blackjack ─────────────────────────────────────────────────────────────────
const BJ_DECK = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
function bjValue(card) { return card === "A" ? 11 : ["J","Q","K"].includes(card) ? 10 : parseInt(card); }
function bjHandValue(hand) {
  let total = hand.reduce((a, c) => a + bjValue(c), 0);
  let aces = hand.filter(c => c === "A").length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function dealCard() { return BJ_DECK[Math.floor(Math.random() * BJ_DECK.length)]; }
function newBjHand() { return [dealCard(), dealCard()]; }

// ── Shakedown (Rob) ────────────────────────────────────────────────────────────
// 40% success, 30% caught (fine = 50% of attempted take), 30% they got away clean
// markedBonus (from bounties.getMarkedBonus) bumps success chance — a target
// who just had a big bounty collected on them is exposed and easy pickings
// for the debuff's duration. Bigger bounties (100M+) mark harder than small
// ones, so this is a number now, not a flat boolean bump.
const MARKED_ROB_BONUS = 0.25; // default/minor-tier bonus, kept for reference & back-compat
function attemptRob(targetCopperBalance, robberCopperBalance, robberDebt = 0, markedBonus = 0, forcedThreshold = null) {
  const r = Math.random();
  const steal = Math.floor(targetCopperBalance * (0.2 + Math.random() * 0.2));
  const finePercent = 0.5 + Math.random() * 0.2;
  // In debt to the Family = lower success rate (20% instead of 40%)
  let successThreshold = robberDebt > 0 ? 0.25 : 0.50;
  // Accept legacy boolean `true` (old callers) as the default marked bonus.
  const bonus = markedBonus === true ? MARKED_ROB_BONUS : (Number(markedBonus) || 0);
  if (bonus > 0) successThreshold = Math.min(0.9, successThreshold + bonus);
  if (forcedThreshold !== null) successThreshold = forcedThreshold;
  if (r < successThreshold) return { result: "success", amount: steal };
  if (r < 0.7) return { result: "caught", fine: Math.floor(steal * finePercent) };
  return { result: "escaped" };
}

// ── Chat Rewards ──────────────────────────────────────────────────────────────
const chatCounters = new Map(); // userId -> message count since last reward
function shouldRewardChat(userId) {
  const count = (chatCounters.get(userId) || 0) + 1;
  chatCounters.set(userId, count);
  if (count >= (5 + Math.floor(Math.random() * 6))) { // every 5-10 messages
    chatCounters.set(userId, 0);
    return Math.floor(10 + Math.random() * 40); // 10-50 cash
  }
  return 0;
}

// Active blackjack games: userId -> { playerHand, dealerHand, bet, channelId }
const bjGames = new Map();

// ── Gifting ────────────────────────────────────────────────────────────────
// Send Cash directly to another user. Small tax skimmed to the Don's treasury,
// same vig pattern used elsewhere (bank fees, bounty posting fee).
const GIFT_TAX_PCT = 0.03; // 3%
const GIFT_DAILY_CAP = 5_000_000; // per-user cap on total Cash gifted per rolling 24h
const giftDailyTotals = new Map(); // userId -> { total, resetAt }

function checkGiftCap(userId, amount) {
  const now = Date.now();
  let entry = giftDailyTotals.get(userId);
  if (!entry || now >= entry.resetAt) {
    entry = { total: 0, resetAt: now + 24 * 60 * 60 * 1000 };
  }
  if (entry.total + amount > GIFT_DAILY_CAP) return false;
  entry.total += amount;
  giftDailyTotals.set(userId, entry);
  return true;
}

async function giftCopper(fromId, toId, amount, addToTreasury, masterId) {
  if (fromId === toId) return { success: false, reason: "You can't gift Cash to yourself." };
  if (amount <= 0) return { success: false, reason: "Gift amount must be positive." };
  if (!checkGiftCap(fromId, amount)) return { success: false, reason: `Daily gifting cap reached (${fmt(GIFT_DAILY_CAP)}/day).` };

  const deducted = await deductCopper(fromId, amount);
  if (!deducted) return { success: false, reason: "Insufficient funds." };

  const tax = Math.floor(amount * GIFT_TAX_PCT);
  const net = amount - tax;
  await addCopper(toId, net);
  markTainted(toId, net);
  if (tax > 0 && addToTreasury) await addToTreasury(masterId, tax);

  return { success: true, net, tax };
}

// ── Anti-Alt-Farming: Tainted Balance Tracking ──────────────────────────────
// Any balance-scaled reward (e.g. a daily bonus scaled off bank balance) is
// vulnerable to: claim the scaled reward, ship the balance to an alt via
// pay/gift, alt claims a scaled reward off the SAME money. Since wallets here
// are a single number (no discrete "coins" to tag individually), we tag the
// TRANSFER instead: money that arrived via pay/gift is "tainted" for 24h and
// excluded from scaling math on the receiving end.
// NOTE: in-memory (resets on bot restart) — move to a DB column if that
// becomes a real problem.
const taintedBalances = new Map(); // userId -> { amount, expiresAt }
const TAINT_WINDOW_MS = 24 * 60 * 60 * 1000;

function markTainted(userId, amount) {
  if (!amount || amount <= 0) return;
  const now = Date.now();
  const existing = taintedBalances.get(userId);
  const carried = (existing && existing.expiresAt > now) ? existing.amount : 0;
  taintedBalances.set(userId, { amount: carried + amount, expiresAt: now + TAINT_WINDOW_MS });
}

function getTaintedAmount(userId) {
  const entry = taintedBalances.get(userId);
  if (!entry) return 0;
  if (entry.expiresAt <= Date.now()) { taintedBalances.delete(userId); return 0; }
  return entry.amount;
}

function getScalableBalance(userId, rawBalance) {
  return Math.max(0, rawBalance - getTaintedAmount(userId));
}

// While a user has ANY tainted balance sitting on their account, cap what
// they can gamble in a single bet at TAINT_GAMBLE_CAP — regardless of how
// much of the bet would technically come from clean vs tainted funds
// (balances are fungible, so there's no way to prove which dollars funded
// the bet). This is what stops "gift 100M to alt, alt gambles it all in one
// shot" — the alt can still gamble, just capped at 5M until the taint clears.
const TAINT_GAMBLE_CAP = 5_000_000;
function getMaxBet(userId, normalMax) {
  return getTaintedAmount(userId) > 0 ? Math.min(normalMax, TAINT_GAMBLE_CAP) : normalMax;
}

// Splits a person's holdings into "Black Money" (still-tainted, recently
// received/stolen Cash) and "White Money" (everything else) across however
// many pots you give it, in order — e.g. wallet first, then bank. Money is
// fungible so this is a display convention, not literal coin-tracking: the
// tainted pool just gets drawn down pot by pot.
function splitBlackWhite(userId, pots) {
  let remainingTaint = getTaintedAmount(userId);
  return pots.map(potAmount => {
    const black = Math.min(remainingTaint, potAmount);
    remainingTaint -= black;
    return { black, white: potAmount - black };
  });
}

function clearTaint(userId) {
  taintedBalances.delete(userId);
}

// ── Money Laundering — "The Alibi Room" ────────────────────────────────────
// A back-room bar that washes ALL of a person's Black Money clean, no matter
// how much is on the books. Takes 30 minutes start-to-finish; only one run
// at a time per person. Unlike gambling's TAINT_GAMBLE_CAP workaround, this
// is a full, uncapped clear — it just costs time instead of a fee.
const LAUNDER_DURATION_MS = 30 * 60 * 1000;
const pendingLaunders = new Map(); // userId -> { expiresAt, amount }

function startLaundering(userId) {
  const taint = getTaintedAmount(userId);
  if (taint <= 0) return { success: false, reason: "You've got no Black Money on the books — you're already clean." };

  const existing = pendingLaunders.get(userId);
  if (existing && existing.expiresAt > Date.now()) {
    return { success: false, reason: `Already running money through **The Alibi Room** — ready <t:${Math.floor(existing.expiresAt / 1000)}:R>.` };
  }

  const expiresAt = Date.now() + LAUNDER_DURATION_MS;
  pendingLaunders.set(userId, { expiresAt, amount: taint });
  setTimeout(() => {
    const entry = pendingLaunders.get(userId);
    if (entry && entry.expiresAt <= Date.now()) {
      clearTaint(userId);
      pendingLaunders.delete(userId);
    }
  }, LAUNDER_DURATION_MS);

  return { success: true, amount: taint, expiresAt };
}

// Returns null if nothing pending. If the timer's up but the setTimeout
// hasn't fired yet (bot restart, timing edge), resolves it immediately.
function getLaunderStatus(userId) {
  const entry = pendingLaunders.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    clearTaint(userId);
    pendingLaunders.delete(userId);
    return { done: true, amount: entry.amount };
  }
  return { done: false, expiresAt: entry.expiresAt, amount: entry.amount };
}

module.exports = {
  markTainted, getTaintedAmount, getScalableBalance, getMaxBet, TAINT_GAMBLE_CAP,
  splitBlackWhite, clearTaint,
  startLaundering, getLaunderStatus, LAUNDER_DURATION_MS,
  giftCopper, GIFT_TAX_PCT, GIFT_DAILY_CAP,
  fromCopper, formatWallet, walletToCopper, parseBet, fmt,
  initEconomy, getWallet, saveWallet, addCopper, deductCopper, getLeaderboard, claimDaily,
  getDailyAmount, DAILY_REWARDS,
  playSlots, spinWheel, WHEEL_SEGMENTS,
  bjHandValue, dealCard, newBjHand, bjGames,
  attemptRob, MARKED_ROB_BONUS, shouldRewardChat,
  getDebt, addDebt, payDebt, formatDebt,
  // Notoriety leveling
  NOTORIETY_TIERS, loadNotoriety, saveNotoriety,
  getXP, addXP, setXP, setNotorietyTier, resolveNotorietyTier, formatTierList,
  getNotorietyTier, getNextNotorietyTier, getNotorietyBonus,
  isEcoBanned, setEcoBan,
  resetAllDailyCooldowns,
};
