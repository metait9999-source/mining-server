const { markSwept, creditDeposit } = require("../models/chainDeposit.model");
const Deposit = require("../models/deposit.model");
const { verifyOnChain } = require("../models/depositRequest.model");
const { sweepChain } = require("../services/sweep");
const { getReceiverSocketId, io } = require("../socket/socket");
const db = require("../config/db.config");

const COIN_CHAIN_MAP = {
  TRX: "trx",
  "USDT-TRC20": "usdt_trc20",
  ETH: "eth",
  BTC: "btc",
};

exports.getAllDeposits = async (req, res) => {
  try {
    res.json(await Deposit.getAll());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getDepositById = async (req, res) => {
  try {
    const deposit = await Deposit.getById(req.params.id);
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });
    res.json(deposit);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createDeposit = async (req, res) => {
  const depositData = {
    user_id: req.body.user_id,
    wallet_to: req.body.wallet_to,
    wallet_from: req.body.wallet_from,
    coin_id: req.body.coin_id,
    trans_hash: req.body.trans_hash,
    amount: req.body.amount,
    documents: req.file ? req.file.path : null,
    status: "pending",
  };

  try {
    const newDepositId = await Deposit.create(depositData);

    // Notify admin
    if (newDepositId) {
      const unseenCount = await Deposit.getUnseenCount();
      const receiverSocketId = getReceiverSocketId(0);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("newDeposit", {
          id: newDepositId,
          ...depositData,
          unseenCount,
        });
      }
    }

    // Return immediately to user — don't wait for on-chain check
    res.status(201).json({ id: newDepositId, ...depositData });

    // ── Background on-chain verification ─────────────────────────────────
    const chain = COIN_CHAIN_MAP[depositData.coin_id];
    if (!chain) return;

    setImmediate(async () => {
      try {
        const [[user]] = await db.query(
          "SELECT hd_index, wallet_trx, wallet_eth, wallet_btc FROM meta_ct_user WHERE id = ?",
          [depositData.user_id],
        );

        const toAddress =
          chain === "trx" || chain === "usdt_trc20"
            ? user?.wallet_trx
            : chain === "eth"
              ? user?.wallet_eth
              : chain === "btc"
                ? user?.wallet_btc
                : null;

        if (!toAddress) return;

        const verified = await verifyOnChain(
          chain,
          toAddress,
          Number(depositData.amount),
        );
        if (!verified) return; // leave as pending, admin handles it

        // Found — approve and credit
        await Deposit.update(newDepositId, {
          status: "approved",
          wallet_from: verified.fromAddress || depositData.wallet_from,
          trans_hash: verified.txHash,
        });

        const creditResult = await creditDeposit({
          userId: depositData.user_id,
          chain,
          txHash: verified.txHash,
          fromAddress: verified.fromAddress,
          toAddress,
          amount: verified.actualAmount,
        });

        if (creditResult) {
          sweepChain(chain, user.hd_index)
            .then((sweptTx) => {
              if (sweptTx) markSwept(creditResult.depositId, sweptTx);
            })
            .catch((err) =>
              console.error("[createDeposit] Sweep error:", err.message),
            );
        }

        // Notify user
        const userSocket = getReceiverSocketId(depositData.user_id);
        if (userSocket) {
          io.to(userSocket).emit("depositApproved", {
            depositId: newDepositId,
            coin_id: depositData.coin_id,
            amount: verified.actualAmount,
            txHash: verified.txHash,
          });
        }
      } catch (err) {
        console.error("[createDeposit] Background verify error:", err.message);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateDeposit = async (req, res) => {
  try {
    const affectedRows = await Deposit.update(req.params.id, req.body);
    if (affectedRows === 0)
      return res.status(404).json({ error: "Deposit not found" });

    const deposit = await Deposit.getById(req.params.id);

    const depositorSocket = getReceiverSocketId(deposit.user_id);
    if (depositorSocket) {
      io.to(depositorSocket).emit("updateDeposit", { deposit });
    }

    res.json({ message: "Deposit updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteDeposit = async (req, res) => {
  try {
    const affectedRows = await Deposit.delete(req.params.id);
    if (affectedRows === 0)
      return res.status(404).json({ error: "Deposit not found" });
    res.json({ message: "Deposit deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getLatestDepositByUserIdAndCoinId = async (req, res) => {
  const { userId, coinId } = req.params;
  try {
    const deposit = await Deposit.getLatestDepositByUserIdAndCoinId(
      userId,
      coinId,
    );
    if (!deposit)
      return res.status(404).json({
        message: "No deposit found for the given User ID and Coin ID",
      });
    res.status(200).json(deposit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getLatestDepositByUserId = async (req, res) => {
  const { userId } = req.params;
  try {
    const deposits = await Deposit.getLatestDepositByUserId(userId);
    if (!deposits?.length)
      return res
        .status(404)
        .json({ message: "No deposit found for the given User ID" });
    res.status(200).json(deposits);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getUnseenCount = async (req, res) => {
  try {
    res.json({ count: await Deposit.getUnseenCount() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.markAllSeen = async (req, res) => {
  try {
    await Deposit.markAllSeen();
    res.json({ message: "All deposits marked as seen" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
