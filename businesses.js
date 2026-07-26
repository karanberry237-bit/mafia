const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { fmt } = require("./economy");
const commission = require("./commission");

// ── Businesses / Fronts ────────────────────────────────────────────────────
// Buyable income-generating assets. Each TYPE has its own 5-tier ladder
// (cost/income/upkeep escalate). Security is a separate upgrade path on top
// of a tier that defends against raids. Income accrues into `pending` until
// collected (capped by tier storage) — encourages regular check-ins.
//
// Table: businesses
//   id uuid default gen_random_uuid() primary key, owner_id text,
//   type text,            -- 'laundromat' | 'nightclub' | 'casino' | 'shipping'
//   tier int default 1,
//   security_level int default 0,
//   pending bigint default 0,
//   upkeep_owed bigint default 0,
//   last_processed timestamptz default now(),
//   created_at timestamptz default now()
//   UNIQUE (owner_id, type)   -- one of each type per user, diversify or stack tiers

let supabase;
function initBusinesses(url, key) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  console.log("🏢 Businesses system initialized");
}

// ── Business type ladders (5 tiers each) ──────────────────────────────────
// cost = one-time cost to REACH this tier from the previous one (tier 1 cost = purchase price)
// income = Cash generated per tick (every 6h) at this tier
// upkeep = Cash owed per tick (every 6h) at this tier (unpaid upkeep pauses income accrual)
// capacity = max pending Cash that can stack up before it must be collected
const BUSINESS_TYPES = {
  laundromat: {
    label: "🧺 Laundromat", flavor: ["Corner Wash", "Suds & Co.", "The Spin Cycle", "Clean Slate Laundry", "Golden Suds Empire"],
    tiers: [
      { cost: 50_000,    income: 2_000,   upkeep: 500,    capacity: 60_000 },
      { cost: 150_000,   income: 5_000,   upkeep: 1_250,  capacity: 150_000 },
      { cost: 400_000,   income: 12_500,  upkeep: 3_000,  capacity: 400_000 },
      { cost: 1_000_000, income: 30_000,  upkeep: 7_500,  capacity: 1_000_000 },
      { cost: 2_500_000, income: 75_000,  upkeep: 17_500, capacity: 2_500_000 },
    ],
  },
  nightclub: {
    label: "🎷 Nightclub", flavor: ["Back Alley Bar", "The Velvet Room", "Club Onyx", "The Silver Fox", "The Golden Peacock"],
    tiers: [
      { cost: 150_000,   income: 5_000,   upkeep: 1_500,  capacity: 150_000 },
      { cost: 400_000,   income: 13_750,  upkeep: 3_750,  capacity: 400_000 },
      { cost: 1_000_000, income: 35_000,  upkeep: 8_750,  capacity: 1_000_000 },
      { cost: 2_500_000, income: 87_500,  upkeep: 21_250, capacity: 2_500_000 },
      { cost: 6_000_000, income: 212_500, upkeep: 50_000, capacity: 6_000_000 },
    ],
  },
  shipping: {
    label: "🚢 Shipping Front", flavor: ["Dockside Freight", "Blue Anchor Shipping", "Continental Freight Co.", "Iron Harbor Logistics", "Trans-Atlantic Holdings"],
    tiers: [
      { cost: 300_000,   income: 10_000,  upkeep: 3_000,  capacity: 300_000 },
      { cost: 800_000,   income: 25_000,  upkeep: 7_000,  capacity: 800_000 },
      { cost: 2_000_000, income: 65_000,  upkeep: 16_250, capacity: 2_000_000 },
      { cost: 5_000_000, income: 162_500, upkeep: 40_000, capacity: 5_000_000 },
      { cost: 12_000_000, income: 400_000, upkeep: 100_000, capacity: 12_000_000 },
    ],
  },
  casino: {
    label: "🎰 Casino", flavor: ["The Backroom Table", "Lucky Sevens", "The High Roller", "Diamond Point Casino", "The Emerald Palace"],
    tiers: [
      { cost: 800_000,    income: 25_000,   upkeep: 8_750,   capacity: 800_000 },
      { cost: 2_000_000,  income: 65_000,   upkeep: 20_000,  capacity: 2_000_000 },
      { cost: 5_000_000,  income: 162_500,  upkeep: 47_500,  capacity: 5_000_000 },
      { cost: 12_000_000, income: 400_000,  upkeep: 112_500, capacity: 12_000_000 },
      { cost: 30_000_000, income: 1_000_000, upkeep: 275_000, capacity: 30_000_000 },
    ],
  },
};

