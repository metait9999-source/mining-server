const db = require("../config/db.config");
const axios = require("axios");
const { creditReferralCommission } = require("../services/referral.service");

const CHAIN_COIN_MAP = {
  trx: "TRX",
  usdt_trc20: "USDT-TRC20",
  eth: "ETH",
  usdt_erc20: "USDT-ERC20",
  btc: "BTC",
};

const COINLORE_IDS = {
  trx: 87,
  eth: 80,
  btc: 90,
  usdt_trc20: null,
  usdt_erc20: null,
};

async function getCoinPriceUSD(chain) {
  const id = COINLORE_IDS[chain];
  if (!id) return 1;
  try {
    const res = await axios.get(
      `https://api.coinlore.net/api/ticker/?id=${id}`,
    );
    const price = parseFloat(res.data?.[0]?.price_usd);
    return isNaN(price) ? 1 : price;
  } catch {
    console.error(
      `[getCoinPriceUSD] Failed to fetch price for ${chain}, defaulting to 1`,
    );
    return 1;
  }
}

async function isAlreadyProcessed(txHash, chain) {
  const [[row]] = await db.query(
    "SELECT id FROM meta_ct_chain_deposits WHERE tx_hash = ? AND chain = ?",
    [txHash, chain],
  );
  return !!row;
}

async function creditDeposit({
  userId,
  chain,
  txHash,
  fromAddress,
  toAddress,
  amount,
}) {
  if (await isAlreadyProcessed(txHash, chain)) {
    console.log(
      `[chainDeposit] Already processed tx=${txHash} chain=${chain}, skipping.`,
    );
    return null;
  }

  const coinId = CHAIN_COIN_MAP[chain];
  if (!coinId) throw new Error(`Unknown chain: ${chain}`);

  const priceUSD = await getCoinPriceUSD(chain);
  const usdAmount = parseFloat((amount * priceUSD).toFixed(7));

  console.log(
    `[chainDeposit] ${amount} ${chain} × $${priceUSD} = $${usdAmount} USD` +
      ` | user=${userId} tx=${txHash}`,
  );

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [insertResult] = await connection.query(
      `INSERT INTO meta_ct_chain_deposits
         (user_id, chain, coin_id, tx_hash, from_address, to_address, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
      [userId, chain, coinId, txHash, fromAddress || null, toAddress, amount],
    );
    const depositId = insertResult.insertId;

    await connection.query(
      `INSERT INTO meta_ct_user_balance_meta (user_id, coin_id, coin_amount, usd_amount)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         coin_amount = coin_amount + VALUES(coin_amount),
         usd_amount  = usd_amount  + VALUES(usd_amount)`,
      [userId, coinId, usdAmount, usdAmount],
    );

    await connection.query(
      "UPDATE meta_ct_user SET trade_limit = 50 WHERE id = ?",
      [userId],
    );

    await connection.commit();

    try {
      await creditReferralCommission({
        triggerUserId: userId,
        coinId,
        baseAmount: usdAmount,
      });
    } catch (refErr) {
      console.error(
        "[chainDeposit] Referral commission error:",
        refErr.message,
      );
    }

    return { depositId, coinId, rawAmount: amount, usdAmount };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function markSwept(depositId, sweptTx) {
  await db.query(
    "UPDATE meta_ct_chain_deposits SET status = 'swept', swept_tx = ? WHERE id = ?",
    [sweptTx, depositId],
  );
}

async function getUnswept() {
  const [rows] = await db.query(
    "SELECT * FROM meta_ct_chain_deposits WHERE status = 'confirmed'",
  );
  return rows;
}

module.exports = { creditDeposit, markSwept, getUnswept, isAlreadyProcessed };
