// models/dailyStat.model.js
const db = require("../config").db;

class DailyStat {
  static async upsert(isNewVisitor) {
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    const [existing] = await db.query(
      "SELECT date FROM daily_stats WHERE date = ?",
      [today],
    );

    if (existing.length === 0) {
      await db.query(
        `INSERT INTO daily_stats (date, unique_visitors, total_visits)
         VALUES (?, ?, 1)`,
        [today, isNewVisitor ? 1 : 0],
      );
    } else {
      await db.query(
        `UPDATE daily_stats
         SET total_visits    = total_visits + 1,
             unique_visitors = unique_visitors + ?
         WHERE date = ?`,
        [isNewVisitor ? 1 : 0, today],
      );
    }
  }

  static async getToday() {
    const today = new Date().toISOString().slice(0, 10);
    const [rows] = await db.query("SELECT * FROM daily_stats WHERE date = ?", [
      today,
    ]);
    return rows[0] ?? { date: today, unique_visitors: 0, total_visits: 0 };
  }

  static async getLastDays(days = 30) {
    const [rows] = await db.query(
      `SELECT * FROM daily_stats
       ORDER BY date DESC
       LIMIT ?`,
      [days],
    );
    return rows;
  }
}

module.exports = DailyStat;