// ── Security ladder (applies per-business, independent upgrade track) ─────
// defense: subtracted from raider's base success chance (as a flat %)
// skimCap: max % of pending income a successful raid can steal at this level
// upkeep: extra daily upkeep on top of the business's own upkeep
const SECURITY_LEVELS = [
  { label: "None",            defense: 0.00, skimCap: 0.50, upkeep: 0 },
  { label: "🔒 Basic Locks",   defense: 0.10, skimCap: 0.40, upkeep: 250 },
  { label: "💂 Guards",        defense: 0.22, skimCap: 0.30, upkeep: 1_000 },
  { label: "🔫 Armed Guards",  defense: 0.35, skimCap: 0.20, upkeep: 3_000 },
  { label: "🪖 Private Army",  defense: 0.50, skimCap: 0.10, upkeep: 8_750 },
];
// Cost to upgrade security TO each level (index matches SECURITY_LEVELS, index 0 has no cost)
const SECURITY_UPGRADE_COST = [0, 40_000, 120_000, 350_000, 900_000];

const RAID_BASE_SUCCESS = 0.45; // base chance before security defense is subtracted
const RAID_COOLDOWN_HOURS = 12;
const raidCooldowns = new Map(); // `${raiderId}:${businessId}` -> timestamp

function getFlavorName(type, tier) {
  const def = BUSINESS_TYPES[type];
  return def ? def.flavor[Math.min(tier - 1, def.flavor.length - 1)] : type;
}

async function getBusiness(ownerId, type) {
  const { data, error } = await supabase.from("businesses").select("*").eq("owner_id", ownerId).eq("type", type).maybeSingle();
  if (error) { console.error("[BIZ GET]", error.message); return null; }
  return data;
}

async function getBusinessById(id) {
  const { data, error } = await supabase.from("businesses").select("*").eq("id", id).maybeSingle();
  if (error) { console.error("[BIZ GET BY ID]", error.message); return null; }
  return data;
}

async function getUserBusinesses(ownerId) {
  const { data, error } = await supabase.from("businesses").select("*").eq("owner_id", ownerId);
  if (error) { console.error("[BIZ LIST]", error.message); return []; }
  return data || [];
}

async function buyBusiness(userId, type, deductFromWallet) {
  const def = BUSINESS_TYPES[type];
  if (!def) return { success: false, reason: "Unknown business type. Choose: " + Object.keys(BUSINESS_TYPES).join(", ") };

  const existing = await getBusiness(userId, type);
  if (existing) return { success: false, reason: `You already own a **${def.label}**. Use **Cosa business upgrade** to grow it.` };

  const tier1 = def.tiers[0];
  const deducted = await deductFromWallet(userId, tier1.cost);
  if (!deducted) return { success: false, reason: `Insufficient funds. Need **${fmt(tier1.cost)}** to open a ${def.label}.` };

  const { data, error } = await supabase.from("businesses").insert({
    owner_id: userId, type, tier: 1, security_level: 0, pending: 0, upkeep_owed: 0,
    last_processed: new Date().toISOString(),
  }).select().maybeSingle();
  if (error) { console.error("[BIZ BUY]", error.message); return { success: false, reason: error.message }; }
  return { success: true, business: data };
}

