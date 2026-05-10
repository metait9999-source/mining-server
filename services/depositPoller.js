const db = require("../config/db.config");
const { verifyOnChain } = require("../models/depositRequest.model");
const {
  creditDeposit,
  isAlreadyProcessed,
  markSwept,
} = require("../models/chainDeposit.model");
const { sweepChain } = require("../services/sweep");
const { getReceiverSocketId, io } = require("../socket/socket");
const Deposit = require("../models/deposit.model");

const CHAINS = ["trx", "usdt_trc20", "eth", "usdt_erc20", "btc"];

const CHAIN_COIN_MAP = {
  trx: "TRX",
  usdt_trc20: "USDT-TRC20",
  eth: "ETH",
  usdt_erc20: "USDT-ERC20",
  btc: "BTC",
};

async function pollAllUserAddresses() {
  console.log("[poller] 🔄 Scanning all user addresses...");

  // Get all users who have at least one wallet assigned
  const [users] = await db.query(
    `SELECT id, hd_index, wallet_trx, wallet_eth, wallet_btc
       FROM meta_ct_user
      WHERE wallet_trx IS NOT NULL
         OR wallet_eth IS NOT NULL
         OR wallet_btc IS NOT NULL`,
  );

  console.log(
    `[poller] Checking ${users.length} users across ${CHAINS.length} chains`,
  );

  for (const user of users) {
    for (const chain of CHAINS) {
      // Resolve address for this chain
      const toAddress =
        chain === "trx" || chain === "usdt_trc20"
          ? user.wallet_trx
          : chain === "eth" || chain === "usdt_erc20"
            ? user.wallet_eth
            : chain === "btc"
              ? user.wallet_btc
              : null;

      if (!toAddress) continue;

      try {
        // Check on-chain for any incoming tx
        const verified = await verifyOnChain(chain, toAddress);
        if (!verified) continue;

        // Already processed? Skip
        if (await isAlreadyProcessed(verified.txHash, chain)) continue;

        console.log(
          `[poller] 🆕 New tx found! user=${user.id} chain=${chain}` +
            ` amount=${verified.actualAmount} tx=${verified.txHash}`,
        );

        // Credit USD balance
        const creditResult = await creditDeposit({
          userId: user.id,
          chain,
          txHash: verified.txHash,
          fromAddress: verified.fromAddress,
          toAddress,
          amount: verified.actualAmount,
        });

        if (!creditResult) continue; // race condition — already processed

        // Save readable deposit record
        await Deposit.create({
          userId: user.id,
          coinId: CHAIN_COIN_MAP[chain],
          walletFrom: verified.fromAddress || "",
          walletTo: toAddress,
          txHash: verified.txHash || null,
          usdAmount: creditResult.usdAmount,
          status: "approved",
        });

        // Notify user via socket
        const userSocket = getReceiverSocketId(user.id);
        if (userSocket) {
          io.to(userSocket).emit("depositApproved", {
            coinId: CHAIN_COIN_MAP[chain],
            rawAmount: verified.actualAmount,
            usdAmount: creditResult.usdAmount,
            txHash: verified.txHash,
          });
        }

        // Notify admin via socket
        const adminSocket = getReceiverSocketId(0);
        if (adminSocket) {
          io.to(adminSocket).emit("newDeposit", {
            userId: user.id,
            coinId: CHAIN_COIN_MAP[chain],
            usdAmount: creditResult.usdAmount,
            txHash: verified.txHash,
          });
        }

        // Sweep to master wallet — background, non-blocking
        sweepChain(chain, user.hd_index)
          .then((sweptTx) => {
            if (sweptTx) markSwept(creditResult.depositId, sweptTx);
          })
          .catch((err) => console.error("[poller] Sweep error:", err.message));

        console.log(
          `[poller] ✅ Credited user=${user.id} chain=${chain}` +
            ` raw=${verified.actualAmount} usd=$${creditResult.usdAmount}`,
        );
      } catch (err) {
        // Never let one user/chain error kill the whole poll
        console.error(
          `[poller] Error user=${user.id} chain=${chain}:`,
          err.message,
        );
      }
    }
  }

  console.log("[poller] ✅ Scan complete");
}

function startDepositPoller(intervalMs = 60_000) {
  console.log(`[poller] Starting deposit poller every ${intervalMs / 1000}s`);

  // Run once immediately on start
  pollAllUserAddresses().catch((err) =>
    console.error("[poller] Initial poll error:", err.message),
  );

  // Then repeat on interval
  setInterval(() => {
    pollAllUserAddresses().catch((err) =>
      console.error("[poller] Poll error:", err.message),
    );
  }, intervalMs);
}

module.exports = { startDepositPoller, pollAllUserAddresses };
