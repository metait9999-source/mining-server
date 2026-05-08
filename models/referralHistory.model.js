const db = require("../config/db.config");

async function getAllReferralHistories() {
  try {
    const [rows] = await db.query("SELECT * FROM meta_ct_referral_history");
    return rows;
  } catch (error) {
    throw new Error(error.message);
  }
}

// Get a referral history by ID
async function getReferralHistoryById(id) {
  try {
    const [rows] = await db.query(
      "SELECT * FROM meta_ct_referral_history WHERE id = ?",
      [id],
    );
    return rows[0];
  } catch (error) {
    throw new Error(error.message);
  }
}

async function getReferralHistoryByUserId(userId) {
  try {
    const [rows] = await db.query(
      `SELECT
         rh.*,
         u.name  AS referred_user_name,
         u.email AS referred_user_email,
         u.uuid  AS referred_user_uuid
       FROM meta_ct_referral_history rh
       LEFT JOIN meta_ct_user u ON u.id = rh.user_by
       WHERE rh.user_id = ?
       ORDER BY rh.created_at DESC`,
      [userId],
    );
    return rows;
  } catch (error) {
    throw new Error(error.message);
  }
}

async function getReferralSummary(userId) {
  try {
    const [[referrer]] = await db.query(
      "SELECT referral_uuid FROM meta_ct_user WHERE id = ?",
      [userId],
    );

    const [[userCount]] = await db.query(
      "SELECT COUNT(*) AS total_referred_users FROM meta_ct_user WHERE referred_by = ?",
      [referrer?.referral_uuid || ""],
    );

    const [rows] = await db.query(
      `SELECT
         COALESCE(SUM(amount), 0) AS total_commission_earned,
         COALESCE(SUM(CASE WHEN type = 'deposit'   THEN amount ELSE 0 END), 0) AS deposit_commission,
         COALESCE(SUM(CASE WHEN type = 'mining'    THEN amount ELSE 0 END), 0) AS mining_commission,
         COALESCE(SUM(CASE WHEN type = 'arbitrage' THEN amount ELSE 0 END), 0) AS arbitrage_commission
       FROM meta_ct_referral_history
       WHERE user_id = ?`,
      [userId],
    );

    return { ...rows[0], total_referred_users: userCount.total_referred_users };
  } catch (error) {
    throw new Error(error.message);
  }
}

async function createReferralHistory(referralHistoryData) {
  try {
    const [result] = await db.query(
      "INSERT INTO meta_ct_referral_history SET ?",
      referralHistoryData,
    );
    return result.insertId;
  } catch (error) {
    throw new Error(error.message);
  }
}

// Update a referral history by ID
async function updateReferralHistory(id, referralHistoryData) {
  try {
    const [result] = await db.query(
      "UPDATE meta_ct_referral_history SET ? WHERE id = ?",
      [referralHistoryData, id],
    );
    return result.affectedRows;
  } catch (error) {
    throw new Error(error.message);
  }
}

// Delete a referral history by ID
async function deleteReferralHistory(id) {
  try {
    const [result] = await db.query(
      "DELETE FROM meta_ct_referral_history WHERE id = ?",
      [id],
    );
    return result.affectedRows;
  } catch (error) {
    throw new Error(error.message);
  }
}

module.exports = {
  getAllReferralHistories,
  getReferralHistoryById,
  getReferralHistoryByUserId, // NEW
  getReferredUsersByUserId, // NEW
  getReferralSummary, // NEW
  createReferralHistory,
  updateReferralHistory,
  deleteReferralHistory,
};