async function upgradeBusiness(userId, type, deductFromWallet) {
  const def = BUSINESS_TYPES[type];
  if (!def) return { success: false, reason: "Unknown business type." };
  const biz = await getBusiness(userId, type);
  if (!biz) return { success: false, reason: `You don't own a ${def.label}. Buy one first.` };
  if (biz.tier >= def.tiers.length) return { success: false, reason: `Your ${def.label} is already at max tier.` };
  if (biz.upkeep_owed > 0) return { success: false, reason: `Pay off your outstanding upkeep (${fmt(biz.upkeep_owed)}) before upgrading.` };

  const nextTierDef = def.tiers[biz.tier]; // tiers[0] is tier 1, so tiers[biz.tier] is the NEXT tier
  const deducted = await deductFromWallet(userId, nextTierDef.cost);
  if (!deducted) return { success: false, reason: `Insufficient funds. Need **${fmt(nextTierDef.cost)}** to upgrade.` };

  const { data, error } = await supabase.from("businesses").update({ tier: biz.tier + 1 }).eq("id", biz.id).select().maybeSingle();
  if (error) { console.error("[BIZ UPGRADE]", error.message); return { success: false, reason: error.message }; }
  return { success: true, business: data };
}

async function upgradeSecurity(userId, type, deductFromWallet) {
  const biz = await getBusiness(userId, type);
  if (!biz) return { success: false, reason: "You don't own that business." };
  if (biz.security_level >= SECURITY_LEVELS.length - 1) return { success: false, reason: "Security is already maxed out." };

  const nextLevel = biz.security_level + 1;
  const cost = SECURITY_UPGRADE_COST[nextLevel];
  const deducted = await deductFromWallet(userId, cost);
  if (!deducted) return { success: false, reason: `Insufficient funds. Need **${fmt(cost)}** for ${SECURITY_LEVELS[nextLevel].label}.` };

  const { data, error } = await supabase.from("businesses").update({ security_level: nextLevel }).eq("id", biz.id).select().maybeSingle();
  if (error) { console.error("[BIZ SECURITY]", error.message); return { success: false, reason: error.message }; }
  return { success: true, business: data, level: SECURITY_LEVELS[nextLevel] };
}

// Collects pending income into the user's wallet (minus Commission tax, if
// any is currently active), clearing pending to 0. The tax cut flows into the
// Commission's shared pot, not to the Don.
async function collectBusiness(userId, type, addCopper) {
  const biz = await getBusiness(userId, type);
  if (!biz) return { success: false, reason: "You don't own that business." };
  if (biz.pending <= 0) return { success: false, reason: "Nothing to collect yet." };

  const grossCollected = biz.pending;
  const taxRate = commission.getActiveTaxRate();
  const taxCut = Math.floor(grossCollected * taxRate);
  const net = grossCollected - taxCut;

  await addCopper(userId, net);
  if (taxCut > 0) await commission.addToPot(taxCut).catch(() => {});
  await supabase.from("businesses").update({ pending: 0 }).eq("id", biz.id);
  return { success: true, collected: net, taxed: taxCut, grossCollected };
}

async function payUpkeep(userId, type, deductFromWallet) {
  const biz = await getBusiness(userId, type);
  if (!biz) return { success: false, reason: "You don't own that business." };
  if (biz.upkeep_owed <= 0) return { success: false, reason: "No upkeep owed." };

  const deducted = await deductFromWallet(userId, biz.upkeep_owed);
  if (!deducted) return { success: false, reason: `Insufficient funds. You owe **${fmt(biz.upkeep_owed)}**.` };

  const paid = biz.upkeep_owed;
  await supabase.from("businesses").update({ upkeep_owed: 0 }).eq("id", biz.id);
  return { success: true, paid };
}

async function sellBusiness(userId, type) {
  const biz = await getBusiness(userId, type);
  if (!biz) return { success: false, reason: "You don't own that business." };
  await supabase.from("businesses").delete().eq("id", biz.id);
  return { success: true, business: biz };
}

// ── Daily processing: accrue income (if upkeep clear), else add to upkeep_owed ─
async function processBusiness(biz) {
  const now = Date.now();
  const lastProcessed = new Date(biz.last_processed).getTime();
  const hoursSince = (now - lastProcessed) / (1000 * 60 * 60);
  if (hoursSince < 6) return biz;

  const def = BUSINESS_TYPES[biz.type];
  if (!def) return biz;
  const tierDef = def.tiers[biz.tier - 1];
  const secDef = SECURITY_LEVELS[biz.security_level];

  const update = { last_processed: new Date().toISOString() };

  // Unpaid upkeep from before pauses new income accrual until cleared
  if (biz.upkeep_owed > 0) {
    update.upkeep_owed = biz.upkeep_owed + tierDef.upkeep + secDef.upkeep;
  } else {
    const newPending = Math.min(biz.pending + tierDef.income, tierDef.capacity);
    update.pending = newPending;
    update.upkeep_owed = tierDef.upkeep + secDef.upkeep;
  }

  const { data, error } = await supabase.from("businesses").update(update).eq("id", biz.id).select().maybeSingle();
  if (error) { console.error("[BIZ PROCESS]", error.message); return biz; }
  return data;
}

