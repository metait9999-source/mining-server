/**
 * chainDeposit.model.js
 *
 * Handles recording on-chain deposits, crediting user balances,
 * and tracking sweep status — all in one atomic transaction.
 */

const db = require("../config/db.config");
const { creditReferralCommission } = require("../services/referral.service");

/**
 * Chain → coin_id mapping.
 * Adjust these to match your meta_ct_wallets.coin_id values exactly.
 */
const CHAIN_COIN_MAP = {
  trx: "TRX",
  usdt_trc20: "USDT-TRC20",
  eth: "ETH",
  usdt_erc20: "USDT-ERC20",
  btc: "BTC",
};

/**
 * Check whether a tx_hash + chain combo has already been processed.
 * Prevents double-crediting on re-polls.
 */
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
  // Idempotency guard — if already recorded, skip
  if (await isAlreadyProcessed(txHash, chain)) {
    console.log(
      `[chainDeposit] Already processed tx ${txHash} on ${chain}, skipping.`,
    );
    return null;
  }

  const coinId = CHAIN_COIN_MAP[chain];
  if (!coinId) throw new Error(`Unknown chain: ${chain}`);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Insert deposit record
    const [insertResult] = await connection.query(
      `INSERT INTO meta_ct_chain_deposits
         (user_id, chain, coin_id, tx_hash, from_address, to_address, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
      [userId, chain, coinId, txHash, fromAddress, toAddress, amount],
    );
    const depositId = insertResult.insertId;

    // 2. Ensure a balance row exists (upsert)
    await connection.query(
      `INSERT INTO meta_ct_user_balance_meta (user_id, coin_id, coin_amount, usd_amount)
       VALUES (?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE updated_at = updated_at`,
      [userId, coinId],
    );

    // 3. Credit the balance
    await connection.query(
      `UPDATE meta_ct_user_balance_meta
          SET coin_amount = coin_amount + ?
        WHERE user_id = ? AND coin_id = ?`,
      [amount, userId, coinId],
    );

    // 4. Set trade limit (mirrors existing deposit approval logic)
    await connection.query(
      "UPDATE meta_ct_user SET trade_limit = 50 WHERE id = ?",
      [userId],
    );

    await connection.commit();

    // 5. Referral commission (outside transaction — non-fatal if it fails)
    try {
      await creditReferralCommission({
        triggerUserId: userId,
        type: "deposit",
        coinId,
        baseAmount: amount,
      });
    } catch (refErr) {
      console.error(
        "[chainDeposit] Referral commission error:",
        refErr.message,
      );
    }

    return { depositId, coinId, amount };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Mark a deposit record as swept (after funds moved to master wallet).
 */
async function markSwept(depositId, sweptTx) {
  await db.query(
    "UPDATE meta_ct_chain_deposits SET status = 'swept', swept_tx = ? WHERE id = ?",
    [sweptTx, depositId],
  );
}

/**
 * Get all unswept confirmed deposits (used by sweep cron if needed).
 */
async function getUnswept() {
  const [rows] = await db.query(
    "SELECT * FROM meta_ct_chain_deposits WHERE status = 'confirmed'",
  );
  return rows;
}

module.exports = { creditDeposit, markSwept, getUnswept, isAlreadyProcessed };
