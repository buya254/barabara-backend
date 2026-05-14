const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");

const authenticateJWT = require("../middlewares/auth");

// These usernames should never show up in the frontend
const excludedUsernames = ["phabade", "bmagenyi"];

// One place to define default password (or override via .env)
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || "Kura1234";

/** GET all users with optional filters, including read-only assigned projects */
/** GET all users with optional filters, including read-only assigned projects */
router.get("/users", async (req, res) => {
  try {
    const { username, fy, phone, region } = req.query;

    let query = `
      SELECT *
      FROM users
      WHERE username NOT IN (?, ?)
    `;

    const values = [...excludedUsernames];

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

    query += " ORDER BY role, region, full_name, username";

    const [users] = await db.query(query, values);

    if (!users || users.length === 0) {
      return res.json([]);
    }

    const userIds = users.map((u) => u.id);
    const placeholders = userIds.map(() => "?").join(", ");

    const [projectRows] = await db.query(
      `
      SELECT
        up.user_id,
        up.project_id,
        up.is_primary,
        p.project_number,
        p.project_name,
        p.region,
        p.financial_year
      FROM user_projects up
      INNER JOIN projects p
        ON p.id = up.project_id
      WHERE up.user_id IN (${placeholders})
      ORDER BY
        up.user_id,
        up.is_primary DESC,
        p.project_number ASC,
        p.project_name ASC
      `,
      userIds
    );

    const projectMap = new Map();

    for (const row of projectRows || []) {
      const key = String(row.user_id);

      if (!projectMap.has(key)) {
        projectMap.set(key, []);
      }

      projectMap.get(key).push({
        project_id: row.project_id,
        is_primary: row.is_primary,
        project_number: row.project_number,
        project_name: row.project_name,
        region: row.region,
        financial_year: row.financial_year,
      });
    }

    const enrichedUsers = users.map((user) => {
      const assignedProjects = projectMap.get(String(user.id)) || [];

      const primaryProject =
        assignedProjects.find((p) => Number(p.is_primary) === 1) ||
        assignedProjects[0] ||
        null;

      return {
        ...user,
        assigned_projects: assignedProjects,

        // These are the visible first/default values.
        project_number: primaryProject?.project_number || "",
        project_name: primaryProject?.project_name || "",
      };
    });

    return res.json(enrichedUsers);
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
router.put("/users/:id", authenticateJWT, async (req, res) => {
  try {
    const { full_name, email, phone, region, financial_year, role } = req.body;

    await db.query(
      `
      UPDATE users
      SET
        full_name      = COALESCE(?, full_name),
        email          = COALESCE(?, email),
        phone          = COALESCE(?, phone),
        region         = COALESCE(?, region),
        financial_year = COALESCE(?, financial_year),
        role           = COALESCE(?, role)
      WHERE id = ?
      `,
      [
        full_name ?? null,
        email ?? null,
        phone ?? null,
        region ?? null,
        financial_year ?? null,
        role ?? null,
        req.params.id,
      ]
    );

    res.json({ success: true, message: "User updated" });
  } catch (err) {
    console.error("users update error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/** RESET password to default */
router.put("/users/reset_password/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    await db.query(
      `
      UPDATE users
      SET password = ?, must_change_password = 1, password_updated_at = NULL
      WHERE id = ?
      `,
      [passwordHash, userId]
    );

    res.json({
      success: true,
      message: "Password reset to default",
      defaultPassword: DEFAULT_PASSWORD,
    });
  } catch (err) {
    console.error("Failed to reset password:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;