async function runDailyBusinessProcessing() {
  const { data, error } = await supabase.from("businesses").select("*");
  if (error) { console.error("[BIZ DAILY]", error.message); return; }
  let processed = 0;
  for (const biz of data || []) { await processBusiness(biz); processed++; }
  console.log("[BUSINESS] Daily processing complete — " + processed + " businesses");
}

// ── Raiding ────────────────────────────────────────────────────────────────
function raidCooldownKey(raiderId, businessId) { return raiderId + ":" + businessId; }

function getRaidCooldownRemaining(raiderId, businessId) {
  const last = raidCooldowns.get(raidCooldownKey(raiderId, businessId));
  if (!last) return 0;
  const elapsedHours = (Date.now() - last) / (1000 * 60 * 60);
  return Math.max(0, RAID_COOLDOWN_HOURS - elapsedHours);
}

async function raidBusiness(raiderId, ownerId, type, addCopper) {
  if (raiderId === ownerId) return { success: false, reason: "You can't raid your own business." };
  const biz = await getBusiness(ownerId, type);
  if (!biz) return { success: false, reason: "That user doesn't own that business." };
  if (biz.pending <= 0) return { success: false, reason: "Nothing worth raiding — the pending income is empty." };

  const remaining = getRaidCooldownRemaining(raiderId, biz.id);
  if (remaining > 0) return { success: false, reason: `That business is still cooling down. Try again in ${remaining.toFixed(1)}h.` };

  const secDef = SECURITY_LEVELS[biz.security_level];
  const successChance = Math.max(0.05, RAID_BASE_SUCCESS - secDef.defense);
  raidCooldowns.set(raidCooldownKey(raiderId, biz.id), Date.now());

  const roll = Math.random();
  if (roll >= successChance) {
    return { success: true, outcome: "failed", business: biz };
  }

  const skimPct = Math.random() * secDef.skimCap;
  const stolen = Math.floor(biz.pending * skimPct);
  await supabase.from("businesses").update({ pending: biz.pending - stolen }).eq("id", biz.id);
  await addCopper(raiderId, stolen);

  return { success: true, outcome: "success", stolen, business: biz };
}

function formatBusinessCard(biz) {
  const def = BUSINESS_TYPES[biz.type];
  const tierDef = def.tiers[biz.tier - 1];
  const secDef = SECURITY_LEVELS[biz.security_level];
  const flavorName = getFlavorName(biz.type, biz.tier);
  let out = `${def.label} — **${flavorName}** (Tier ${biz.tier}/${def.tiers.length})\n`;
  out += `📈 Income/6h: ${fmt(tierDef.income)} | 🧾 Upkeep/6h: ${fmt(tierDef.upkeep)}\n`;
  out += `🛡️ Security: ${secDef.label}\n`;
  out += `💰 Pending: ${fmt(biz.pending)} / ${fmt(tierDef.capacity)}\n`;
  if (biz.upkeep_owed > 0) out += `⚠️ Upkeep owed: **${fmt(biz.upkeep_owed)}** (income paused until paid)\n`;
  return out;
}

module.exports = {
  initBusinesses, BUSINESS_TYPES, SECURITY_LEVELS, SECURITY_UPGRADE_COST,
  buyBusiness, upgradeBusiness, upgradeSecurity, collectBusiness, payUpkeep, sellBusiness,
  getBusiness, getBusinessById, getUserBusinesses, processBusiness, runDailyBusinessProcessing,
  raidBusiness, getRaidCooldownRemaining, formatBusinessCard, getFlavorName, RAID_COOLDOWN_HOURS,
};
