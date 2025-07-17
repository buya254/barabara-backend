const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../db"); // adjust if you move it

router.post("/", async (req, res) => {
  const { username, password } = req.body;

  console.log("🛎️ Login attempt:");
  console.log("Username received:", username);
  console.log("Password received:", password);

  try {
    const [rows] = await db.execute(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ msg: "User not found" });
    }

    const user = rows[0];
    console.log("🔐 Stored hash:", user.password_hash);

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(403).json({ msg: "Invalid credentials" });
    }

    const userData = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    res.json({ user: userData });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;
