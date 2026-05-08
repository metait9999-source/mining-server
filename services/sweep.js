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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
async function getFeeRate() {
  try {
    const res = await axios.get(
      "https://mempool.space/api/v1/fees/recommended",
    );
    console.log(
      `[sweep:BTC] fee rate from mempool.space: ${res.data.halfHourFee} sat/vbyte`,
    );
    return res.data.halfHourFee;
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
async function sweepTRX(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);

  const depositTron = new TronWeb({
    fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
    privateKey: wallets.privateKeys.trx,
  });

  const balanceSun = await depositTron.trx.getBalance(wallets.trx);
  const balance = balanceSun / 1_000_000;
  const sweepable = balance - 1;

  if (sweepable <= 0) {
    console.log(`[sweep:TRX] Nothing to sweep from ${wallets.trx}`);
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

  const contract = await depositTron.contract().at(USDT_TRC20_CONTRACT);
  const rawBalance = await contract.balanceOf(wallets.trx).call();
  const usdtBalance = Number(rawBalance) / 1_000_000;

  if (usdtBalance <= 0) {
    console.log(`[sweep:USDT-TRC20] Nothing to sweep from ${wallets.trx}`);
    return null;
  }

  const trxSun = await masterTron.trx.getBalance(wallets.trx);
  if (trxSun / 1_000_000 < TRX_GAS_RESERVE) {
    const needed = TRX_GAS_RESERVE - trxSun / 1_000_000;
    const fundTx = await masterTron.trx.sendTransaction(
      wallets.trx,
      Math.ceil(needed * 1_000_000),
    );
    console.log(
      `[sweep:USDT-TRC20] ⛽ Funded ${needed} TRX | tx: ${fundTx.txid}`,
    );
    await sleep(8000);
  }

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

async function sweepBTC(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);
  const address = wallets.btc;

  console.log(
    `[sweep:BTC] starting for address=${address} master=${master.btc}`,
  );

  // 1. Fetch UTXOs from Blockstream
  const utxoRes = await axios.get(
    `https://blockstream.info/api/address/${address}/utxo`,
  );
  const utxos = utxoRes.data || [];
  console.log(`[sweep:BTC] UTXOs found: ${utxos.length}`);

  if (!utxos.length) {
    console.log(`[sweep:BTC] No UTXOs at ${address}`);
    return null;
  }

  // 2. Get fee rate with fallback
  const feeRate = await getFeeRate();

  // 3. Derive key pair
  const keyPair = ECPair.fromPrivateKey(
    Buffer.from(wallets.privateKeys.btc, "hex"),
    { network: bitcoin.networks.bitcoin },
  );

  // 4. Detect address type and build payment accordingly
  const isLegacy = address.startsWith("1");
  const isP2SH = address.startsWith("3");
  const isSegWit = address.startsWith("bc1");

  console.log(
    `[sweep:BTC] address type: ${isLegacy ? "legacy P2PKH" : isP2SH ? "P2SH" : "native SegWit"}`,
  );

  let payment;
  let inputTemplate;
  let bytesPerInput;

  if (isLegacy) {
    // P2PKH legacy
    payment = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: bitcoin.networks.bitcoin,
    });
    bytesPerInput = 148;
    // For legacy we need full raw tx hex
  } else if (isP2SH) {
    // P2SH-P2WPKH wrapped SegWit
    payment = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: bitcoin.networks.bitcoin,
      }),
      network: bitcoin.networks.bitcoin,
    });
    bytesPerInput = 91;
  } else {
    // Native SegWit P2WPKH
    payment = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: bitcoin.networks.bitcoin,
    });
    bytesPerInput = 68;
  }

  // 5. Estimate fee
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

  // 6. Build PSBT
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

  for (const utxo of utxos) {
    if (isLegacy) {
      // Legacy requires full raw tx hex
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

  // 7. Add output
  const outputScript = bitcoin.address.toOutputScript(
    master.btc,
    bitcoin.networks.bitcoin,
  );
  psbt.addOutput({
    script: outputScript,
    value: BigInt(sweepSat),
  });

  // 8. Sign and finalize
  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();
  console.log(`[sweep:BTC] raw tx built, broadcasting...`);

  // 9. Broadcast with fallback
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
