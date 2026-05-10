const db = require("../config/db.config");
const referralHistoryModel = require("../models/referralHistory.model");

/**
 * Credit referral commission to the referrer.
 * baseAmount is ALWAYS USD — no coin conversion needed here.
 */
async function creditReferralCommission({ triggerUserId, coinId, baseAmount }) {
  try {
    // 1. Load settings
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

    // 2. Find referrer
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

    // 3. Idempotency — skip if already credited within 5 minutes
    const [[recentCredit]] = await db.query(
      `SELECT id FROM meta_ct_referral_history
        WHERE user_by    = ?
          AND coin_id    = ?
          AND type       = 'deposit'
          AND created_at > NOW() - INTERVAL 5 MINUTE`,
      [triggerUserId, coinId],
    );
    if (recentCredit) {
      console.log(
        `[Referral] Already credited for user=${triggerUserId}, skipping.`,
      );
      return { credited: false, reason: "already credited recently" };
    }

    // 4. Calculate commission — baseAmount is USD so result is USD
    const commissionUSD = parseFloat(((baseAmount * pct) / 100).toFixed(7));
    if (commissionUSD <= 0) {
      return { credited: false, reason: "commission rounds to 0" };
    }

    console.log(
      `[Referral] ${pct}% of $${baseAmount} = $${commissionUSD} USD` +
        ` → referrer=${referrerId} from user=${triggerUserId}`,
    );

    // 5. Record history
    await referralHistoryModel.createReferralHistory({
      user_id: referrerId,
      user_by: triggerUserId,
      type: "deposit",
      coin_id: coinId,
      percent: pct.toString(),
      amount: commissionUSD, // always USD
    });

    // 6. Credit referrer balance — both columns store USD
    await db.query(
      `INSERT INTO meta_ct_user_balance_meta (user_id, coin_id, coin_amount, usd_amount)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         coin_amount = coin_amount + VALUES(coin_amount),
         usd_amount  = usd_amount  + VALUES(usd_amount)`,
      [referrerId, coinId, commissionUSD, commissionUSD],
    );

    // 7. Update referrer total bonus tracker
    await db.query(
      "UPDATE meta_ct_user SET referral_bonus = referral_bonus + ? WHERE id = ?",
      [commissionUSD, referrerId],
    );

    console.log(
      `[Referral] ✅ referrer=${referrerId} earned $${commissionUSD} USD` +
        ` (${pct}% of $${baseAmount}) from deposit by user=${triggerUserId}`,
    );

    return { credited: true, referrerId, commissionUSD, pct };
  } catch (err) {
    console.error("[Referral] error:", err.message);
    return { credited: false, reason: err.message };
  }
}

module.exports = { creditReferralCommission };
