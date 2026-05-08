const express = require("express");
const router = express.Router();
const VisitorController = require("../controllers/visitor.controller");

router.post("/track", VisitorController.track);

router.get("/stats", VisitorController.stats);

module.exports = router;
