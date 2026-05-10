const db = require("../config/db.config");
const axios = require("axios");
const { TronWeb } = require("tronweb");
const {
  creditDeposit,
  markSwept,
  isAlreadyProcessed,
} = require("./chainDeposit.model");
const { sweepChain } = require("../services/sweep");
const Deposit = require("./deposit.model");
const { getReceiverSocketId, io } = require("../socket/socket");

const tronWeb = new TronWeb({
  fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
  headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
});

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ERC20_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SCAN_WINDOW_TRON_SEC = 30 * 60;
const SCAN_WINDOW_ETH_BLOCKS = 150;
const CHECK_DELAY_MS = 5 * 60 * 1000;

const COIN_CHAIN_MAP = {
  TRX: "trx",
  "USDT-TRC20": "usdt_trc20",
  ETH: "eth",
  "USDT-ERC20": "usdt_erc20",
  BTC: "btc",
};

async function verifyTRXDeposit(toAddress) {
  try {
    const res = await axios.get(
      `https://api.trongrid.io/v1/accounts/${toAddress}/transactions`,
      {
        headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
        params: {
          limit: 20,
          only_confirmed: true,
          min_timestamp: Date.now() - SCAN_WINDOW_TRON_SEC * 1000,
        },
      },
    );
    for (const tx of res.data?.data || []) {
      const contract = tx.raw_data?.contract?.[0];
      if (contract?.type !== "TransferContract") continue;
      const value = contract.parameter?.value;
      if (!value) continue;
      const to = tronWeb.address.fromHex(value.to_address);
      if (to.toLowerCase() !== toAddress.toLowerCase()) continue;
      const amount = value.amount / 1_000_000;
      if (amount <= 0) continue;
      return {
        txHash: tx.txID,
        fromAddress: tronWeb.address.fromHex(value.owner_address),
        actualAmount: amount,
      };
    }
    return null;
  } catch (err) {
    console.error("[verifyTRXDeposit]", err.message);
    return null;
  }
}

async function verifyTRC20Deposit(toAddress) {
  try {
    const minTimestamp =
      (Math.floor(Date.now() / 1000) - SCAN_WINDOW_TRON_SEC) * 1000;
    const res = await axios.get(
      `https://api.trongrid.io/v1/accounts/${toAddress}/transactions/trc20`,
      {
        headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
        params: {
          limit: 20,
          contract_address: USDT_TRC20_CONTRACT,
          min_timestamp: minTimestamp,
          only_confirmed: true,
        },
      },
    );
    for (const tx of res.data?.data || []) {
      if (tx.to !== toAddress) continue;
      const amount = Number(tx.value) / 1_000_000;
      if (amount <= 0) continue;
      return {
        txHash: tx.transaction_id,
        fromAddress: tx.from,
        actualAmount: amount,
      };
    }
    return null;
  } catch (err) {
    console.error("[verifyTRC20Deposit]", err.message);
    return null;
  }
}

async function verifyETHDeposit(toAddress) {
  const KEY = process.env.ETHERSCAN_API_KEY;
  const BASE = "https://api.etherscan.io/v2/api";
  const CHAIN_ID = 1;
  try {
    const blockRes = await axios.get(BASE, {
      params: {
        chainid: CHAIN_ID,
        module: "proxy",
        action: "eth_blockNumber",
        apikey: KEY,
      },
    });
    const currentBlock = parseInt(blockRes.data.result, 16);
    const startBlock = isNaN(currentBlock)
      ? 0
      : currentBlock - SCAN_WINDOW_ETH_BLOCKS;

    const res = await axios.get(BASE, {
      params: {
        chainid: CHAIN_ID,
        module: "account",
        action: "txlist",
        address: toAddress,
        startblock: startBlock,
        endblock: 99999999,
        sort: "desc",
        apikey: KEY,
      },
    });
    for (const tx of res.data?.result || []) {
      if (!tx.to || tx.to.toLowerCase() !== toAddress.toLowerCase()) continue;
      if (tx.isError !== "0") continue;
      const amount = Number(BigInt(tx.value)) / 1e18;
      if (amount <= 0) continue;
      return { txHash: tx.hash, fromAddress: tx.from, actualAmount: amount };
    }
    return null;
  } catch (err) {
    console.error("[verifyETHDeposit]", err.message);
    return null;
  }
}

async function verifyERC20Deposit(toAddress) {
  const KEY = process.env.ETHERSCAN_API_KEY;
  const BASE = "https://api.etherscan.io/v2/api";
  const CHAIN_ID = 1;
  try {
    const blockRes = await axios.get(BASE, {
      params: {
        chainid: CHAIN_ID,
        module: "proxy",
        action: "eth_blockNumber",
        apikey: KEY,
      },
    });
    const currentBlock = parseInt(blockRes.data.result, 16);
    const startBlock = isNaN(currentBlock)
      ? 0
      : currentBlock - SCAN_WINDOW_ETH_BLOCKS;

    const res = await axios.get(BASE, {
      params: {
        chainid: CHAIN_ID,
        module: "account",
        action: "tokentx",
        contractaddress: USDT_ERC20_CONTRACT,
        address: toAddress,
        startblock: startBlock,
        endblock: 99999999,
        sort: "desc",
        apikey: KEY,
      },
    });
    for (const tx of res.data?.result || []) {
      if (!tx.to || tx.to.toLowerCase() !== toAddress.toLowerCase()) continue;
      const amount = Number(tx.value) / 1_000_000;
      if (amount <= 0) continue;
      return { txHash: tx.hash, fromAddress: tx.from, actualAmount: amount };
    }
    return null;
  } catch (err) {
    console.error("[verifyERC20Deposit]", err.message);
    return null;
  }
}

