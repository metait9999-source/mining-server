const { db } = require("./config");
const { getUnswept } = require("./models/chainDeposit.model");
const { sweepChain } = require("./services/sweep");

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const VALID_CHAINS = ["trx", "usdt_trc20", "eth", "usdt_erc20", "btc"];

const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

// ─────────────────────────────────────────────────────────────────────────────

async function sweepUser(userId, chain) {
  console.log(`\n[sweep] Starting: user=${userId} chain=${chain}`);

  const [[user]] = await db.query(
    "SELECT id, hd_index, wallet_trx, wallet_eth, wallet_btc FROM meta_ct_user WHERE id = ?",
    [userId],
  );

  if (!user) throw new Error(`User ${userId} not found`);
  if (user.hd_index === null || user.hd_index === undefined) {
    throw new Error(`User ${userId} has no HD wallet assigned`);
  }

  console.log(`[sweep] Found user hd_index=${user.hd_index}`);

  const sweptTx = await sweepChain(chain, user.hd_index);

  if (!sweptTx) {
    console.log(
      `[sweep] ⚠️  Nothing to sweep — balance is zero or too low to cover fees`,
    );
    return;
  }

  console.log(`[sweep] ✅ Done! tx=${sweptTx}`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function sweepDeposit(depositId) {
  console.log(`\n[sweep] Starting: depositId=${depositId}`);

  const [[deposit]] = await db.query(
    "SELECT * FROM meta_ct_chain_deposits WHERE id = ?",
    [depositId],
  );

  if (!deposit) throw new Error(`Deposit ${depositId} not found`);

  if (deposit.status === "swept") {
    console.log(`[sweep] ⚠️  Already swept. swept_tx=${deposit.swept_tx}`);
    return;
  }

  const [[user]] = await db.query(
    "SELECT id, hd_index FROM meta_ct_user WHERE id = ?",
    [deposit.user_id],
  );

  if (!user) throw new Error(`User ${deposit.user_id} not found`);

  console.log(
    `[sweep] Found deposit user=${deposit.user_id} chain=${deposit.chain} hd_index=${user.hd_index}`,
  );

  const sweptTx = await sweepChain(deposit.chain, user.hd_index);

  if (!sweptTx) {
    console.log(`[sweep] ⚠️  Nothing to sweep — balance may already be gone`);
    return;
  }

  await markSwept(deposit.id, sweptTx);
  console.log(`[sweep] ✅ Done! tx=${sweptTx}`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function sweepAllPending() {
  console.log(`\n[sweep] Fetching all unswept confirmed deposits...`);

  const unswept = await getUnswept();

  if (!unswept.length) {
    console.log(`[sweep] ✅ No pending sweeps found`);
    return;
  }

  console.log(`[sweep] Found ${unswept.length} unswept deposits\n`);

  let succeeded = 0;
  let failed = 0;

  for (const deposit of unswept) {
    try {
      const [[user]] = await db.query(
        "SELECT id, hd_index FROM meta_ct_user WHERE id = ?",
        [deposit.user_id],
      );

      if (!user || user.hd_index === null || user.hd_index === undefined) {
        console.log(
          `[sweep] ⚠️  deposit=${deposit.id} — no HD index, skipping`,
        );
        failed++;
        continue;
      }

      console.log(
        `[sweep] Processing deposit=${deposit.id} user=${deposit.user_id} chain=${deposit.chain}`,
      );

      const sweptTx = await sweepChain(deposit.chain, user.hd_index);

      if (sweptTx) {
        await markSwept(deposit.id, sweptTx);
        console.log(`[sweep] ✅ deposit=${deposit.id} tx=${sweptTx}`);
        succeeded++;
      } else {
        console.log(`[sweep] ⚠️  deposit=${deposit.id} — nothing to sweep`);
        failed++;
      }
    } catch (err) {
      console.error(`[sweep] ❌ deposit=${deposit.id} error: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\n[sweep] Summary: total=${unswept.length} succeeded=${succeeded} failed=${failed}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Validate DB connection first
  try {
    const conn = await db.getConnection();
    console.log("[sweep] ✅ DB connected");
    conn.release();
  } catch (err) {
    console.error("[sweep] ❌ DB connection failed:", err.message);
    process.exit(1);
  }

  try {
    if (hasFlag("--all")) {
      // Sweep all pending unswept deposits
      await sweepAllPending();
    } else if (hasFlag("--user")) {
      // Sweep specific user + chain
      const userId = getArg("--user");
      const chain = getArg("--chain");

      if (!userId) {
        console.error("❌ --user <userId> is required");
        process.exit(1);
      }
      if (!chain) {
        console.error("❌ --chain <chain> is required");
        process.exit(1);
      }
      if (!VALID_CHAINS.includes(chain)) {
        console.error(`❌ Invalid chain. Valid: ${VALID_CHAINS.join(", ")}`);
        process.exit(1);
      }

      await sweepUser(parseInt(userId), chain);
    } else if (hasFlag("--deposit")) {
      // Sweep specific deposit by ID
      const depositId = getArg("--deposit");
      if (!depositId) {
        console.error("❌ --deposit <depositId> is required");
        process.exit(1);
      }

      await sweepDeposit(parseInt(depositId));
    } else {
      // Show usage
      console.log(`
Usage:
  node scripts/manualSweep.js --all
    → Sweep all confirmed but unswept deposits

  node scripts/manualSweep.js --user <userId> --chain <chain>
    → Sweep a specific user on a specific chain
    → Chains: ${VALID_CHAINS.join(", ")}

  node scripts/manualSweep.js --deposit <depositId>
    → Sweep a specific deposit record by ID

Examples:
  node scripts/manualSweep.js --all
  node scripts/manualSweep.js --user 68 --chain usdt_trc20
  node scripts/manualSweep.js --user 68 --chain trx
  node scripts/manualSweep.js --deposit 12
      `);
      process.exit(0);
    }
  } catch (err) {
    console.error(`\n[sweep] ❌ Fatal error: ${err.message}`);
    process.exit(1);
  }

  process.exit(0);
}

main();
