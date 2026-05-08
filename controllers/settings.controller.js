const Settings = require("../models/settings.model");

// Get all settings
exports.getSettings = async (req, res) => {
  try {
    const settings = await Settings.getAllSettings();
    res.status(200).json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update settings
exports.updateSettings = async (req, res) => {
  const settingsData = req.body;
  try {
    await Settings.updateSettings(settingsData);
    res.status(200).json({ message: "Settings updated successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
