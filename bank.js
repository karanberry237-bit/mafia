const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

let supabase;
function initBank(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  console.log("🏦 Bank system initialized");
}

// ── Vault Tiers ───────────────────────────────────────────────────────────────
// Escalating money-laundering ladder — from a shoebox under the bed to the Don's own vault.
const VAULT_TIERS = {
  shoebox:    { label: "📦 Shoebox",            maxStorage: 50 * 10000,              cost: 0,                interestRate: 0.005, feeRate: 0.001, emoji: "📦" },
  deposit:    { label: "🔑 Safety Deposit Box", maxStorage: 500 * 10000,             cost: 20 * 10000,       interestRate: 0.010, feeRate: 0.002, emoji: "🔑" },
  safe:       { label: "🔒 The Safe",           maxStorage: 2000 * 10000,            cost: 80 * 10000,       interestRate: 0.015, feeRate: 0.003, emoji: "🔒" },
  vault:      { label: "🏦 Bank Vault",         maxStorage: 10 * 1000000,            cost: 300 * 10000,      interestRate: 0.020, feeRate: 0.004, emoji: "🏦" },
  offshore:   { label: "🛳️ Offshore Account",   maxStorage: 50 * 1000000,            cost: 5 * 1000000,      interestRate: 0.025, feeRate: 0.005, emoji: "🛳️" },
  shell:      { label: "🏢 Shell Company",      maxStorage: 150 * 1000000,           cost: 20 * 1000000,     interestRate: 0.030, feeRate: 0.006, emoji: "🏢" },
  swiss:      { label: "🇨🇭 Swiss Account",      maxStorage: 400 * 1000000,           cost: 80 * 1000000,     interestRate: 0.035, feeRate: 0.007, emoji: "🇨🇭" },
  cayman:     { label: "🏝️ Cayman Account",     maxStorage: 1000 * 1000000,          cost: 200 * 1000000,    interestRate: 0.040, feeRate: 0.008, emoji: "🏝️" },
  trust:      { label: "💼 Family Trust",       maxStorage: 10000 * 1000000,         cost: 500 * 1000000,    interestRate: 0.045, feeRate: 0.009, emoji: "💼" },
  donsvault:  { label: "♾️ Don's Vault",        maxStorage: Number.MAX_SAFE_INTEGER, cost: 0,                interestRate: 0.000, feeRate: 0.000, emoji: "♾️" },
};

const TIER_ORDER = ["shoebox","deposit","safe","vault","offshore","shell","swiss","cayman","trust","donsvault"];

function getNextTier(currentTier) {
  const idx = TIER_ORDER.indexOf(currentTier);
  if (idx === -1 || idx === TIER_ORDER.length - 1) return null;
  return TIER_ORDER[idx + 1];
}

// ── Bank Operations ───────────────────────────────────────────────────────────
async function getBankAccount(userId) {
  const empty = { user_id: userId, balance: 0, vault_tier: "shoebox", last_processed: new Date().toISOString() };
  const { data, error } = await supabase.from("banks").select("*").eq("user_id", userId).maybeSingle();
  if (error) {
    console.error("[GET BANK ERROR]", error.message);
    return empty;
  }
  return data || empty;
}

async function saveBankAccount(account) {
  const { error } = await supabase.from("banks").upsert(account, { onConflict: "user_id" });
  if (error) console.error("[SAVE BANK]", error.message);
}

async function processBank(account, masterId, addToTreasury) {
  const now = Date.now();
  const lastProcessed = new Date(account.last_processed).getTime();
  const hoursSince = (now - lastProcessed) / (1000 * 60 * 60);
  if (hoursSince < 24) return account; // not yet

  const tier = VAULT_TIERS[account.vault_tier] || VAULT_TIERS.shoebox;
  const balance = account.balance;
  if (balance <= 0) {
    account.last_processed = new Date().toISOString();
    await saveBankAccount(account);
    return account;
  }

  const interest = Math.floor(balance * tier.interestRate);
  const fee = Math.floor(balance * tier.feeRate);
  const net = interest - fee;

  account.balance = Math.max(0, balance + net);
  account.last_processed = new Date().toISOString();
  await saveBankAccount(account);

  // Fee goes to the Don's Vig
  if (fee > 0 && addToTreasury) await addToTreasury(masterId, fee);

  return account;
}

