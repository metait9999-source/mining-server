const express = require("express");
const userController = require("../controllers/user.controller");
const uploadMiddleware = require("../middlewares/uploadMiddleware");
const router = express.Router();

router.get("/", userController.getAllUsers);
router.get("/:id", userController.getUserById);
router.get("/wallet/:walletID", userController.getUserByWalletId);
router.post("/create", userController.createUserByWallet);
router.post("/set-passcode", userController.setPasscode);
router.post("/verify-passcode", userController.verifyPasscode);
router.post("/reset-passcode", userController.resetPasscode);
router.post("/face-verify", uploadMiddleware, userController.faceVerify);
router.put("/:id/balance-visibility", userController.updateBalanceVisibility);
router.post("/freeze", userController.toggleFreezeAccount);
router.post(
  "/upload-profile-image",
  uploadMiddleware,
  userController.uploadProfileImage,
);
router.get("/:userId/deposit-addresses", userController.getDepositAddresses);
// router.post('/', userController.createUser);
router.put("/:id", userController.updateUser);
router.delete("/:id", userController.deleteUser);
router.post("/signup", userController.signUpUser);
router.post("/login", userController.loginUser);

module.exports = router;
