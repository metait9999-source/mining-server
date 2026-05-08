const db = require("../config/db.config");

class Settings {
  static async getAllSettings() {
    const [rows] = await db.query("SELECT * FROM settings WHERE id = 1");
    return rows[0];
  }

  static async updateSettings(settingsData) {
    const [result] = await db.query(
      `
      INSERT INTO settings SET id = 1, ?
      ON DUPLICATE KEY UPDATE ?
    `,
      [settingsData, settingsData],
    );
    return result.affectedRows;
  }
}

module.exports = Settings;
