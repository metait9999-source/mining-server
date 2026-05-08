const db = require("../config").db;

class Visitor {
  static async upsert(fingerprint, ip, userAgent) {
    const [result] = await db.query(
      `INSERT INTO visitors (fingerprint, ip, user_agent, first_seen, last_seen, visit_count)
       VALUES (?, ?, ?, NOW(), NOW(), 1)
       ON DUPLICATE KEY UPDATE
         visit_count = visit_count + 1,
         last_seen   = NOW()`,
      [fingerprint, ip, userAgent],
    );

    const isNew = result.insertId > 0;
    return { isNew };
  }

  static async getTotalUnique() {
    const [rows] = await db.query("SELECT COUNT(*) AS total FROM visitors");
    return rows[0].total;
  }

  static async getTotalVisits() {
    const [rows] = await db.query(
      "SELECT SUM(visit_count) AS total FROM visitors",
    );
    return rows[0].total ?? 0;
  }
}

module.exports = Visitor;
