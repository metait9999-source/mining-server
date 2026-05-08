/**
 * sweep.js  (updated — master addresses from DB, not env)
 *
 * Reads master wallet addresses from meta_ct_wallets via getMasterWallets().
 * Everything else is the same sweep logic as before.
 */

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
  const sweepable = balance - 1; // keep 1 TRX for fees

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

  // Fund TRX for gas if needed
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

  // Fund ETH for gas if needed
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
async function sweepBTC(hdIndex) {
  const master = await getMasterWallets();
  const wallets = deriveAllWallets(process.env.WALLET_MNEMONIC, hdIndex);
  const TOKEN = process.env.BLOCKCYPHER_TOKEN;
  const address = wallets.btc;

  const utxoRes = await axios.get(
    `https://api.blockcypher.com/v1/btc/main/addrs/${address}?unspentOnly=true`,
    { params: { token: TOKEN } },
  );
  const utxos = utxoRes.data.txrefs || [];
  if (!utxos.length) {
    console.log(`[sweep:BTC] No UTXOs at ${address}`);
    return null;
  }

  const feeRes = await axios.get("https://api.blockcypher.com/v1/btc/main", {
    params: { token: TOKEN },
  });
  const feeRate = feeRes.data.medium_fee_per_kb / 1000;
  const estSize = utxos.length * 148 + 34 + 10;
  const feeSat = Math.ceil(feeRate * estSize);
  const totalSat = utxos.reduce((s, u) => s + u.value, 0);
  const sweepSat = totalSat - feeSat;

  if (sweepSat <= 0) {
    console.log(`[sweep:BTC] Balance too low to cover fees at ${address}`);
    return null;
  }

  const keyPair = ECPair.fromPrivateKey(
    Buffer.from(wallets.privateKeys.btc, "hex"),
    { network: bitcoin.networks.bitcoin },
  );
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

  for (const utxo of utxos) {
    const txRes = await axios.get(
      `https://api.blockcypher.com/v1/btc/main/txs/${utxo.tx_hash}?includeHex=true`,
      { params: { token: TOKEN } },
    );
    psbt.addInput({
      hash: utxo.tx_hash,
      index: utxo.tx_output_n,
      nonWitnessUtxo: Buffer.from(txRes.data.hex, "hex"),
    });
  }

  psbt.addOutput({ address: master.btc, value: sweepSat });
  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();

  const broadcastRes = await axios.post(
    "https://api.blockcypher.com/v1/btc/main/txs/push",
    { tx: rawTx },
    { params: { token: TOKEN } },
  );
  const txHash = broadcastRes.data.tx.hash;
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
