const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

router.post("/", async (req, res) => {
  // We only need username + password from the frontend
  const { username, password } = req.body;

  console.log("🔐 Login attempt:");
  console.log(" - Username:", username);

  try {
    // 1️⃣ Look up the user in the main users table
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0) {
      console.log("❌ User not found in users table");
      return res.status(401).json({ message: "User not found" });
    }

    const user = rows[0];

    const role = user.role;
    const fy = user.financial_year; // use your actual column name

    console.log(" - Role from DB:", role);
    console.log(" - FY from DB:", fy);

    // 2️⃣ Check password (works for seeded + default users)
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      console.log("❌ Incorrect password for", username);
      return res.status(401).json({ message: "Incorrect password" });
    }

    // 3️⃣ Build JWT payload using role + fy from DB
    const payload = {
      id: user.id,
      username: user.username,
      role,
      fy,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    console.log("✅ Token generated for", username);
    console.log("📦 Payload:", payload);

    // 4️⃣ Send back user info (full_name optional)
    res.json({
      message: "Login successful",
      token,
      user: {
        username: user.username,
        role,
        full_name: user.full_name || null, // safe if column missing
        fy,
      },
    });
  } catch (err) {
    console.error("🔥 Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
