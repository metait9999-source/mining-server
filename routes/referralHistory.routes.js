const express = require("express");
const router = express.Router();
const referralHistoryController = require("../controllers/referralHistory.controller");

router.get("/user/:userId", referralHistoryController.getReferralHistoryByUser);
router.get("/referred/:userId", referralHistoryController.getReferredUsers);
router.get("/summary/:userId", referralHistoryController.getReferralSummary);

router.get("/", referralHistoryController.getAllReferralHistories);
router.get("/:id", referralHistoryController.getReferralHistoryById);
router.post("/", referralHistoryController.createReferralHistory);
router.put("/:id", referralHistoryController.updateReferralHistory);
router.delete("/:id", referralHistoryController.deleteReferralHistory);

module.exports = router;
