const db = require("../config/db.config");
const { activateAllAddresses } = require("./addressActivation");
const { deriveAllWallets } = require("./walletDerivation");

/** Atomically get next HD index */
async function nextHdIndex(connection) {
  await connection.query(
    "UPDATE meta_ct_hd_index_counter SET next_index = next_index + 1 WHERE id = 1",
  );
  const [[row]] = await connection.query(
    "SELECT next_index FROM meta_ct_hd_index_counter WHERE id = 1",
  );
  return row.next_index - 1;
}

async function assignCryptoWallets(userId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const index = await nextHdIndex(connection);
    const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, index);

    await connection.query(
      `UPDATE meta_ct_user
          SET hd_index   = ?,
              wallet_trx = ?,
              wallet_eth = ?,
              wallet_btc = ?
        WHERE id = ?`,
      [index, wallets.trx, wallets.eth, wallets.btc, userId],
    );

    await connection.commit();

    const result = {
      hd_index: index,
      wallet_trx: wallets.trx,
      wallet_eth: wallets.eth,
      wallet_btc: wallets.btc,
    };

    activateAllAddresses(result).catch((err) =>
      console.error("[userWallets] Activation error:", err.message),
    );

    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function findUserByAddress(address) {
  const [[user]] = await db.query(
    `SELECT id, hd_index, wallet_trx, wallet_eth, wallet_btc
       FROM meta_ct_user
      WHERE wallet_trx = ?
         OR wallet_eth = ?
         OR wallet_btc = ?
      LIMIT 1`,
    [address, address, address],
  );
  return user || null;
}

module.exports = { assignCryptoWallets, findUserByAddress };
