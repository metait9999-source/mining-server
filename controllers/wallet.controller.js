const walletModel = require("../models/wallet.model");
const fs = require("fs");
const path = require("path");

const unlinkFile = (filePath) => {
  if (!filePath) return;
  const fullPath = path.join(__dirname, "..", filePath);
  fs.unlink(fullPath, (err) => {
    if (err) console.error("Failed to unlink file:", fullPath, err.message);
  });
};

exports.getAllWallets = async (req, res) => {
  try {
    const wallets = await walletModel.getAllWallets();
    res.status(200).json(wallets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllWalletsWithUserBalance = async (req, res) => {
  const { userId } = req.params;
  try {
    const wallets = await walletModel.getAllWalletsWithUserBalance(userId);
    res.status(200).json(wallets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getWalletById = async (req, res) => {
  const { id } = req.params;
  try {
    const wallet = await walletModel.getWalletById(id);
    if (wallet) {
      res.status(200).json(wallet);
    } else {
      res.status(404).json({ message: "Wallet not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createWallet = async (req, res) => {
  const walletData = req.body;
  const { coin_logo, wallet_qr } = req.walletFiles;

  const walletDataWithImg = {
    coin_id: walletData.coin_id,
    coin_name: walletData.coin_name,
    coin_logo: coin_logo,
    wallet_network: walletData.wallet_network,
    coin_symbol: walletData.coin_symbol,
    wallet_address: walletData.wallet_address,
    wallet_qr: wallet_qr,
  };

  try {
    const newWalletId = await walletModel.createWallet(walletDataWithImg);
    res.status(201).json({ id: newWalletId, ...walletDataWithImg });
  } catch (error) {
    unlinkFile(coin_logo);
    unlinkFile(wallet_qr);
    res.status(500).json({ message: error.message });
  }
};

exports.updateWallet = async (req, res) => {
  const { id } = req.params;
  const walletData = req.body;
  const { coin_logo, wallet_qr } = req.walletFiles;

  const walletDataWithImg = {
    coin_id: walletData.coin_id,
    coin_name: walletData.coin_name,
    coin_logo: coin_logo ?? walletData.coin_logo,
    wallet_network: walletData.wallet_network,
    coin_symbol: walletData.coin_symbol,
    wallet_address: walletData.wallet_address,
    wallet_qr: wallet_qr ?? walletData.wallet_qr,
    status: walletData.status,
  };

  try {
    const affectedRows = await walletModel.updateWallet(id, walletDataWithImg);
    if (affectedRows > 0) {
      res.status(200).json({ id, ...walletDataWithImg });
    } else {
      unlinkFile(coin_logo);
      unlinkFile(wallet_qr);
      res.status(404).json({ message: "Wallet not found" });
    }
  } catch (error) {
    unlinkFile(coin_logo);
    unlinkFile(wallet_qr);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteWallet = async (req, res) => {
  const { id } = req.params;
  try {
    const wallet = await walletModel.getWalletById(id);
    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    const affectedRows = await walletModel.deleteWallet(id);
    if (affectedRows > 0) {
      unlinkFile(wallet.coin_logo);
      unlinkFile(wallet.wallet_qr);
      res.status(200).json({ message: "Wallet deleted successfully" });
    } else {
      res.status(404).json({ message: "Wallet not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
