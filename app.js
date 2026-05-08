const express = require("express");
const cors = require("cors");
const path = require("path");
const { db } = require("./config");
require("dotenv").config();

const userRoutes = require("./routes/user.routes");
const depositRoutes = require("./routes/deposit.routes");
const withdrawRoutes = require("./routes/withdraw.routes");
const userBalanceMetaRoutes = require("./routes/userBalanceMeta.routes");
const referralRoutes = require("./routes/referralHistory.routes");
const walletRoutes = require("./routes/wallet.routes");
const timerProfitRoutes = require("./routes/timerProfit.routes");
const settingsRoutes = require("./routes/settings.routes");
const resetRoutes = require("./routes/reset.routes");
const messageRoutes = require("./routes/message.routes");
const conversationRoutes = require("./routes/conversation.routes");
const permissionsRoutes = require("./routes/permissions.routes");
const arbitrageRoutes = require("./routes/arbitrage.routes");
const miningRoutes = require("./routes/mining.routes");
const visitorRoutes = require("./routes/visitor.routes");
const { app, server } = require("./socket/socket");
const { retryPendingDeposits } = require("./models/depositRequest.model");
require("./cron/arbitragePayout.cron");
require("./cron/miningPayout.cron");

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/v1/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/deposits", depositRoutes);
app.use("/api/v1/withdraws", withdrawRoutes);
app.use("/api/v1/userbalance", userBalanceMetaRoutes);
app.use("/api/v1/referral", referralRoutes);
app.use("/api/v1/wallets", walletRoutes);
app.use("/api/v1/timerprofits", timerProfitRoutes);
app.use("/api/v1/settings", settingsRoutes);
app.use("/api/v1/permissions", permissionsRoutes);
app.use("/api/v1/reset", resetRoutes);

app.use("/api/v1/messages", messageRoutes);
app.use("/api/v1/conversation", conversationRoutes);
app.use("/api/v1/arbitrage", arbitrageRoutes);
app.use("/api/v1/mining", miningRoutes);
app.use("/api/v1/2fa", require("./routes/twofa.routes"));
app.use("/api/v1/chat-faqs", require("./routes/chatFaq.routes"));
app.use("/api/v1/visitors", visitorRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

app.get("/", (req, res) => {
  res.send("Hi, Welcome to crypto trade api");
});

server.listen(PORT, () => {
  console.log(`Server is running on ${PORT}`);
  setInterval(async () => {
    try {
      await retryPendingDeposits();
    } catch (err) {
      console.error("[retryPending] Error:", err.message);
    }
  }, 50000);
});

(async () => {
  try {
    const connection = await db.getConnection();
    console.log("Database connection successful");
    connection.release();
  } catch (err) {
    console.error("Database connection failed:", err);
  }
})();
