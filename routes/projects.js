const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

function isAdmin(user) {
  return String(user?.role || "").toLowerCase() === "admin";
}

router.get("/:id/roads", authenticateJWT, async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (Number.isNaN(projectId)) {
      return res.status(400).json({ message: "Invalid project id" });
    }

    const [rows] = await db.query(
      `
      SELECT
        id,
        project_id,
        project_name,
        chainage_from,
        chainage_to
      FROM project_roads
      WHERE project_id = ?
      ORDER BY project_name
      `,
      [projectId]
    );

    return res.json({ success: true, roads: rows });
  } catch (err) {
    console.error("Error fetching project roads:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch roads for this project",
    });
  }
});
// POST /api/projects/:id/roads  -> add ONE road under a project
router.post("/:id/roads", authenticateJWT, async (req, res) => {
  try {
    // Admin-only (match your projects admin rules)
    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const projectId = parseInt(req.params.id, 10);
    if (Number.isNaN(projectId)) {
      return res.status(400).json({ message: "Invalid project id" });
    }

    const { project_name, chainage_from, chainage_to } = req.body || {};

    if (!project_name || String(project_name).trim().length === 0) {
      return res.status(400).json({ message: "project_name is required" });
    }

    await db.query(
      `
      INSERT INTO project_roads (project_id, project_name, chainage_from, chainage_to)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        chainage_from = VALUES(chainage_from),
        chainage_to   = VALUES(chainage_to)
      `,
      [
        projectId,
        String(project_name).trim(),
        chainage_from ? String(chainage_from).trim() : null,
        chainage_to ? String(chainage_to).trim() : null,
      ]
    );

    return res.json({ success: true, message: "Road saved" });
  } catch (err) {
    console.error("Error inserting road:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
/**
 * GET /api/projects?financial_year=2025/26
 */
router.get("/", authenticateJWT, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const { financial_year } = req.query;
    let sql = `
      SELECT id, region, project_number, project_name, name,
             chainage, contractor, project_duration, financial_year
      FROM projects
      WHERE 1=1
    `;
    const vals = [];

    if (financial_year) {
      sql += " AND financial_year = ?";
      vals.push(financial_year);
    }

    sql += " ORDER BY financial_year DESC, project_number, project_name";

    const [rows] = await db.query(sql, vals);
    return res.json(rows);
  } catch (err) {
    console.error("❌ projects list error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});
// GET /api/projects-paged?page=1&limit=10&project_name=&project_number=&region=&financial_year=
router.get("/paged", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "10", 10), 1);
    const offset = (page - 1) * limit;

    const {
      project_name,
      project_number,
      region,
      financial_year,
    } = req.query;

    const where = [];
    const params = [];

    if (project_name) {
      where.push("(project_name LIKE ? OR name LIKE ?)");
      params.push(`%${project_name}%`, `%${project_name}%`);
    }
    if (project_number) {
      where.push("project_number LIKE ?");
      params.push(`%${project_number}%`);
    }
    if (region) {
      where.push("region = ?");
      params.push(region);
    }
    if (financial_year) {
      where.push("financial_year = ?");
      params.push(financial_year);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // total count
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM projects ${whereSql}`,
      params
    );
    const total = countRows?.[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    // page rows
    const [rows] = await db.query(
      `
      SELECT id, region, project_number, project_name, chainage, contractor, project_duration, financial_year
      FROM projects
      ${whereSql}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({
      success: true,
      projects: rows,
      total,
      page,
      totalPages,
    });
  } catch (err) {
    console.error("projects-paged error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch paged projects",
    });
  }
});
/**
 * POST /api/projects
 * body: { region, project_number, project_name, chainage,
 *         contractor, project_duration, financial_year }
 */
router.post("/", authenticateJWT, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const {
      region,
      project_number,
      project_name,
      chainage,
      contractor,
      project_duration,
      financial_year,
    } = req.body;

    if (!project_number || !project_name || !financial_year) {
      return res.status(400).json({
        message: "project_number, project_name and financial_year are required",
      });
    }

    // ✅ Make sure at least one user has this project_number
    const [userContract] = await db.query(
      "SELECT 1 FROM users WHERE project_number = ? LIMIT 1",
      [project_number]
    );
    if (userContract.length === 0) {
      return res.status(400).json({
        message:
          "No users have this project_number. Please assign it to at least one user first.",
      });
    }

    const [result] = await db.query(
      `
      INSERT INTO projects
        (region, project_number, project_name, name, chainage,
         contractor, project_duration, financial_year)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        region || null,
        project_number,
        project_name,
        project_name, // keep `name` synced to road name
        chainage || null,
        contractor || null,
        project_duration || null,
        financial_year,
      ]
    );

    const [row] = await db.query(
      "SELECT * FROM projects WHERE id = ?",
      [result.insertId]
    );

    return res.status(201).json(row[0]);
  } catch (err) {
    console.error("❌ project create error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * PUT /api/projects/:id
 */
router.put("/:id", authenticateJWT, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const projectId = req.params.id;
    const {
      region,
      project_number,
      project_name,
      chainage,
      contractor,
      project_duration,
      financial_year,
    } = req.body;

    // if project_number is changing, verify users table
    if (project_number) {
      const [userContract] = await db.query(
        "SELECT 1 FROM users WHERE project_number = ? LIMIT 1",
        [project_number]
      );
      if (userContract.length === 0) {
        return res.status(400).json({
          message:
            "No users have this project_number. Please assign it in users before using it for a project.",
        });
      }
    }

    await db.query(
      `
      UPDATE projects
      SET
        region          = COALESCE(?, region),
        project_number  = COALESCE(?, project_number),
        project_name    = COALESCE(?, project_name),
        name            = COALESCE(?, name),
        chainage        = COALESCE(?, chainage),
        contractor      = COALESCE(?, contractor),
        project_duration= COALESCE(?, project_duration),
        financial_year  = COALESCE(?, financial_year)
      WHERE id = ?
      `,
      [
        region || null,
        project_number || null,
        project_name || null,
        project_name || null,
        chainage || null,
        contractor || null,
        project_duration || null,
        financial_year || null,
        projectId,
      ]
    );

    const [rows] = await db.query(
      "SELECT * FROM projects WHERE id = ?",
      [projectId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("❌ project update error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
