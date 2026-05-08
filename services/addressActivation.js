/**
 * addressActivation.js
 *
 * Pre-funds newly derived user addresses at registration so they are
 * immediately ready to receive deposits on all chains.
 *
 * Activation amounts (one-time cost per user):
 *
 *   TRON  → 1 TRX   (~$0.25)  REQUIRED — without it USDT-TRC20 transfers fail
 *   ETH   → 0.001 ETH (~$2.5) optional but ensures address shows in explorers
 *           and covers gas for the first sweep
 *   BTC   → 0.000005 BTC (~$0.30) dust — makes address visible on-chain
 *           (technically not required but good practice)
 *
 * Total activation cost per user: ~$3–4
 *
 * All funding comes from your MASTER wallets (same ones that receive sweeps).
 * Make sure your master wallets always hold enough balance for activations.
 */

require("dotenv").config();
const { TronWeb } = require("tronweb");
const { ethers } = require("ethers");
const axios = require("axios");
const bitcoin = require("bitcoinjs-lib");
const { getMasterWallets } = require("./masterWallet");
const ECPair = require("ecpair").ECPairFactory(require("tiny-secp256k1"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// TRON — send 1 TRX to activate new address
// ─────────────────────────────────────────────────────────────────────────────
async function activateTronAddress(userTrxAddress) {
  const ACTIVATION_TRX = 1; // 1 TRX minimum to activate

  const masterTron = new TronWeb({
    fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY },
    privateKey: process.env.SWEEP_PRIVATE_KEY_TRX,
  });

  try {
    const tx = await masterTron.trx.sendTransaction(
      userTrxAddress,
      ACTIVATION_TRX * 1_000_000, // in SUN
    );
    console.log(
      `[activation:TRX] ✅ Sent ${ACTIVATION_TRX} TRX to ${userTrxAddress} | tx: ${tx.txid}`,
    );
    return tx.txid;
  } catch (err) {
    // Non-fatal — log and continue. User can still receive TRX, just not TRC20 until funded
    console.error(
      `[activation:TRX] ❌ Failed for ${userTrxAddress}:`,
      err.message,
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ETH — send 0.001 ETH to activate new address
// ─────────────────────────────────────────────────────────────────────────────
async function activateEthAddress(userEthAddress) {
  const ACTIVATION_ETH = "0.001"; // covers ~3 USDT-ERC20 sweeps worth of gas

  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  const master = new ethers.Wallet(
    "0x" + process.env.SWEEP_PRIVATE_KEY_ETH,
    provider,
  );

  try {
    const tx = await master.sendTransaction({
      to: userEthAddress,
      value: ethers.parseEther(ACTIVATION_ETH),
    });
    await tx.wait(1); // wait 1 confirmation
    console.log(
      `[activation:ETH] ✅ Sent ${ACTIVATION_ETH} ETH to ${userEthAddress} | tx: ${tx.hash}`,
    );
    return tx.hash;
  } catch (err) {
    console.error(
      `[activation:ETH] ❌ Failed for ${userEthAddress}:`,
      err.message,
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BTC — send dust (546 sat minimum) to activate new address
// ─────────────────────────────────────────────────────────────────────────────
async function activateBtcAddress(userBtcAddress) {
  const DUST_SAT = 1000; // slightly above 546 dust limit
  const TOKEN = process.env.BLOCKCYPHER_TOKEN;
  const master = await getMasterWallets();
  const MASTER = master.btc;

  try {
    // Fetch master UTXOs
    const utxoRes = await axios.get(
      `https://api.blockcypher.com/v1/btc/main/addrs/${MASTER}?unspentOnly=true`,
      { params: { token: TOKEN } },
    );
    const utxos = utxoRes.data.txrefs || [];
    if (!utxos.length) {
      console.warn("[activation:BTC] No UTXOs available on master wallet");
      return null;
    }

    // Pick largest UTXO to cover dust + fee
    const utxo = utxos.sort((a, b) => b.value - a.value)[0];

    // Estimate fee (10 sat/byte × ~250 bytes)
    const feeSat = 2500;
    const changeSat = utxo.value - DUST_SAT - feeSat;
    if (changeSat < 0) {
      console.warn("[activation:BTC] Insufficient UTXO for dust activation");
      return null;
    }

    const masterPrivKey = Buffer.from(process.env.SWEEP_PRIVATE_KEY_BTC, "hex");
    const keyPair = ECPair.fromPrivateKey(masterPrivKey, {
      network: bitcoin.networks.bitcoin,
    });

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

    // Fetch full tx hex for nonWitnessUtxo
    const txRes = await axios.get(
      `https://api.blockcypher.com/v1/btc/main/txs/${utxo.tx_hash}?includeHex=true`,
      { params: { token: TOKEN } },
    );
    const fullTxHex = txRes.data.hex;

    psbt.addInput({
      hash: utxo.tx_hash,
      index: utxo.tx_output_n,
      nonWitnessUtxo: Buffer.from(fullTxHex, "hex"),
    });
    psbt.addOutput({ address: userBtcAddress, value: DUST_SAT });
    if (changeSat > 546) {
      psbt.addOutput({ address: MASTER, value: changeSat });
    }

    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();
    const rawHex = psbt.extractTransaction().toHex();

    const broadcastRes = await axios.post(
      "https://api.blockcypher.com/v1/btc/main/txs/push",
      { tx: rawHex },
      { params: { token: TOKEN } },
    );
    const txHash = broadcastRes.data.tx.hash;
    console.log(
      `[activation:BTC] ✅ Sent dust to ${userBtcAddress} | tx: ${txHash}`,
    );
    return txHash;
  } catch (err) {
    console.error(
      `[activation:BTC] ❌ Failed for ${userBtcAddress}:`,
      err.message,
    );
    return null;
  }
}

async function activateAllAddresses({ wallet_trx, wallet_eth, wallet_btc }) {
  console.log(`[activation] Starting activation for new user addresses...`);

  // Run in parallel — failures are non-fatal individually
  const [trxTx, ethTx, btcTx] = await Promise.allSettled([
    activateTronAddress(wallet_trx),
    // activateEthAddress(wallet_eth),
    // activateBtcAddress(wallet_btc),
  ]);

  // console.log(
  //   `[activation] Done. TRX: ${trxTx.value || "failed"} | ETH: ${ethTx.value || "failed"} | BTC: ${btcTx.value || "failed"}`,
  // );
}

module.exports = {
  activateAllAddresses,
  activateTronAddress,
  activateEthAddress,
  activateBtcAddress,
};
