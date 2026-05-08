const bip39 = require("bip39");
const hdkey = require("hdkey");
const { TronWeb } = require("tronweb");
const { ethers } = require("ethers");
const bitcoin = require("bitcoinjs-lib");
const ECPair = require("ecpair").ECPairFactory(require("tiny-secp256k1")); // ← ADD

const tronWeb = new TronWeb({
  fullHost: process.env.TRON_NODE || "https://api.trongrid.io",
});

function deriveAllWallets(mnemonic, index) {
  if (!mnemonic) throw new Error("WALLET_MNEMONIC is not set");

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = hdkey.fromMasterSeed(seed);

  // ── TRX ──────────────────────────────────────────────────────────────────
  const trxChild = root.derive(`m/44'/195'/0'/0/${index}`);
  const trxPrivateKey = trxChild.privateKey.toString("hex");
  const trxAddress = tronWeb.address.fromPrivateKey(trxPrivateKey);

  // ── ETH ──────────────────────────────────────────────────────────────────
  const ethChild = root.derive(`m/44'/60'/0'/0/${index}`);
  const ethPrivateKey = ethChild.privateKey.toString("hex");
  const ethWallet = new ethers.Wallet("0x" + ethPrivateKey);
  const ethAddress = ethWallet.address;

  // ── BTC ──────────────────────────────────────────────────────────────────
  const btcChild = root.derive(`m/44'/0'/0'/0/${index}`);
  const btcPrivateKey = btcChild.privateKey;
  const btcKeyPair = ECPair.fromPrivateKey(btcPrivateKey, {
    // ← CHANGED
    network: bitcoin.networks.bitcoin,
  });
  const { address: btcAddress } = bitcoin.payments.p2pkh({
    pubkey: btcKeyPair.publicKey,
    network: bitcoin.networks.bitcoin,
  });

  return {
    trx: trxAddress,
    eth: ethAddress,
    btc: btcAddress,
    privateKeys: {
      trx: trxPrivateKey,
      eth: ethPrivateKey,
      btc: btcPrivateKey.toString("hex"),
    },
  };
}

module.exports = { deriveAllWallets };
