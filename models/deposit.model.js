const db = require("../config/db.config");
const fs = require("fs");
const path = require("path");
const { creditReferralCommission } = require("../services/referral.service");

class Deposit {
  static async getAll() {
    const query = `
      SELECT d.*, u.uuid AS user_uuid, w.coin_name
      FROM meta_ct_deposits AS d
      JOIN meta_ct_user    AS u ON d.user_id = u.id
      JOIN meta_ct_wallets AS w ON d.coin_id = w.coin_id
    `;
    const [rows] = await db.query(query);
    return rows;
  }

  static async getById(id) {
    const [rows] = await db.query(
      "SELECT * FROM meta_ct_deposits WHERE id = ?",
      [id],
    );
    return rows[0];
  }

  static async create(depositData) {
    const [result] = await db.query(
      "INSERT INTO meta_ct_deposits SET ?",
      depositData,
    );
    return result.insertId;
  }

  static async update(id, depositData) {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // ── Delete file from disk if documents set to null ──
      if ("documents" in depositData && depositData.documents === null) {
        const [existing] = await connection.query(
          "SELECT documents FROM meta_ct_deposits WHERE id = ?",
          [id],
        );
        const existingPath = existing[0]?.documents;
        if (existingPath) {
          fs.unlink(path.resolve(existingPath), (err) => {
            if (err)
              console.error("Failed to delete deposit image:", err.message);
          });
        }
      }

      // ── Run the update ──
      const [result] = await connection.query(
        "UPDATE meta_ct_deposits SET ? WHERE id = ?",
        [depositData, id],
      );

      // ── If approved: credit balance + set trade limit + referral commission ──
      if (result.affectedRows > 0 && depositData.status === "approved") {
        const [[deposit]] = await connection.query(
          "SELECT user_id, coin_id, amount FROM meta_ct_deposits WHERE id = ?",
          [id],
        );

        if (deposit) {
          const { user_id, coin_id, amount } = deposit;
          const depositAmount = parseFloat(amount);

          // 1. Credit user's wallet balance
          await connection.query(
            "UPDATE meta_ct_user_balance_meta SET coin_amount = coin_amount + ? WHERE user_id = ? AND coin_id = ?",
            [depositAmount, user_id, coin_id],
          );

          // 2. Set trade limit
          await connection.query(
            "UPDATE meta_ct_user SET trade_limit = ? WHERE id = ?",
            [50, user_id],
          );

          await connection.commit();
          connection.release();

          await creditReferralCommission({
            triggerUserId: user_id,
            type: "deposit",
            coinId: coin_id,
            baseAmount: depositAmount,
          });

          return result.affectedRows;
        }
      }

      await connection.commit();
      return result.affectedRows;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      // Only release if not already released above
      try {
        connection.release();
      } catch (_) {}
    }
  }

  static async delete(id) {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [existing] = await connection.query(
        "SELECT documents FROM meta_ct_deposits WHERE id = ?",
        [id],
      );
      const existingPath = existing[0]?.documents;
      if (existingPath) {
        fs.unlink(path.resolve(existingPath), (err) => {
          if (err)
            console.error("Failed to delete deposit image:", err.message);
        });
      }

      const [result] = await connection.query(
        "DELETE FROM meta_ct_deposits WHERE id = ?",
        [id],
      );

      await connection.commit();
      return result.affectedRows;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  static async getLatestDepositByUserIdAndCoinId(userId, coinId) {
    const [rows] = await db.query(
      `SELECT * FROM meta_ct_deposits
       WHERE user_id = ? AND coin_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [userId, coinId],
    );
    return rows[0];
  }

  static async getLatestDepositByUserId(userId) {
    const [rows] = await db.query(
      `SELECT d.*, w.coin_name, w.coin_symbol
       FROM meta_ct_deposits AS d
       JOIN meta_ct_wallets  AS w ON d.coin_id = w.coin_id
       WHERE d.user_id = ?
       ORDER BY d.created_at DESC`,
      [userId],
    );
    return rows;
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
