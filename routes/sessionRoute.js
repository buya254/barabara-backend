const express = require("express");
const router = express.Router();

router.get("/check-session", (req, res) => {
  if (req.session && req.session.user) {
    return res.json({
      loggedIn: true,
      user: req.session.user
    });
  }
  res.json({ loggedIn: false });
});

module.exports = router;
