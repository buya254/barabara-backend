const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

// GET /api/project-access/my-projects
router.get("/my-projects", authenticateJWT, async (req, res) => {
  try {
    const userId = String(req.user.id);
    const role = String(req.user.role || "").toLowerCase();

    // Admin sees all projects
    if (role === "admin") {
      const [all] = await db.query(
        "SELECT id, name, project_number FROM projects ORDER BY id DESC"
      );
      return res.json(all);
    }

    // Everyone else sees only projects where they are assigned
    const [rows] = await db.query(
      `
      SELECT p.id, p.name, p.project_number
      FROM project_workflow_assignments a
      JOIN projects p ON p.id = a.project_id
      WHERE a.siteagent_id = ?
         OR a.inspector_id = ?
         OR a.are_id = ?
         OR a.re_id = ?
      ORDER BY p.id DESC
      `,
      [userId, userId, userId, userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("❌ project access error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
