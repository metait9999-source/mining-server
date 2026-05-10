const Deposit = require("../models/deposit.model");
const { checkAndCreditDeposit } = require("../models/depositRequest.model");
const { getReceiverSocketId, io } = require("../socket/socket");

// ── User: trigger on-chain deposit check for a coin ──────────────────────────
exports.checkDeposit = async (req, res) => {
  const { userId, coinId } = req.body;
  if (!userId || !coinId) {
    return res.status(400).json({ error: "userId and coinId are required" });
  }
  try {
    const result = await checkAndCreditDeposit({ userId, coinId });

    if (result.status === "credited") {
      // Notify depositing user
      const userSocket = getReceiverSocketId(userId);
      if (userSocket) {
        io.to(userSocket).emit("depositApproved", {
          coinId: result.coinId,
          rawAmount: result.rawAmount,
          usdAmount: result.usdAmount,
          txHash: result.txHash,
        });
      }
      // Notify admin
      const adminSocket = getReceiverSocketId(0);
      if (adminSocket) {
        io.to(adminSocket).emit("newDeposit", {
          userId,
          coinId: result.coinId,
          usdAmount: result.usdAmount,
          txHash: result.txHash,
        });
      }
    }

    res.json(result);
  } catch (err) {
    console.error("[checkDeposit]", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Admin: all deposits ───────────────────────────────────────────────────────
exports.getAllDeposits = async (req, res) => {
  try {
    res.json(await Deposit.getAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Admin: single deposit ─────────────────────────────────────────────────────
exports.getDepositById = async (req, res) => {
  try {
    const deposit = await Deposit.getById(req.params.id);
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });
    res.json(deposit);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── User: deposit history ─────────────────────────────────────────────────────
exports.getDepositsByUserId = async (req, res) => {
  try {
    const deposits = await Deposit.getByUserId(req.params.userId);
    if (!deposits?.length) {
      return res
        .status(404)
        .json({ message: "No deposits found for this user" });
    }
    res.json(deposits);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Admin: delete deposit ─────────────────────────────────────────────────────
exports.deleteDeposit = async (req, res) => {
  try {
    const affectedRows = await Deposit.delete(req.params.id);
    if (affectedRows === 0) {
      return res.status(404).json({ error: "Deposit not found" });
    }
    res.json({ message: "Deposit deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Admin: unseen count ───────────────────────────────────────────────────────
exports.getUnseenCount = async (req, res) => {
  try {
    res.json({ count: await Deposit.getUnseenCount() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Admin: mark all seen ──────────────────────────────────────────────────────
exports.markAllSeen = async (req, res) => {
  try {
    await Deposit.markAllSeen();
    res.json({ message: "All deposits marked as seen" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