async function verifyBTCDeposit(toAddress) {
  try {
    const res = await axios.get(
      `https://blockstream.info/api/address/${toAddress}/txs`,
    );
    const MIN_CONF = process.env.NODE_ENV === "production" ? 1 : 0;
    for (const tx of res.data || []) {
      if (MIN_CONF > 0 && !tx.status?.confirmed) continue;
      const output = tx.vout?.find((v) => v.scriptpubkey_address === toAddress);
      if (!output) continue;
      const amount = output.value / 1e8;
      if (amount <= 0) continue;
      return { txHash: tx.txid, fromAddress: null, actualAmount: amount };
    }
    return null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.error("[verifyBTCDeposit]", err.response?.data || err.message);
    return null;
  }
}

async function verifyOnChain(chain, toAddress) {
  try {
    switch (chain) {
      case "trx":
        return await verifyTRXDeposit(toAddress);
      case "usdt_trc20":
        return await verifyTRC20Deposit(toAddress);
      case "eth":
        return await verifyETHDeposit(toAddress);
      case "usdt_erc20":
        return await verifyERC20Deposit(toAddress);
      case "btc":
        return await verifyBTCDeposit(toAddress);
      default:
        return null;
    }
  } catch (err) {
    console.error(`[verifyOnChain:${chain}]`, err.message);
    return null;
  }
}

async function _checkInBackground({ userId, coinId, chain, toAddress, user }) {
  try {
    console.log(
      `[checkDeposit] ⏳ Waiting 5 min before checking...` +
        ` user=${userId} chain=${chain}`,
    );
    await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
    console.log(
      `[checkDeposit] 🔍 Checking on-chain now...` +
        ` user=${userId} chain=${chain}`,
    );

    const verified = await verifyOnChain(chain, toAddress);

    if (!verified) {
      console.log(
        `[checkDeposit] ❌ Not found after 5 min wait. user=${userId} chain=${chain}`,
      );
      const userSocket = getReceiverSocketId(userId);
      if (userSocket) {
        io.to(userSocket).emit("depositNotFound", {
          coinId,
          message:
            "No deposit detected on-chain. Please try again after sending.",
        });
      }
      return;
    }

    if (await isAlreadyProcessed(verified.txHash, chain)) {
      console.log(
        `[checkDeposit] Already processed.` +
          ` user=${userId} tx=${verified.txHash}`,
      );
      return;
    }

    const creditResult = await creditDeposit({
      userId,
      chain,
      txHash: verified.txHash,
      fromAddress: verified.fromAddress,
      toAddress,
      amount: verified.actualAmount,
    });

    if (!creditResult) return;

    await Deposit.create({
      userId,
      coinId,
      walletFrom: verified.fromAddress || "",
      walletTo: toAddress,
      txHash: verified.txHash || null,
      usdAmount: creditResult.usdAmount,
      status: "approved",
    });

    console.log(
      `[checkDeposit] ✅ Credited user=${userId} chain=${chain}` +
        ` raw=${verified.actualAmount} usd=$${creditResult.usdAmount}`,
    );

    const userSocket = getReceiverSocketId(userId);
    if (userSocket) {
      io.to(userSocket).emit("depositApproved", {
        coinId,
        rawAmount: verified.actualAmount,
        usdAmount: creditResult.usdAmount,
        txHash: verified.txHash,
      });
    }

    const adminSocket = getReceiverSocketId(0);
    if (adminSocket) {
      io.to(adminSocket).emit("newDeposit", {
        userId,
        coinId,
        usdAmount: creditResult.usdAmount,
        txHash: verified.txHash,
      });
    }

    sweepChain(chain, user.hd_index)
      .then((sweptTx) => {
        if (sweptTx) markSwept(creditResult.depositId, sweptTx);
      })
      .catch((err) =>
        console.error("[checkDeposit] Sweep error:", err.message),
      );
  } catch (err) {
    console.error(
      `[checkDeposit] Background error user=${userId}:`,
      err.message,
    );
  }
}

async function checkAndCreditDeposit({ userId, coinId }) {
  const [[user]] = await db.query(
    `SELECT id, hd_index, wallet_trx, wallet_eth, wallet_btc
       FROM meta_ct_user WHERE id = ?`,
    [userId],
  );
  if (!user) throw new Error("User not found");

  const chain = COIN_CHAIN_MAP[coinId];
  if (!chain) throw new Error(`Unsupported coin: ${coinId}`);

  const toAddress =
    chain === "trx" || chain === "usdt_trc20"
      ? user.wallet_trx
      : chain === "eth" || chain === "usdt_erc20"
        ? user.wallet_eth
        : chain === "btc"
          ? user.wallet_btc
          : null;

  if (!toAddress) throw new Error("Wallet not assigned to this user yet");

  setImmediate(() =>
    _checkInBackground({ userId, coinId, chain, toAddress, user }),
  );

  return {
    status: "processing",
    message:
      "We are checking your deposit. You will be notified automatically within 5 minutes once it is detected.",
  };
}

module.exports = { checkAndCreditDeposit, verifyOnChain };
