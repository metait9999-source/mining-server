require("dotenv").config();
const { TronWeb } = require("tronweb");
const { ethers } = require("ethers");
const axios = require("axios");
const bitcoin = require("bitcoinjs-lib");
const ECPair = require("ecpair").ECPairFactory(require("tiny-secp256k1"));

const { deriveAllWallets } = require("./walletDerivation");
const { getMasterWallets } = require("./masterWallet");

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ERC20_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDT_ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const TRX_GAS_RESERVE = 15;
const ETH_GAS_RESERVE = "0.005";
const TRX_ACTIVATION_FEE = 1; // 1 TRX minimum to activate

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Tron helpers
// ─────────────────────────────────────────────────────────────────────────────

async function isTronAccountActivated(address) {
  try {
    const res = await axios.get(
      `https://api.trongrid.io/v1/accounts/${address}`,
      { headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY } },
    );
    return Array.isArray(res.data?.data) && res.data.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Send activation tx — no sleep inside, caller handles polling.
 */
async function activateTronAccount(address, masterTron) {
  console.log(`[sweep:TRX] 🔑 Sending activation tx to ${address}...`);

  const fundTx = await masterTron.trx.sendTransaction(
    address,
    TRX_ACTIVATION_FEE * 1_000_000,
  );

  console.log(`[sweep:TRX] Activation tx sent: ${fundTx.txid}`);
  console.log(
    `[sweep:TRX] Check on Tronscan: https://tronscan.org/#/transaction/${fundTx.txid}`,
  );

  // ── Verify the tx result — Tron returns result in the response ──
  if (fundTx.result === false || fundTx.Error) {
    throw new Error(
      `[sweep:TRX] Activation tx failed on-chain: ${fundTx.Error || JSON.stringify(fundTx)}`,
    );
  }

  // ── Wait 6s then confirm it landed on-chain ──
  await sleep(6_000);
  try {
    const txInfo = await masterTron.trx.getTransaction(fundTx.txid);
    console.log(
      `[sweep:TRX] Tx status: ${JSON.stringify(txInfo?.ret || txInfo?.result || "unknown")}`,
    );
  } catch (err) {
    console.log(`[sweep:TRX] Could not fetch tx info: ${err.message}`);
  }

  return fundTx.txid;
}

/**
 * Activate and WAIT until the API confirms the account exists.
 * Polls every 10s, up to 15 attempts (150s max).
 */
async function activateAndWait(address, masterTron) {
  // Check if already active before sending anything
  const alreadyActive = await isTronAccountActivated(address);
  if (alreadyActive) {
    console.log(`[sweep:TRX] ✅ Account already activated: ${address}`);
    return;
  }

  await activateTronAccount(address, masterTron);

  const MAX_ATTEMPTS = 15;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    console.log(
      `[sweep:TRX] ⏳ Waiting 10s... activation check ${i}/${MAX_ATTEMPTS}`,
    );
    await sleep(10_000);

    const active = await isTronAccountActivated(address);
    if (active) {
      console.log(`[sweep:TRX] ✅ Account confirmed active after ${i * 10}s`);
      return;
    }
  }

  throw new Error(
    `[sweep:TRX] ❌ Account ${address} not activated after ${MAX_ATTEMPTS * 10}s. ` +
      `Check the activation tx on Tronscan.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BTC helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getFeeRate() {
  try {
    const res = await axios.get(
      "https://mempool.space/api/v1/fees/recommended",
    );
    console.log(
      `[sweep:BTC] fee rate from mempool.space: ${res.data.halfHourFee} sat/vbyte`,
    );
    return res.data.fastestFee;
  } catch {
    try {
      const res = await axios.get("https://blockstream.info/api/fee-estimates");
      const rate = Math.ceil(res.data["3"]);
      console.log(
        `[sweep:BTC] fee rate from blockstream fallback: ${rate} sat/vbyte`,
      );
      return rate;
    } catch {
      console.log("[sweep:BTC] fee rate fallback to hardcoded 20 sat/vbyte");
      return 20;
    }
  }
}

async function broadcastTx(rawTx) {
  try {
    const res = await axios.post("https://mempool.space/api/tx", rawTx, {
      headers: { "Content-Type": "text/plain" },
    });
    console.log("[sweep:BTC] broadcast success via mempool.space");
    return res.data;
  } catch (err) {
    console.error(
      "[sweep:BTC] mempool.space failed:",
      err.response?.data || err.message,
    );
    try {
      const res = await axios.post("https://blockstream.info/api/tx", rawTx, {
        headers: { "Content-Type": "text/plain" },
      });
      console.log("[sweep:BTC] broadcast success via blockstream");
      return res.data;
    } catch (err2) {
      console.error(
        "[sweep:BTC] blockstream failed:",
        err2.response?.data || err2.message,
      );
      throw new Error(`Broadcast failed on all providers: ${err2.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRX sweep
// ─────────────────────────────────────────────────────────────────────────────

async function sweepTRX(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);

  const depositTron = new TronWeb({
    fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
    privateKey: wallets.privateKeys.trx,
  });

  const masterTron = new TronWeb({
    fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
    privateKey: process.env.SWEEP_PRIVATE_KEY_TRX,
  });

  // Activate and verify before doing anything else
  await activateAndWait(wallets.trx, masterTron);

  const balanceSun = await depositTron.trx.getBalance(wallets.trx);
  const balance = balanceSun / 1_000_000;
  const sweepable = balance - 1; // keep 1 TRX for future fees

  if (sweepable <= 0) {
    console.log(
      `[sweep:TRX] Nothing to sweep from ${wallets.trx} (balance=${balance} TRX)`,
    );
    return null;
  }

  const tx = await depositTron.trx.sendTransaction(
    master.trx,
    Math.floor(sweepable * 1_000_000),
  );
  console.log(
    `[sweep:TRX] ✅ ${sweepable} TRX → ${master.trx} | tx: ${tx.txid}`,
  );
  return tx.txid;
}

// ─────────────────────────────────────────────────────────────────────────────
// USDT-TRC20 sweep
// ─────────────────────────────────────────────────────────────────────────────

async function sweepUSDT_TRC20(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);

  const depositTron = new TronWeb({
    fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
    privateKey: wallets.privateKeys.trx,
  });

  const masterTron = new TronWeb({
    fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
    privateKey: process.env.SWEEP_PRIVATE_KEY_TRX,
  });

  const signerAddress = masterTron.address.fromPrivateKey(
    process.env.SWEEP_PRIVATE_KEY_TRX,
  );
  const signerBalSun = await masterTron.trx.getBalance(signerAddress);
  console.log(`[sweep:USDT-TRC20] Signer address: ${signerAddress}`);
  console.log(
    `[sweep:USDT-TRC20] Signer TRX balance: ${signerBalSun / 1_000_000} TRX`,
  );
  console.log(`[sweep:USDT-TRC20] Master TRX address: ${master.trx}`);
  console.log(`[sweep:USDT-TRC20] Target deposit address: ${wallets.trx}`);
  // 1. Check USDT balance first — no point activating if nothing to sweep
  const contract = await depositTron.contract().at(USDT_TRC20_CONTRACT);
  const rawBalance = await contract.balanceOf(wallets.trx).call();
  const usdtBalance = Number(rawBalance) / 1_000_000;

  if (usdtBalance <= 0) {
    console.log(`[sweep:USDT-TRC20] Nothing to sweep from ${wallets.trx}`);
    return null;
  }

  console.log(`[sweep:USDT-TRC20] Found ${usdtBalance} USDT at ${wallets.trx}`);

  // 2. Activate account and WAIT until confirmed — must be done before any tx
  await activateAndWait(wallets.trx, masterTron);

  // 3. Top up TRX for gas — account is now confirmed active
  const trxSun = await masterTron.trx.getBalance(wallets.trx);
  const trxBal = trxSun / 1_000_000;
  console.log(`[sweep:USDT-TRC20] Current TRX balance: ${trxBal} TRX`);

  if (trxBal < TRX_GAS_RESERVE) {
    const needed = TRX_GAS_RESERVE - trxBal;
    const fundTx = await masterTron.trx.sendTransaction(
      wallets.trx,
      Math.ceil(needed * 1_000_000),
    );
    console.log(
      `[sweep:USDT-TRC20] ⛽ Funded ${needed.toFixed(2)} TRX for gas | tx: ${fundTx.txid}`,
    );

    // Wait for gas funding to be confirmed on-chain
    console.log(
      `[sweep:USDT-TRC20] ⏳ Waiting 15s for gas funding confirmation...`,
    );
    await sleep(15_000);
  }

  // 4. Transfer USDT to master
  const amountSun = BigInt(Math.floor(usdtBalance * 1_000_000));
  const tx = await contract
    .transfer(master.usdt_trc20, amountSun)
    .send({ feeLimit: 40_000_000 });

  console.log(
    `[sweep:USDT-TRC20] ✅ ${usdtBalance} USDT → ${master.usdt_trc20} | tx: ${tx}`,
  );
  return tx;
}

// ─────────────────────────────────────────────────────────────────────────────
// ETH sweep
// ─────────────────────────────────────────────────────────────────────────────

async function sweepETH(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  const signer = new ethers.Wallet("0x" + wallets.privateKeys.eth, provider);

  const feeData = await provider.getFeeData();
  const gasLimit = 21000n;
  const gasCost = feeData.gasPrice * gasLimit;
  const balance = await provider.getBalance(signer.address);
  const sweepable = balance - gasCost;

  if (sweepable <= 0n) {
    console.log(`[sweep:ETH] Nothing to sweep from ${signer.address}`);
    return null;
  }

  const tx = await signer.sendTransaction({
    to: master.eth,
    value: sweepable,
    gasLimit,
    gasPrice: feeData.gasPrice,
  });
  await tx.wait();
  console.log(
    `[sweep:ETH] ✅ ${ethers.formatEther(sweepable)} ETH → ${master.eth} | tx: ${tx.hash}`,
  );
  return tx.hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// USDT-ERC20 sweep
// ─────────────────────────────────────────────────────────────────────────────

async function sweepUSDT_ERC20(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  const signer = new ethers.Wallet("0x" + wallets.privateKeys.eth, provider);
  const masterW = new ethers.Wallet(
    "0x" + process.env.SWEEP_PRIVATE_KEY_ETH,
    provider,
  );
  const contract = new ethers.Contract(
    USDT_ERC20_CONTRACT,
    USDT_ERC20_ABI,
    signer,
  );

  const rawBalance = await contract.balanceOf(signer.address);
  const usdtBalance = Number(rawBalance) / 1_000_000;

  if (usdtBalance <= 0) {
    console.log(`[sweep:USDT-ERC20] Nothing to sweep from ${signer.address}`);
    return null;
  }

  // ETH accounts don't need activation — just ensure gas
  const ethBalance = await provider.getBalance(signer.address);
  const gasReserve = ethers.parseEther(ETH_GAS_RESERVE);
  if (ethBalance < gasReserve) {
    const fundTx = await masterW.sendTransaction({
      to: signer.address,
      value: gasReserve - ethBalance,
    });
    await fundTx.wait();
    console.log(`[sweep:USDT-ERC20] ⛽ Gas funded`);
  }

  const tx = await contract.transfer(master.usdt_erc20, rawBalance);
  await tx.wait();
  console.log(
    `[sweep:USDT-ERC20] ✅ ${usdtBalance} USDT → ${master.usdt_erc20} | tx: ${tx.hash}`,
  );
  return tx.hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// BTC sweep
// ─────────────────────────────────────────────────────────────────────────────

async function sweepBTC(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);
  const address = wallets.btc;

  console.log(
    `[sweep:BTC] starting for address=${address} master=${master.btc}`,
  );

  const utxoRes = await axios.get(
    `https://blockstream.info/api/address/${address}/utxo`,
  );
  const utxos = utxoRes.data || [];
  console.log(`[sweep:BTC] UTXOs found: ${utxos.length}`);

  if (!utxos.length) {
    console.log(`[sweep:BTC] No UTXOs at ${address}`);
    return null;
  }

  const feeRate = await getFeeRate();

  const keyPair = ECPair.fromPrivateKey(
    Buffer.from(wallets.privateKeys.btc, "hex"),
    { network: bitcoin.networks.bitcoin },
  );

  const isLegacy = address.startsWith("1");
  const isP2SH = address.startsWith("3");
  console.log(
    `[sweep:BTC] address type: ${isLegacy ? "legacy P2PKH" : isP2SH ? "P2SH" : "native SegWit"}`,
  );

  let payment;
  let bytesPerInput;

  if (isLegacy) {
    payment = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: bitcoin.networks.bitcoin,
    });
    bytesPerInput = 148;
  } else if (isP2SH) {
    payment = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: bitcoin.networks.bitcoin,
      }),
      network: bitcoin.networks.bitcoin,
    });
    bytesPerInput = 91;
  } else {
    payment = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: bitcoin.networks.bitcoin,
    });
    bytesPerInput = 68;
  }

  const estSize = utxos.length * bytesPerInput + 34 + 10;
  const feeSat = Math.ceil(feeRate * estSize);
  const totalSat = utxos.reduce((s, u) => s + u.value, 0);
  const sweepSat = totalSat - feeSat;
  console.log(
    `[sweep:BTC] totalSat=${totalSat} feeSat=${feeSat} sweepSat=${sweepSat}`,
  );

  if (sweepSat <= 0) {
    console.log(`[sweep:BTC] Balance too low to cover fees at ${address}`);
    return null;
  }

  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

  for (const utxo of utxos) {
    if (isLegacy) {
      const txHexRes = await axios.get(
        `https://blockstream.info/api/tx/${utxo.txid}/hex`,
      );
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(txHexRes.data, "hex"),
      });
    } else if (isP2SH) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(payment.output),
          value: BigInt(utxo.value),
        },
        redeemScript: Buffer.from(payment.redeem.output),
      });
    } else {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(payment.output),
          value: BigInt(utxo.value),
        },
      });
    }
    console.log(
      `[sweep:BTC] added input: ${utxo.txid}:${utxo.vout} value=${utxo.value}`,
    );
  }

  const outputScript = bitcoin.address.toOutputScript(
    master.btc,
    bitcoin.networks.bitcoin,
  );
  psbt.addOutput({ script: outputScript, value: BigInt(sweepSat) });

  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();
  console.log(`[sweep:BTC] raw tx built, broadcasting...`);

  const txHash = await broadcastTx(rawTx);
  console.log(
    `[sweep:BTC] ✅ ${sweepSat / 1e8} BTC → ${master.btc} | tx: ${txHash}`,
  );
  return txHash;
}

// ─────────────────────────────────────────────────────────────────────────────
async function sweepChain(chain, hdIndex) {
  switch (chain) {
    case "trx":
      return sweepTRX(hdIndex);
    case "usdt_trc20":
      return sweepUSDT_TRC20(hdIndex);
    case "eth":
      return sweepETH(hdIndex);
    case "usdt_erc20":
      return sweepUSDT_ERC20(hdIndex);
    case "btc":
      return sweepBTC(hdIndex);
    default:
      throw new Error(`Unknown chain: ${chain}`);
  }
}

module.exports = { sweepChain };
