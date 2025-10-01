const express = require("express");
const router = express.Router();
const db = require("../db"); // 👈 adjust path if your db file is in another folder
const bcrypt = require("bcrypt"); // in case you want to hash passwords

// 🔒 Users that should never be visible or deletable in UI
const excludedUsernames = ["phabade", "bmagenyi"];

/**
 * GET all users
 * Example: GET /api/users
 */
router.get("/users", async (req, res) => {
  try {
    const [users] = await db.query("SELECT * FROM users");

    // Filter out seeded users
    const filtered = users.filter(
      (u) => !excludedUsernames.includes(u.username)
    );

    res.json(filtered);
  } catch (err) {
    console.error("Failed to fetch users:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * CREATE new user
 * Example: POST /api/users
 */
router.post("/users", async (req, res) => {
  const { username, email, role, password } = req.body;

  if (!username || !email || !role) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    // Hash password if provided, else use default
    const passwordHash = password
      ? await bcrypt.hash(password, 10)
      : await bcrypt.hash("ChangeMe123", 10);

    await db.query(
      "INSERT INTO users (username, email, role, password_hash) VALUES (?, ?, ?, ?)",
      [username, email, role, passwordHash]
    );

    res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    console.error("Failed to create user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * UPDATE existing user
 * Example: PUT /api/users/5
 */
router.put("/users/:id", async (req, res) => {
  const userId = req.params.id;
  const { username, email, role } = req.body;

  try {
    await db.query(
      "UPDATE users SET username = ?, email = ?, role = ? WHERE id = ?",
      [username, email, role, userId]
    );

    res.json({ message: "User updated successfully" });
  } catch (err) {
    console.error("Failed to update user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * DELETE user
 * Example: DELETE /api/users/5
 */
router.delete("/users/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    // First check if user is protected
    const [rows] = await db.query("SELECT username FROM users WHERE id = ?", [
      userId,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (excludedUsernames.includes(rows[0].username)) {
      return res.status(403).json({ message: "Cannot delete seeded users" });
    }

    await db.query("DELETE FROM users WHERE id = ?", [userId]);

    res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("Failed to delete user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