async function deposit(userId, copperAmount) {
  const account = await getBankAccount(userId);
  const tier = VAULT_TIERS[account.vault_tier] || VAULT_TIERS.shoebox;
  if (account.balance + copperAmount > tier.maxStorage) {
    return { success: false, reason: "Exceeds your vault's storage limit of **" + formatCopper(tier.maxStorage) + "**. Upgrade with **Cosa bank upgrade**." };
  }
  account.balance += copperAmount;
  await saveBankAccount(account);
  return { success: true, account };
}

async function withdraw(userId, copperAmount) {
  const account = await getBankAccount(userId);
  if (copperAmount > account.balance) return { success: false, reason: "Insufficient bank balance." };
  account.balance -= copperAmount;
  await saveBankAccount(account);
  return { success: true, account };
}

async function upgradeTier(userId, masterId, addToTreasury, deductFromWallet) {
  const account = await getBankAccount(userId);
  const nextTierKey = getNextTier(account.vault_tier);
  if (!nextTierKey) return { success: false, reason: "You already hold the highest vault tier available to you. 🏆" };

  // Don's Vault is exclusive to the Don
  if (nextTierKey === "donsvault" && userId !== masterId) {
    return { success: false, reason: "🚫 The Don's Vault is reserved for the boss alone. Know your place." };
  }

  const nextTier = VAULT_TIERS[nextTierKey];
  if (nextTier.cost > 0) {
    const deducted = await deductFromWallet(userId, nextTier.cost);
    if (!deducted) return { success: false, reason: "Insufficient funds. You need **" + formatCopper(nextTier.cost) + "** to upgrade." };
    await addToTreasury(masterId, nextTier.cost); // goes to the Don's Vig
  }
  account.vault_tier = nextTierKey;
  await saveBankAccount(account);
  return { success: true, account, tier: nextTier };
}

async function getBankBalance(userId) {
  const account = await getBankAccount(userId);
  return account.balance;
}

async function deductFromBank(userId, amount) {
  const account = await getBankAccount(userId);
  if (account.balance < amount) {
    // Deduct what we can
    const deducted = account.balance;
    account.balance = 0;
    await saveBankAccount(account);
    return deducted;
  }
  account.balance -= amount;
  await saveBankAccount(account);
  return amount;
}

function formatCopper(copper) {
  // Flat currency: everything is Cash now. No denominations.
  return "💵 " + Math.floor(copper).toLocaleString() + " Cash";
}

// ── Daily Processing (called every 24h) ──────────────────────────────────────
async function runDailyBankProcessing(masterId, addToTreasury) {
  const { data, error } = await supabase.from("banks").select("*");
  if (error) {
    console.error("[BANK DAILY]", error.message);
    return;
  }
  if (!data) return;
  let processed = 0;
  for (const account of data) {
    await processBank(account, masterId, addToTreasury);
    processed++;
  }
  console.log("[BANK] Daily processing complete — " + processed + " accounts");
}

async function wipeAllBanks() {
  const { error } = await supabase.from("banks").update({ balance: 0 }).neq("user_id", "0");
  if (error) {
    console.error("[BANK WIPE]", error.message);
    return false;
  }
  console.log("[BANK] All bank balances wiped by the Don");
  return true;
}

module.exports = {
  initBank, getBankAccount, saveBankAccount, deposit, withdraw,
  upgradeTier, getBankBalance, deductFromBank, formatCopper,
  runDailyBankProcessing, wipeAllBanks, VAULT_TIERS, TIER_ORDER, getNextTier, processBank
};
