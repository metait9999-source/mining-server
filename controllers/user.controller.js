/**
 * user.controller.js  (FULL FILE — replaces your existing one)
 *
 * Changes from original:
 *  - signUpUser now calls assignCryptoWallets(newUserId) after user creation
 *  - createUserByWallet now calls assignCryptoWallets(newUserId) after user creation
 *  - New endpoint: getDepositAddresses — returns user's chain addresses
 *  - Everything else is unchanged
 */

const bcrypt = require("bcrypt");
const User = require("../models/user.model");
const { assignCryptoWallets } = require("../services/userWallets");
const db = require("../config").db;

// ─────────────────────────────────────────────────────────────────────────────
exports.getAllUsers = async (req, res) => {
  const { role } = req.query;
  try {
    const users = await User.getAll(role);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const user = await User.getById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getUserByWalletId = async (req, res) => {
  try {
    const user = await User.getByWalletId(req.params.walletID);
    if (!user) return res.status(404).json({ error: "User not found" });
    const hasPasscode = !!user.passcode;
    const { passcode, password, ...rest } = user;
    res.json({ ...rest, passcode_set: hasPasscode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.loginUser = async (req, res) => {
  try {
    const { emailOrMobile, password } = req.body;
    const user = await User.getByEmailOrMobileWithPassword(emailOrMobile);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (password) {
      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch)
        return res.status(401).json({ error: "Incorrect password" });
    }

    const permissionsArray = user.permissions
      ? user.permissions.split(",")
      : [];
    const { password: userPassword, ...userData } = user;
    res.json({ ...userData, permissions: permissionsArray });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATED: now assigns crypto wallets after creation
// ─────────────────────────────────────────────────────────────────────────────
exports.signUpUser = async (req, res) => {
  try {
    const { email, mobile, password, ...rest } = req.body;

    const existingUser = await User.getByEmailOrMobile(email || mobile);
    if (existingUser) {
      return res
        .status(400)
        .json({ error: "User already exists with this email or mobile" });
    }

    // Generate unique 6-digit UUID
    let uuid;
    let isUnique = false;
    while (!isUnique) {
      uuid = Math.floor(100000 + Math.random() * 900000).toString();
      const userWithUuid = await User.getByUUId(uuid);
      if (!userWithUuid) isUnique = true;
    }

    // Generate unique referral UUID
    let referral_uuid;
    let isReferralUnique = false;
    while (!isReferralUnique) {
      referral_uuid = Math.random().toString(36).substring(2, 10).toUpperCase();
      const [existing] = await db.query(
        "SELECT id FROM meta_ct_user WHERE referral_uuid = ?",
        [referral_uuid],
      );
      if (!existing.length) isReferralUnique = true;
    }

    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;

    const newUserId = await User.create({
      uuid,
      referral_uuid,
      email,
      mobile,
      password: hashedPassword,
      ...rest,
    });

    const wallets = await assignCryptoWallets(newUserId);
    console.log(wallets);
    res.status(201).json({
      id: newUserId,
      ...req.body,
      uuid,
      referral_uuid,
      password: undefined,
      deposit_addresses: {
        TRX: wallets.wallet_trx,
        USDT_TRC20: wallets.wallet_trx, // same address
        ETH: wallets.wallet_eth,
        USDT_ERC20: wallets.wallet_eth, // same address
        BTC: wallets.wallet_btc,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATED: also assigns crypto wallets for wallet-based signups
// ─────────────────────────────────────────────────────────────────────────────
exports.createUserByWallet = async (req, res) => {
  try {
    const { user_wallet, ...rest } = req.body;

    const existingUser = await User.getByWalletId(user_wallet);
    if (existingUser) {
      return res.status(200).json({
        exists: true,
        has_passcode: !!existingUser.passcode,
        id: existingUser.id,
        uuid: existingUser.uuid,
        status: existingUser.status,
      });
    }

    let uuid;
    let isUnique = false;
    while (!isUnique) {
      uuid = Math.floor(100000 + Math.random() * 900000).toString();
      const userWithUuid = await User.getByUUId(uuid);
      if (!userWithUuid) isUnique = true;
    }

    const newUserId = await User.create({ uuid, user_wallet, ...rest });

    // ── NEW ────────────────────────────────────────────────────────────────
    const wallets = await assignCryptoWallets(newUserId);
    // ──────────────────────────────────────────────────────────────────────
    console.log(wallets);
    res.status(201).json({
      exists: false,
      has_passcode: false,
      id: newUserId,
      uuid,
      user_wallet,
      deposit_addresses: {
        TRX: wallets.wallet_trx,
        USDT_TRC20: wallets.wallet_trx,
        ETH: wallets.wallet_eth,
        USDT_ERC20: wallets.wallet_eth,
        BTC: wallets.wallet_btc,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getDepositAddresses = async (req, res) => {
  try {
    const { userId } = req.params;
    const [[user]] = await db.query(
      "SELECT wallet_trx, wallet_eth, wallet_btc FROM meta_ct_user WHERE id = ?",
      [userId],
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.wallet_trx) {
      return res
        .status(404)
        .json({ error: "Deposit addresses not yet generated for this user" });
    }

    res.json({
      TRX: user.wallet_trx,
      USDT_TRC20: user.wallet_trx,
      ETH: user.wallet_eth,
      USDT_ERC20: user.wallet_eth,
      BTC: user.wallet_btc,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Everything below is UNCHANGED from your original
// ─────────────────────────────────────────────────────────────────────────────
exports.setPasscode = async (req, res) => {
  try {
    const { user_wallet, passcode } = req.body;
    if (!passcode || passcode.length !== 6 || !/^\d{6}$/.test(passcode)) {
      return res
        .status(400)
        .json({ error: "Passcode must be exactly 6 digits" });
    }
    const user = await User.getByWalletId(user_wallet);
    if (!user) return res.status(404).json({ error: "User not found" });
    const hashed = await bcrypt.hash(passcode, 10);
    await User.update(user.id, { passcode: hashed });
    const { passcode: _, password: __, ...userData } = user;
    res.json({
      message: "Passcode set successfully",
      id: user.id,
      uuid: user.uuid,
      user: { ...userData, passcode_set: true },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.verifyPasscode = async (req, res) => {
  try {
    const { user_wallet, passcode } = req.body;
    if (!passcode)
      return res.status(400).json({ error: "Passcode is required" });
    const user = await User.getByWalletId(user_wallet);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.passcode)
      return res.status(400).json({ error: "No passcode set" });
    const match = await bcrypt.compare(passcode, user.passcode);
    if (!match) return res.status(401).json({ error: "Incorrect passcode" });
    const { passcode: _, password: __, ...userData } = user;
    res.json({ verified: true, user: userData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.resetPasscode = async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    const user = await User.getById(user_id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const newPasscode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashed = await bcrypt.hash(newPasscode, 10);
    await User.update(user_id, { passcode: hashed });
    res.json({ newPasscode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { password, ...rest } = req.body;
    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
    const affectedRows = await User.update(req.params.id, {
      password: hashedPassword,
      ...rest,
    });
    if (affectedRows === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ message: "User updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const affectedRows = await User.delete(req.params.id);
    if (affectedRows === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.faceVerify = async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    await User.update(user_id, { face_image: req.file ? req.file.path : null });
    res.json({ message: "Face image uploaded successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateBalanceVisibility = async (req, res) => {
  try {
    await db.query("UPDATE meta_ct_user SET balance_visible = ? WHERE id = ?", [
      req.body.balance_visible,
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.toggleFreezeAccount = async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    const user = await User.getById(user_id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const newStatus = user.is_frozen ? 0 : 1;
    await User.update(user_id, { is_frozen: newStatus });
    res.json({
      message: newStatus ? "Account frozen" : "Account unfrozen",
      is_frozen: newStatus,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.uploadProfileImage = async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    await User.update(user_id, { profile_image: req.file.path });
    res.json({
      message: "Profile image uploaded successfully.",
      profile_image: req.file.path,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
