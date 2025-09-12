// routes/users.js
const express = require("express");
const router = express.Router();

// POST /users/import
router.post("/import", async (req, res) => {
  try {
    const users = req.body;
    let successCount = 0;

    for (const user of users) {
      if (user.username && user.password && user.role && user.fy) {
        // TODO: hash password, save to DB
        // await db.insertUser(user);
        successCount++;
      }
    }

    res.json({ successCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error during import" });
  }
});

module.exports = router;
