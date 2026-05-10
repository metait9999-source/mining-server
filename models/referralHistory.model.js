const db = require("../config/db.config");

async function getAllReferralHistories() {
  const [rows] = await db.query(`
    SELECT
      rh.*,
      referrer.uuid  AS referrer_uuid,
      referrer.name  AS referrer_name,
      referrer.email AS referrer_email,
      referred.uuid  AS referred_uuid,
      referred.name  AS referred_name,
      referred.email AS referred_email
    FROM meta_ct_referral_history rh
    LEFT JOIN meta_ct_user referrer ON referrer.id = rh.user_id
    LEFT JOIN meta_ct_user referred ON referred.id = rh.user_by
    ORDER BY rh.created_at DESC
  `);
  return rows;
}

async function getReferralHistoryById(id) {
  const [rows] = await db.query(
    "SELECT * FROM meta_ct_referral_history WHERE id = ?",
    [id],
  );
  return rows[0] || null;
}

async function getReferralHistoryByUserId(userId) {
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
}

async function getReferredUsersByUserId(userId) {
  const [[referrer]] = await db.query(
    "SELECT referral_uuid FROM meta_ct_user WHERE id = ?",
    [userId],
  );
  if (!referrer?.referral_uuid) return [];

  const [rows] = await db.query(
    `SELECT
       u.id,
       u.uuid,
       u.name,
       u.email,
       u.user_registered,
       u.status,
       COALESCE(SUM(rh.amount), 0) AS total_commission_earned_usd
     FROM meta_ct_user u
     LEFT JOIN meta_ct_referral_history rh
       ON rh.user_by = u.id AND rh.user_id = ?
     WHERE u.referred_by = ?
     GROUP BY u.id
     ORDER BY u.user_registered DESC`,
    [userId, referrer.referral_uuid],
  );
  return rows;
}

async function getReferralSummary(userId) {
  const [[referrer]] = await db.query(
    "SELECT referral_uuid FROM meta_ct_user WHERE id = ?",
    [userId],
  );

  const [[userCount]] = await db.query(
    "SELECT COUNT(*) AS total_referred_users FROM meta_ct_user WHERE referred_by = ?",
    [referrer?.referral_uuid || ""],
  );

  const [[commission]] = await db.query(
    `SELECT
       COALESCE(SUM(amount), 0) AS total_commission_usd,
       COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS deposit_commission_usd
     FROM meta_ct_referral_history
     WHERE user_id = ?`,
    [userId],
  );

  return {
    total_referred_users: userCount.total_referred_users,
    total_commission_usd: commission.total_commission_usd,
    deposit_commission_usd: commission.deposit_commission_usd,
  };
}

async function createReferralHistory(data) {
  const [result] = await db.query(
    "INSERT INTO meta_ct_referral_history SET ?",
    data,
  );
  return result.insertId;
}

async function updateReferralHistory(id, data) {
  const [result] = await db.query(
    "UPDATE meta_ct_referral_history SET ? WHERE id = ?",
    [data, id],
  );
  return result.affectedRows;
}

async function deleteReferralHistory(id) {
  const [result] = await db.query(
    "DELETE FROM meta_ct_referral_history WHERE id = ?",
    [id],
  );
  return result.affectedRows;
}

module.exports = {
  getAllReferralHistories,
  getReferralHistoryById,
  getReferralHistoryByUserId,
  getReferredUsersByUserId,
  getReferralSummary,
  createReferralHistory,
  updateReferralHistory,
  deleteReferralHistory,
};
