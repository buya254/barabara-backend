const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const authenticateJWT = require("../middlewares/auth");

// POST /api/auth/change-password
router.post("/change-password", authenticateJWT, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: "oldPassword and newPassword are required" });
  }

  try {
    // req.user comes from JWT payload in loginRoute.js
    const userId = req.user.id;

    const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    // Compare old password
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    // Hash new password
    const hashed = await bcrypt.hash(newPassword, 10);

    // Clear flag + set updated timestamp
    await db.query(
      "UPDATE users SET password = ?, must_change_password = 0, password_updated_at = NOW() WHERE id = ?",
      [hashed, userId]
    );

    return res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("🔥 Change password error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
