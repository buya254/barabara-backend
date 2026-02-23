const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");

// These usernames should never show up in the frontend
const excludedUsernames = ["phabade", "bmagenyi"];

// One place to define default password (or override via .env)
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || "Kura1234";

/** GET all users with optional filters */
router.get("/users", async (req, res) => {
  try {
    const { username, fy, phone, region } = req.query;

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

    if (phone) {
      query += " AND phone LIKE ?";
      values.push(`%${phone}%`);
    }
    if (region) {
      query += " AND region LIKE ?";
      values.push(`%${region}%`);
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

/** EXPORT all users (except seeded) as CSV */
router.get("/users/export", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT 
        id,
        username,
        full_name,
        role,
        region,
        email,
        financial_year,
        phone
      FROM users
      WHERE username NOT IN (?, ?)
      ORDER BY username
      `,
      excludedUsernames
    );

    const headers = [
      "National ID",
      "Username",
      "Full Name",
      "Role",
      "Region",
      "Email",
      "Financial Year",
      "Phone",
    ];

    const csvRows = [headers];

    for (const row of rows) {
      const line = [
        row.id ?? "",
        row.username ?? "",
        row.full_name ?? "",
        row.role ?? "",
        row.region ??"",
        row.email ?? "",
        row.financial_year ?? "",
        row.phone ?? "",
      ].map((value) =>
        `"${String(value).replace(/"/g, '""')}"`
      ); // escape double quotes

      csvRows.push(line.join(","));
    }

    const csvContent = csvRows.join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Users_Backup.csv"
    );
    res.send(csvContent);
  } catch (err) {
    console.error("Failed to export users:", err);
    res.status(500).json({ message: "Failed to export users" });
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
    region,
    email,
    financial_year,
    phone,
  } = req.body;

  try {
    // --- Required fields ---
    if (!id || !username || !role || !financial_year || !region) {
      return res.status(400).json({
        success: false,
        message: "id, username, role, region and financial_year are required",
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
        (id, username, password, role, region, full_name, email, financial_year, phone, signature, must_change_password, password_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

      await db.query(insertSql, [
        idStr,
        username,
        passwordHash,
        normalizedRole,
        region || null,
        full_name || null,
        email || null,
        financial_year,
        phone || null,
        null, // signature
        excludedUsernames.includes(username) ? 0 : 1, // must_change_password
        null, // password_updated_at
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
    region,
    full_name,
    email,
    financial_year,
    phone,
    signature,
  } = req.body;

  try {
    await db.query(
      `UPDATE users
      SET username = ?, role = ?, region = ?,full_name = ?, email = ?,  
          financial_year = ?, phone = ?, signature = ?
      WHERE id = ?`,
      [
        username,
        role,
        region,
        full_name,
        email,
        financial_year,
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
router.put("/users/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    const allowed = [
      "username",
      "role",
      "region",
      "full_name",
      "email",
      "financial_year",
      "phone",
      "signature",
    ];

    const updates = [];
    const values = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    values.push(userId);

    const sql = `UPDATE users SET ${updates.join(", ")} WHERE id = ?`;
    await db.query(sql, values);

    res.json({ message: "User updated successfully" });
  } catch (err) {
    console.error("Failed to update user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;