const db = require("../config/db.config");

async function subscribe(userId, packageId, coinId, amount) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Validate package
    const [pkgRows] = await conn.query(
      "SELECT * FROM arbitrage_packages WHERE id = ? AND status = 1",
      [packageId],
    );
    const pkg = pkgRows[0];
    if (!pkg) throw new Error("Package not found or inactive");

    const minAmount = parseFloat(pkg.min_amount);
    const maxAmount = parseFloat(pkg.max_amount);
    const rateMin = parseFloat(pkg.daily_rate_min);
    const rateMax = parseFloat(pkg.daily_rate_max);

    // 2. Validate amount range
    if (amount < minAmount || amount > maxAmount) {
      throw new Error(`Amount must be between ${minAmount} and ${maxAmount}`);
    }

    // 3. Check user balance
    const [balRows] = await conn.query(
      "SELECT * FROM meta_ct_user_balance_meta WHERE user_id = ? AND coin_id = ? LIMIT 1",
      [userId, coinId],
    );

    if (balRows.length === 0) {
      throw new Error("Insufficient balance");
    }

    // coin_amount and usd_amount are always same USD value — read either one
    const currentBalance = parseFloat(balRows[0].usd_amount);
    if (currentBalance < amount) {
      throw new Error(`Insufficient balance. Available: $${currentBalance}`);
    }

    // 4. Deduct principal — update both columns
    await conn.query(
      `UPDATE meta_ct_user_balance_meta
         SET coin_amount = coin_amount - ?,
             usd_amount  = usd_amount  - ?,
             updated_at  = NOW()
       WHERE user_id = ? AND coin_id = ? LIMIT 1`,
      [amount, amount, userId, coinId],
    );

    // 5. Pick random daily rate
    const dailyRate = (Math.random() * (rateMax - rateMin) + rateMin).toFixed(
      2,
    );

    // 6. Calculate end date
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + pkg.duration_days);

    // 7. Create subscription
    const [result] = await conn.query(
      `INSERT INTO arbitrage_subscriptions
         (user_id, package_id, coin_id, amount, daily_rate, end_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, packageId, coinId, amount, dailyRate, endDate],
    );

    await conn.commit();
    return result.insertId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getByUserId(userId) {
  const [rows] = await db.query(
    `SELECT s.*, p.name AS package_name, p.duration_days
       FROM arbitrage_subscriptions s
       JOIN arbitrage_packages p ON s.package_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC`,
    [userId],
  );
  return rows;
}

async function getAll() {
  const [rows] = await db.query(
    `SELECT s.*, p.name AS package_name, p.duration_days,
            u.name AS user_name, u.uuid AS user_uuid
       FROM arbitrage_subscriptions s
       JOIN arbitrage_packages p ON s.package_id = p.id
       JOIN meta_ct_user u ON s.user_id = u.id
      ORDER BY s.created_at DESC`,
  );
  return rows;
}

async function getActiveDue() {
  const [rows] = await db.query(
    `SELECT s.*, p.duration_days
       FROM arbitrage_subscriptions s
       JOIN arbitrage_packages p ON s.package_id = p.id
      WHERE s.status = 'active'
        AND (s.last_paid_at IS NULL OR DATE(s.last_paid_at) < CURDATE())`,
  );
  return rows;
}

async function processPayout(subscriptionId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT * FROM arbitrage_subscriptions WHERE id = ? AND status = "active" LIMIT 1',
      [subscriptionId],
    );
    const sub = rows[0];
    if (!sub) throw new Error("Subscription not found or inactive");

    const isComplete = new Date() >= new Date(sub.end_date);
    const principal = parseFloat(sub.amount);
    const dailyRate = parseFloat(sub.daily_rate);
    const interest = parseFloat(((principal * dailyRate) / 100).toFixed(7));

    // 1. Credit daily interest — update both columns
    await conn.query(
      `UPDATE meta_ct_user_balance_meta
         SET coin_amount = coin_amount + ?,
             usd_amount  = usd_amount  + ?,
             updated_at  = NOW()
       WHERE user_id = ? AND coin_id = ? LIMIT 1`,
      [interest, interest, sub.user_id, sub.coin_id],
    );

    // 2. Log interest payout
    await conn.query(
      `INSERT INTO arbitrage_payouts (subscription_id, user_id, coin_id, amount, type)
       VALUES (?, ?, ?, ?, 'interest')`,
      [sub.id, sub.user_id, sub.coin_id, interest],
    );

    // 3. Update total_earned
    await conn.query(
      "UPDATE arbitrage_subscriptions SET total_earned = total_earned + ? WHERE id = ?",
      [interest, sub.id],
    );

    // 4. On completion — return principal, update both columns
    if (isComplete) {
      await conn.query(
        `UPDATE meta_ct_user_balance_meta
           SET coin_amount = coin_amount + ?,
               usd_amount  = usd_amount  + ?,
               updated_at  = NOW()
         WHERE user_id = ? AND coin_id = ? LIMIT 1`,
        [principal, principal, sub.user_id, sub.coin_id],
      );

      await conn.query(
        `INSERT INTO arbitrage_payouts (subscription_id, user_id, coin_id, amount, type)
         VALUES (?, ?, ?, ?, 'principal')`,
        [sub.id, sub.user_id, sub.coin_id, principal],
      );
    }

    // 5. Update subscription
    await conn.query(
      `UPDATE arbitrage_subscriptions
         SET last_paid_at = NOW(),
             status       = ?,
             updated_at   = NOW()
       WHERE id = ?`,
      [isComplete ? "completed" : "active", sub.id],
    );

    await conn.commit();
    return { interest, principal: isComplete ? principal : 0, isComplete };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function cancel(subscriptionId, userId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT * FROM arbitrage_subscriptions WHERE id = ? AND user_id = ? AND status = "active" LIMIT 1',
      [subscriptionId, userId],
    );
    const sub = rows[0];
    if (!sub) throw new Error("Active subscription not found");

    const principal = parseFloat(sub.amount);

    // Return principal — update both columns
    await conn.query(
      `UPDATE meta_ct_user_balance_meta
         SET coin_amount = coin_amount + ?,
             usd_amount  = usd_amount  + ?,
             updated_at  = NOW()
       WHERE user_id = ? AND coin_id = ? LIMIT 1`,
      [principal, principal, sub.user_id, sub.coin_id],
    );

    await conn.query(
      `INSERT INTO arbitrage_payouts (subscription_id, user_id, coin_id, amount, type)
       VALUES (?, ?, ?, ?, 'principal')`,
      [sub.id, sub.user_id, sub.coin_id, principal],
    );

    await conn.query(
      "UPDATE arbitrage_subscriptions SET status = 'cancelled', updated_at = NOW() WHERE id = ?",
      [sub.id],
    );

    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  subscribe,
  getByUserId,
  getAll,
  getActiveDue,
  processPayout,
  cancel,
};
