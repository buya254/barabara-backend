const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

// GET /api/project-access/my-projects
router.get("/my-projects", authenticateJWT, async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const role = String(req.user.role || "").toLowerCase();

    if (!Number.isInteger(userId)) {
      return res.status(401).json({ message: "Invalid user token" });
    }

    // Admin sees all projects
    if (role === "admin") {
      const [all] = await db.query(`
        SELECT 
          id,
          project_name AS name,
          project_name,
          project_number,
          region,
          financial_year
        FROM projects
        ORDER BY id DESC
      `);

      return res.json(all || []);
    }

    // Everyone else sees projects assigned through Utilities user_projects
    const [rows] = await db.query(
      `
        SELECT 
          p.id,
          p.project_name AS name,
          p.project_name,
          p.project_number,
          p.region,
          p.financial_year,
          up.is_primary
        FROM user_projects up
        JOIN projects p ON p.id = up.project_id
        WHERE up.user_id = ?
        ORDER BY up.is_primary DESC, p.id DESC
      `,
      [userId]
    );

    return res.json(rows || []);
  } catch (err) {
    console.error("❌ project access error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;