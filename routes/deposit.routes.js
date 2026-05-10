const express = require("express");
const router = express.Router();
const controller = require("../controllers/deposit.controller");
const checkFrozen = require("../middlewares/checkFrozen");

router.post("/check", checkFrozen, controller.checkDeposit);
router.get("/user/:userId", controller.getDepositsByUserId);

router.get("/", controller.getAllDeposits);
router.get("/unseen-count", controller.getUnseenCount);
router.put("/mark-seen", controller.markAllSeen);
router.get("/:id", controller.getDepositById);
router.delete("/:id", controller.deleteDeposit);

module.exports = router;
