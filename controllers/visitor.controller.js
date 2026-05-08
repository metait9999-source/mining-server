const crypto = require("crypto");
const Visitor = require("../models/visitor.model");
const DailyStat = require("../models/dailyStat.model");

function makeFingerprint(ip, ua, extra = "") {
  return crypto
    .createHash("sha256")
    .update(`${ip}|${ua}|${extra}`)
    .digest("hex");
}

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  ).trim();
}

const VisitorController = {
  async track(req, res) {
    try {
      const ip = getClientIP(req);
      const ua = req.headers["user-agent"] || "unknown";
      const extra = req.body?.extra || "";
      const fingerprint = makeFingerprint(ip, ua, extra);

      const { isNew } = await Visitor.upsert(fingerprint, ip, ua);
      await DailyStat.upsert(isNew);

      const [totalUnique, today] = await Promise.all([
        Visitor.getTotalUnique(),
        DailyStat.getToday(),
      ]);

      return res.status(200).json({
        unique: isNew,
        totalUnique,
        todayUnique: today.unique_visitors,
        todayTotal: today.total_visits,
      });
    } catch (err) {
      console.error("[VisitorController.track]", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async stats(req, res) {
    try {
      const days = Math.min(parseInt(req.query.days) || 30, 365);

      const [totalUnique, totalVisits, today, daily] = await Promise.all([
        Visitor.getTotalUnique(),
        Visitor.getTotalVisits(),
        DailyStat.getToday(),
        DailyStat.getLastDays(days),
      ]);

      return res.status(200).json({
        totalUnique,
        totalVisits,
        today,
        daily,
      });
    } catch (err) {
      console.error("[VisitorController.stats]", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  },
};

module.exports = VisitorController;
