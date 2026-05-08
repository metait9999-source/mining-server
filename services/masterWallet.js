const db = require("../config/db.config");

// Cache for 5 minutes to avoid hammering DB on every sweep
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getMasterWallets() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;

  const [rows] = await db.query(
    `SELECT coin_id, wallet_address
       FROM meta_ct_wallets
      WHERE coin_id IN ('TRX','USDT-TRC20','ETH','USDT-ERC20','BTC')
        AND status = 'active'`,
  );

  const map = {};
  for (const row of rows) {
    map[row.coin_id] = row.wallet_address;
  }

  // Validate all required keys exist
  const required = ["TRX", "USDT-TRC20", "ETH", "USDT-ERC20", "BTC"];
  const missing = required.filter((k) => !map[k]);
  if (missing.length) {
    throw new Error(
      `Missing master wallet addresses in meta_ct_wallets for: ${missing.join(", ")}`,
    );
  }

  cache = {
    trx: map["TRX"],
    usdt_trc20: map["USDT-TRC20"],
    eth: map["ETH"],
    usdt_erc20: map["USDT-ERC20"],
    btc: map["BTC"],
  };
  cacheTime = Date.now();
  return cache;
}

/** Force-clear cache (call after wallet address is updated in admin panel) */
function clearMasterWalletCache() {
  cache = null;
  cacheTime = 0;
}

module.exports = { getMasterWallets, clearMasterWalletCache };
