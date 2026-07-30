// One-off script: strips "rob_shield" out of EVERY stored inventory row.
// Run once from your bot's environment (needs SUPABASE_URL + SUPABASE_KEY set,
// same as the bot itself — e.g. `node reset-rob-shields.js` after `require("dotenv").config()`
// or with those two vars exported in your shell).
//
// Usage:
//   node reset-rob-shields.js          -> dry run, just reports how many would be affected
//   node reset-rob-shields.js --apply  -> actually writes the change back to Supabase

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_KEY must be set in the environment.");
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data, error } = await supabase.from("inventories").select("*");
  if (error) {
    console.error("Failed to load inventories:", error.message);
    process.exit(1);
  }

  let affected = 0;
  for (const row of data || []) {
    let inv;
    try {
      inv = JSON.parse(row.inventory);
    } catch {
      continue;
    }
    if (!inv.rob_shield) continue;

    affected++;
    delete inv.rob_shield;

    console.log(`${APPLY ? "Clearing" : "Would clear"} rob_shield for user ${row.user_id}`);

    if (APPLY) {
      const { error: upErr } = await supabase
        .from("inventories")
        .upsert({ user_id: row.user_id, inventory: JSON.stringify(inv) }, { onConflict: "user_id" });
      if (upErr) console.error(`  Failed to save for ${row.user_id}:`, upErr.message);
    }
  }

  console.log(
    APPLY
      ? `\nDone. Cleared rob_shield from ${affected} player(s).`
      : `\nDry run complete. ${affected} player(s) have a rob_shield entry. Re-run with --apply to actually clear them.`
  );
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
