const db = require("../config/db.config");
const axios = require("axios");
const { TronWeb } = require("tronweb");
const { creditDeposit, markSwept } = require("./chainDeposit.model");
const { sweepChain } = require("../services/sweep");

const tronWeb = new TronWeb({
  fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
  headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
});

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ERC20_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const SCAN_WINDOW_TRON_SEC = 30 * 60;
const SCAN_WINDOW_ETH_BLOCKS = 150;
const SCAN_WINDOW_BTC_CONFIRMATIONS = 3;

/**
 * coin_id → chain identifier used internally
 */
const COIN_CHAIN_MAP = {
  TRX: "trx",
  "USDT-TRC20": "usdt_trc20",
  ETH: "eth",
  "USDT-ERC20": "usdt_erc20",
  BTC: "btc",
};

async function verifyTRC20Deposit(toAddress, expectedAmount) {
  try {
    const minTimestamp =
      (Math.floor(Date.now() / 1000) - SCAN_WINDOW_TRON_SEC) * 1000;

    // ← User এর specific address এর TRC20 transactions check করো
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

    const txList = res.data?.data || [];

    for (const tx of txList) {
      // Only incoming transfers
      if (tx.to !== toAddress) continue;

      const amount = Number(tx.value) / 1_000_000;

      if (amount >= expectedAmount * 0.99) {
        return {
          txHash: tx.transaction_id,
          fromAddress: tx.from,
          actualAmount: amount,
        };
      }
    }
    return null;
  } catch (err) {
    console.error("[verifyTRC20Deposit] Error:", err.message);
    return null;
  }
}

async function verifyTRXDeposit(toAddress, expectedAmount) {
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

    const txList = res.data?.data || [];

    for (const tx of txList) {
      const contract = tx.raw_data?.contract?.[0];
      if (contract?.type !== "TransferContract") continue;

      const value = contract.parameter?.value;
      if (!value) continue;

      const to = tronWeb.address.fromHex(value.to_address);
      const amount = value.amount / 1_000_000;

      if (
        to.toLowerCase() === toAddress.toLowerCase() &&
        amount >= expectedAmount * 0.99
      ) {
        return {
          txHash: tx.txID,
          fromAddress: tronWeb.address.fromHex(value.owner_address),
          actualAmount: amount,
        };
      }
    }
    return null;
  } catch (err) {
    console.error("[verifyTRXDeposit] Error:", err.message);
    return null;
  }
}

async function verifyERC20Deposit(toAddress, expectedAmount) {
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
      if (!tx.to) continue;
      if (tx.to.toLowerCase() !== toAddress.toLowerCase()) continue;
      const amount = Number(tx.value) / 1_000_000;
      if (amount >= expectedAmount * 0.99) {
        return { txHash: tx.hash, fromAddress: tx.from, actualAmount: amount };
      }
    }
    return null;
  } catch (err) {
    console.error("[verifyERC20Deposit] Error:", err.message);
    return null;
  }
}

async function verifyETHDeposit(toAddress, expectedAmount) {
  const KEY = process.env.ETHERSCAN_API_KEY;

  try {
    // ← V2 URL use করো
    const BASE = "https://api.etherscan.io/v2/api";
    const CHAIN_ID = 1; // Ethereum mainnet

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
      if (!tx.to) continue;
      if (tx.to.toLowerCase() !== toAddress.toLowerCase()) continue;
      if (tx.isError !== "0") continue;
      const amount = Number(BigInt(tx.value)) / 1e18;
      if (amount >= expectedAmount * 0.99) {
        return { txHash: tx.hash, fromAddress: tx.from, actualAmount: amount };
      }
    }
    return null;
  } catch (err) {
    console.error("[verifyETHDeposit] Error:", err.message);
    return null;
  }
}

async function verifyBTCDeposit(toAddress, expectedAmount) {
  try {
    const res = await axios.get(
      `https://blockstream.info/api/address/${toAddress}/txs`,
    );

    console.log(
      `[verifyBTCDeposit] address=${toAddress} tx count=${res.data?.length}`,
    );

    for (const tx of res.data || []) {
      const confirmed = tx.status?.confirmed;
      const MIN_CONFIRMATIONS = process.env.NODE_ENV === "production" ? 1 : 0;

      if (MIN_CONFIRMATIONS > 0 && !confirmed) continue;

      // Find the output that pays toAddress
      const output = tx.vout?.find((v) => v.scriptpubkey_address === toAddress);
      if (!output) continue;

      const amount = output.value / 1e8;
      console.log(
        `[verifyBTCDeposit] tx=${tx.txid} confirmed=${confirmed} amount=${amount} BTC`,
      );

      if (amount >= expectedAmount * 0.99) {
        return {
          txHash: tx.txid,
          fromAddress: null,
          actualAmount: amount,
        };
      }
    }
    return null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.error(
      "[verifyBTCDeposit] Error:",
      err.response?.data || err.message,
    );
    return null;
  }
}

