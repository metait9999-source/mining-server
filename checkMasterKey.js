// scripts/checkMasterKey.js
require("dotenv").config();
const { TronWeb } = require("tronweb");

const tronWeb = new TronWeb({
  fullHost: "https://api.trongrid.io",
  headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
  privateKey: process.env.SWEEP_PRIVATE_KEY_TRX,
});

async function main() {
  const address = tronWeb.address.fromPrivateKey(
    process.env.SWEEP_PRIVATE_KEY_TRX,
  );
  const balSun = await tronWeb.trx.getBalance(address);
  console.log(`Address : ${address}`);
  console.log(`Balance : ${balSun / 1_000_000} TRX`);
  console.log(
    address === "TPxffP7ysBSUyG37i1YjCdx1NKawugisTm"
      ? "✅ Correct key!"
      : "❌ Wrong key!",
  );
}

main();
