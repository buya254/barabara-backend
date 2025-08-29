const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

router.post("/", async (req, res) => {
  const { username, password, role, fy } = req.body;
  const roleTable = `users_${role.toLowerCase()}`;

  console.log("🔐 Login attempt:");
  console.log(" - Username:", username);
  console.log(" - Role:", role);
  console.log(" - FY:", fy);

  try {
    const [rows] = await db.query(
      `SELECT u.*, r.full_name
       FROM users u
       JOIN ${roleTable} r ON u.id = r.user_id
       WHERE u.username = ?`,
      [username]
    );

    if (rows.length === 0) {
      console.log("❌ User not found in", roleTable);
      return res.status(401).json({ message: "User not found" });
    }

    const user = rows[0];
    console.log("✅ User found:", user.username);

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      console.log("❌ Incorrect password for", username);
      return res.status(401).json({ message: "Incorrect password" });
    }

    const payload = {
      id: user.id,
      username: user.username,
      role,
      fy
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1h" });

    console.log("✅ Token generated for", username);
    console.log("📦 Payload:", payload);

    res.json({
      message: "Login successful",
      token,
      user: {
        username: user.username,
        role,
        full_name: user.full_name,
        fy
      }
    });

  } catch (err) {
    console.error("🔥 Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
