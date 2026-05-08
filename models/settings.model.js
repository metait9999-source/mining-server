const db = require("../config/db.config");

class Settings {
  static async getAllSettings() {
    const [rows] = await db.query("SELECT * FROM settings WHERE id = 1");
    return rows[0];
  }

  static async updateSettings(settingsData) {
    const fields = Object.keys(settingsData)
      .map((key) => `${key} = ?`)
      .join(", ");

    const values = Object.values(settingsData);

    await db.query(`UPDATE settings SET ${fields} WHERE id = 1`, values);
  }
}

module.exports = Settings;
