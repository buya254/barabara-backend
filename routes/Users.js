const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");

// These usernames should never show up in the frontend
const excludedUsernames = ["phabade", "bmagenyi"];

// One place to define default password (or override via .env)
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || "kura@123";

/** GET all users with optional filters */
router.get("/users", async (req, res) => {
  try {
    const { username, fy, project, phone } = req.query;

    let query = "SELECT * FROM users WHERE 1=1";
    const values = [];

    if (username) {
      query += " AND username LIKE ?";
      values.push(`%${username}%`);
    }

    if (fy) {
      query += " AND financial_year LIKE ?";
      values.push(`%${fy}%`);
    }

    if (project) {
      query += " AND project_name LIKE ?";
      values.push(`%${project}%`);
    }

    if (phone) {
      query += " AND phone LIKE ?";
      values.push(`%${phone}%`);
    }

    const [users] = await db.query(query, values);

    const filtered = users.filter((u) => !excludedUsernames.includes(u.username));

    res.json(filtered);
  } catch (err) {
    console.error("Failed to fetch users:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/** GET paginated users */
router.get("/users-paged", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  try {
    const [countResult] = await db.query("SELECT COUNT(*) AS total FROM users");
    const total = countResult[0].total;

    const [rows] = await db.query("SELECT * FROM users LIMIT ? OFFSET ?", [limit, offset]);

    const filtered = rows.filter((u) => !excludedUsernames.includes(u.username));

    res.json({
      users: filtered,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Pagination error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/** CREATE a new user */
/** CREATE a new user (manual or from UI) */
router.post("/users", async (req, res) => {
  const {
    id,                // National ID
    username,
    full_name,
    role,
    email,
    financial_year,
    project_name,
    project_number,
    phone,
  } = req.body;

  try {
    // --- Required fields ---
    if (!id || !username || !role || !financial_year) {
      return res.status(400).json({
        success: false,
        message: "id, username, role and financial_year are required",
      });
    }

    // --- National ID: 6–10 digits ---
    const idStr = String(id).trim();
    if (!/^\d{6,10}$/.test(idStr)) {
      return res.status(400).json({
        success: false,
        message: "National ID must be 6–10 digits (numbers only)",
      });
    }

    // --- Allowed roles (same set you expect in the system) ---
    const allowedRoles = ["admin", "inspector", "siteagent", "are", "re"];
    const normalizedRole = String(role).toLowerCase();

    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        message: `Role must be one of: ${allowedRoles.join(", ")}`,
      });
    }

    // --- Check for duplicates (ID or username) ---
    const [existing] = await db.query(
      "SELECT id, username FROM users WHERE id = ? OR username = ?",
      [idStr, username]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A user with this National ID or username already exists",
      });
    }

    // --- Hash default password (same as reset) ---
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    // --- Insert into users table ---
    const insertSql = `
      INSERT INTO users
        (id, username, password, role, full_name, email,
         financial_year, project_name, project_number, phone, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.query(insertSql, [
      idStr,
      username,
      passwordHash,
      normalizedRole,
      full_name || null,
      email || null,
      financial_year,
      project_name || null,
      project_number || null,
      phone || null,
      null, // signature
    ]);

    return res.status(201).json({
      success: true,
      message: "User created successfully",
      defaultPassword: DEFAULT_PASSWORD, // nice reminder for the UI
    });
  } catch (err) {
    console.error("Failed to create user:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/** UPDATE existing user */
router.put("/users/:id", async (req, res) => {
  const userId = req.params.id;
  const {
    username,
    role,
    full_name,
    email,
    financial_year,
    project_name,
    project_number,
    phone,
    signature,
  } = req.body;

  try {
    await db.query(
      `UPDATE users
      SET username = ?, role = ?, full_name = ?, email = ?,  
          financial_year = ?, project_name = ?, project_number = ?,  
          phone = ?, signature = ?
      WHERE id = ?`,
      [
        username,
        role,
        full_name,
        email,
        financial_year,
        project_name,
        project_number,
        phone,
        signature,
        userId,
      ]
    );

    res.json({ message: "User updated successfully" });
  } catch (err) {
    console.error("Failed to update user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/** RESET password to default */
router.put("/users/reset-password/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    const hashed = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    await db.query("UPDATE users SET password = ? WHERE id = ?", [hashed, userId]);

    res.json({
      success: true,
      message: "Password reset to default.",
      defaultPassword: DEFAULT_PASSWORD,
    });
  } catch (err) {
    console.error("Reset failed:", err);
    res.status(500).json({ success: false, message: "Reset failed." });
  }
});


/** DELETE user */
router.delete("/users/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    const [rows] = await db.query("SELECT username FROM users WHERE id = ?", [userId]);

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