const db = require("../config/db.config");
const referralHistoryModel = require("../models/referralHistory.model");

async function creditReferralCommission({ triggerUserId, coinId, baseAmount }) {
  try {
    const [[settings]] = await db.query("SELECT * FROM settings WHERE id = 1");

    if (!settings) {
      console.log("[Referral] No settings row found, skipping.");
      return { credited: false, reason: "settings not configured" };
    }

    if (settings.referral_deposit_bonus_status !== "enabled") {
      console.log("[Referral] Deposit referral bonus is disabled.");
      return { credited: false, reason: "deposit referral bonus disabled" };
    }

    const pct = parseFloat(settings.referral_deposit_bonus || 0);
    if (pct <= 0) {
      console.log("[Referral] referral_deposit_bonus is 0, skipping.");
      return { credited: false, reason: "commission rate is 0" };
    }

    const [[triggerUser]] = await db.query(
      `SELECT u.id, u.referred_by, ref.id AS referrer_id
   FROM meta_ct_user u
   LEFT JOIN meta_ct_user ref ON ref.referral_uuid = u.referred_by
   WHERE u.id = ?`,
      [triggerUserId],
    );

    if (!triggerUser?.referrer_id) {
      return { credited: false, reason: "user has no referrer" };
    }

    const referrerId = triggerUser.referrer_id;

    const commissionAmount = parseFloat(((baseAmount * pct) / 100).toFixed(7));
    if (commissionAmount <= 0) {
      return { credited: false, reason: "commission rounds to 0", referrerId };
    }

    await referralHistoryModel.createReferralHistory({
      user_id: referrerId,
      user_by: triggerUserId,
      type: "deposit",
      coin_id: coinId,
      percent: pct.toString(),
      amount: commissionAmount,
    });

    await db.query(
      `UPDATE meta_ct_user_balance_meta
       SET coin_amount = coin_amount + ?
       WHERE user_id = ? AND coin_id = ?`,
      [commissionAmount, referrerId, coinId],
    );

    await db.query(
      `UPDATE meta_ct_user
       SET referral_bonus = referral_bonus + ?
       WHERE id = ?`,
      [commissionAmount, referrerId],
    );

    console.log(
      `[Referral] ✓ referrer=${referrerId} earned ${commissionAmount} ` +
        `(${pct}% of ${baseAmount}) from deposit by user=${triggerUserId}`,
    );

    return { credited: true, referrerId, commissionAmount, pct };
  } catch (err) {
    console.error("[Referral] error:", err.message);
    return { credited: false, reason: err.message };
  }
}

module.exports = { creditReferralCommission };
