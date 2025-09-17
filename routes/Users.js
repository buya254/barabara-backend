// routes/users.js
const express = require("express");
const router = express.Router();
const db = require("../db");

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
router.get("/users", async (req, res) => {
  try {
    const users = await db.query("SELECT * FROM users");
    res.json(users[0]); // for MySQL [0] holds rows
  } catch (err) {
    console.error("Failed to fetch users:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
