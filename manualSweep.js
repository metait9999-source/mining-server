// manualSweep.js
require("dotenv").config();
const { sweepChain } = require("./services/sweep");
const db = require("./config/db.config");

async function sweepAllUsers() {
  const [users] = await db.query(
    `SELECT id, hd_index, wallet_trx, wallet_eth, wallet_btc 
       FROM meta_ct_user 
      WHERE hd_index IS NOT NULL`,
  );

  console.log(`Found ${users.length} users to sweep`);

  for (const user of users) {
    console.log(
      `\nSweeping user ${user.id} | index ${user.hd_index} | ${user.wallet_trx}`,
    );

    try {
      // TRX sweep
      const trxTx = await sweepChain("trx", user.hd_index);
      if (trxTx) console.log(`✅ TRX swept: ${trxTx}`);
      else console.log(`⚠️ TRX: nothing to sweep`);

      // USDT-TRC20 sweep
      const usdtTx = await sweepChain("usdt_trc20", user.hd_index);
      if (usdtTx) console.log(`✅ USDT swept: ${usdtTx}`);
      else console.log(`⚠️ USDT: nothing to sweep`);
    } catch (err) {
      console.error(`❌ User ${user.id} sweep error:`, err.message);
    }

    // Rate limit এড়াতে delay
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\n✅ Done");
  process.exit(0);
}

sweepAllUsers();
