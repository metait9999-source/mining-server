const db = require("../config/db.config");

class Deposit {
  static async getAll() {
    const [rows] = await db.query(`
      SELECT
        d.*,
        u.uuid     AS user_uuid,
        u.username AS user_username,
        u.email    AS user_email,
        w.coin_name,
        w.coin_symbol
      FROM meta_ct_deposits AS d
      JOIN meta_ct_user    AS u ON d.user_id = u.id
      JOIN meta_ct_wallets AS w ON d.coin_id  = w.coin_id
      ORDER BY d.created_at DESC
    `);
    return rows;
  }

  static async getById(id) {
    const [rows] = await db.query(
      `SELECT
         d.*,
         u.uuid     AS user_uuid,
         u.username AS user_username,
         u.email    AS user_email,
         w.coin_name,
         w.coin_symbol
       FROM meta_ct_deposits AS d
       JOIN meta_ct_user    AS u ON d.user_id = u.id
       JOIN meta_ct_wallets AS w ON d.coin_id  = w.coin_id
       WHERE d.id = ?`,
      [id],
    );
    return rows[0] || null;
  }

  static async create({
    userId,
    coinId,
    walletFrom,
    walletTo,
    txHash,
    usdAmount,
    status = "approved",
  }) {
    const [result] = await db.query(
      `INSERT IGNORE INTO meta_ct_deposits
         (user_id, coin_id, wallet_from, wallet_to, trans_hash, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        coinId,
        walletFrom || "",
        walletTo,
        txHash || null,
        usdAmount,
        status,
      ],
    );
    return result.insertId;
  }

  static async getByUserId(userId) {
    const [rows] = await db.query(
      `SELECT
         d.*,
         w.coin_name,
         w.coin_symbol
       FROM meta_ct_deposits AS d
       JOIN meta_ct_wallets  AS w ON d.coin_id = w.coin_id
       WHERE d.user_id = ?
       ORDER BY d.created_at DESC`,
      [userId],
    );
    return rows;
  }

  static async delete(id) {
    const [result] = await db.query(
      "DELETE FROM meta_ct_deposits WHERE id = ?",
      [id],
    );
    return result.affectedRows;
  }

  static async getUnseenCount() {
    const [[row]] = await db.query(
      "SELECT COUNT(*) AS count FROM meta_ct_deposits WHERE is_seen = 0",
    );
    return row.count;
  }

  static async markAllSeen() {
    await db.query("UPDATE meta_ct_deposits SET is_seen = 1 WHERE is_seen = 0");
  }
}

module.exports = Deposit;