async function createDepositRequest({ userId, coinId, amount }) {
  const [[user]] = await db.query(
    "SELECT id, hd_index, wallet_trx, wallet_eth, wallet_btc FROM meta_ct_user WHERE id = ?",
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

  if (!toAddress) throw new Error("User deposit address not generated yet");

  // 2. Insert a pending deposit record in your existing table
  const [insertResult] = await db.query(
    `INSERT INTO meta_ct_deposits
       (user_id, wallet_from, wallet_to, trans_hash, coin_id, amount, status)
     VALUES (?, '', ?, '', ?, ?, 'pending_verification')`,
    [userId, toAddress, coinId, amount],
  );
  const depositRecordId = insertResult.insertId;

  // 3. Immediately try to verify on-chain
  const verified = await verifyOnChain(chain, toAddress, amount);

  if (verified) {
    // 4a. Found matching tx → auto-approve
    await db.query(
      "UPDATE meta_ct_deposits SET status = 'approved', wallet_from = ?, trans_hash = ? WHERE id = ?",
      [verified.fromAddress || "", verified.txHash, depositRecordId],
    );

    // 5. Credit balance (idempotent — uses tx_hash unique key)
    const creditResult = await creditDeposit({
      userId,
      chain,
      txHash: verified.txHash,
      fromAddress: verified.fromAddress,
      toAddress,
      amount: verified.actualAmount,
    });

    // 6. Sweep to master (background)
    if (creditResult) {
      sweepChain(chain, user.hd_index)
        .then((sweptTx) => {
          if (sweptTx) markSwept(creditResult.depositId, sweptTx);
        })
        .catch((err) =>
          console.error("[depositRequest] Sweep error:", err.message),
        );
    }

    return {
      depositRecordId,
      status: "approved",
      txHash: verified.txHash,
      actualAmount: verified.actualAmount,
      message: "Deposit verified and credited automatically",
    };
  } else {
    // 4b. Not found yet — mark pending, background poller will retry
    return {
      depositRecordId,
      status: "pending_verification",
      toAddress,
      message:
        "Deposit not yet detected on-chain. It will be credited automatically once confirmed.",
    };
  }
}

/**
 * Route the verification call to the right chain.
 */
async function verifyOnChain(chain, toAddress, amount) {
  try {
    switch (chain) {
      case "usdt_trc20":
        return await verifyTRC20Deposit(toAddress, amount);
      case "trx":
        return await verifyTRXDeposit(toAddress, amount);
      case "usdt_erc20":
        return await verifyERC20Deposit(toAddress, amount);
      case "eth":
        return await verifyETHDeposit(toAddress, amount);
      case "btc":
        return await verifyBTCDeposit(toAddress, amount);
      default:
        return null;
    }
  } catch (err) {
    console.error(`[verifyOnChain:${chain}] Error:`, err.message);
    return null;
  }
}

/**
 * Retry verification for all pending_verification deposits.
 * Called by the background poller every 30s.
 */
async function retryPendingDeposits() {
  const [pending] = await db.query(
    `SELECT d.*, u.hd_index, u.wallet_trx, u.wallet_eth, u.wallet_btc
       FROM meta_ct_deposits d
       JOIN meta_ct_user u ON d.user_id = u.id
      WHERE d.status = 'pending_verification'
        AND d.created_at > NOW() - INTERVAL 24 HOUR`,
  );

  for (const dep of pending) {
    const chain = COIN_CHAIN_MAP[dep.coin_id];
    if (!chain) continue;

    const toAddress =
      chain === "trx" || chain === "usdt_trc20"
        ? dep.wallet_trx
        : chain === "eth" || chain === "usdt_erc20"
          ? dep.wallet_eth
          : chain === "btc"
            ? dep.wallet_btc
            : null;

    if (!toAddress) continue;

    const verified = await verifyOnChain(chain, toAddress, dep.amount);
    if (!verified) continue;

    // Found — approve and credit
    await db.query(
      "UPDATE meta_ct_deposits SET status = 'approved', wallet_from = ?, trans_hash = ? WHERE id = ?",
      [verified.fromAddress || "", verified.txHash, dep.id],
    );

    const creditResult = await creditDeposit({
      userId: dep.user_id,
      chain,
      txHash: verified.txHash,
      fromAddress: verified.fromAddress,
      toAddress,
      amount: verified.actualAmount,
    });

    if (creditResult) {
      sweepChain(chain, dep.hd_index)
        .then((sweptTx) => {
          if (sweptTx) markSwept(creditResult.depositId, sweptTx);
        })
        .catch((err) =>
          console.error("[retryPending] Sweep error:", err.message),
        );
    }

    console.log(
      `[retryPending] ✅ Approved deposit #${dep.id} for user ${dep.user_id}`,
    );
  }
}

module.exports = { createDepositRequest, retryPendingDeposits, verifyOnChain };
