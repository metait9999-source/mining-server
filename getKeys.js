require("dotenv").config();
const bip39 = require("bip39");
const hdkey = require("hdkey");
const { TronWeb } = require("tronweb");
const { ethers } = require("ethers");

const mnemonic =
  "dwarf machine armed garden jump divert south liquid pottery vapor kid slot";

const seed = bip39.mnemonicToSeedSync(mnemonic);
const root = hdkey.fromMasterSeed(seed);

// ETH
const ethChild = root.derive("m/44'/60'/0'/0/0");
const ethKey = ethChild.privateKey.toString("hex");
const ethWallet = new ethers.Wallet("0x" + ethKey);
console.log("ETH Address:     ", ethWallet.address);
console.log("ETH Private Key: ", ethKey);

// TRX
const tronWeb = new TronWeb({ fullHost: "https://api.trongrid.io" });
const trxChild = root.derive("m/44'/195'/0'/0/0");
const trxKey = trxChild.privateKey.toString("hex");
const trxAddr = tronWeb.address.fromPrivateKey(trxKey);
console.log("TRX Address:     ", trxAddr);
console.log("TRX Private Key: ", trxKey);

// BTC
const bitcoin = require("bitcoinjs-lib");
const ECPair = require("ecpair").ECPairFactory(require("tiny-secp256k1"));
const btcChild = root.derive("m/84'/0'/0'/0/0");
const btcKey = btcChild.privateKey.toString("hex");
const keyPair = ECPair.fromPrivateKey(btcChild.privateKey, {
  network: bitcoin.networks.bitcoin,
});
const { address: btcAddr } = bitcoin.payments.p2wpkh({
  pubkey: keyPair.publicKey,
  network: bitcoin.networks.bitcoin,
});
console.log("BTC Address:     ", btcAddr);
console.log("BTC Private Key: ", btcKey);
