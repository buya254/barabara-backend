const express = require("express");
const db = require("../db");

const router = express.Router();

/**
 * POST /api/utilities/assign-user-project
 * Body: { user_id, project_id, make_primary?: boolean }
 *
 * - Inserts/updates link in user_projects
 * - If make_primary = true, also copies project_number, project_name,
 *   financial_year and region onto the users table (so your existing
 *   screens still work).
 */
router.post("/assign-user-project", (req, res) => {
  const { user_id, project_id, make_primary } = req.body;

  if (!user_id || !project_id) {
    return res
      .status(400)
      .json({ message: "user_id and project_id are required" });
  }

  const insertSql = `
    INSERT INTO user_projects (user_id, project_id, is_primary)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary)
  `;

  db.query(
    insertSql,
    [user_id, project_id, make_primary ? 1 : 0],
    (err) => {
      if (err) {
        console.error("Error inserting user_projects:", err);
        return res
          .status(500)
          .json({ message: "Failed to assign project to user" });
      }

      if (!make_primary) {
        return res.json({ success: true, message: "Assignment saved" });
      }

      // Also update users table so your existing flows still work
      const updateUserSql = `
        UPDATE users u
        JOIN projects p ON p.id = ?
        SET 
          u.project_number = p.project_number,
          u.project_name   = p.project_name,
          u.financial_year = p.financial_year,
          u.region         = p.region
        WHERE u.id = ?
      `;

      db.query(updateUserSql, [project_id, user_id], (err2) => {
        if (err2) {
          console.error("Error updating user with project data:", err2);
          return res.status(500).json({
            message:
              "Project assigned but failed to sync main user record",
          });
        }

        return res.json({
          success: true,
          message: "Project assigned and set as primary for user",
        });
      });
    }
  );
});

/**
 * GET /api/utilities/user-projects/:userId
 * Returns all projects linked to that user.
 */
router.get("/user-projects/:userId", (req, res) => {
  const userId = req.params.userId;

  const sql = `
    SELECT 
      up.id,
      up.is_primary,
      p.id AS project_id,
      p.project_number,
      p.project_name,
      p.region,
      p.financial_year
    FROM user_projects up
    JOIN projects p ON p.id = up.project_id
    WHERE up.user_id = ?
    ORDER BY up.is_primary DESC, p.project_number ASC
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error("Error getting user projects:", err);
      return res.status(500).json({ message: "Failed to load user projects" });
    }
    res.json(rows);
  });
});

/**
 * GET /api/utilities/project-activities/:projectId
 * All activities mapped to that project.
 */
router.get("/project-activities/:projectId", (req, res) => {
  const projectId = req.params.projectId;

  const sql = `
    SELECT 
      pa.id,
      pa.is_active,
      a.id AS activity_id,
      a.code,
      a.name,
      a.unit
    FROM project_activities pa
    JOIN activities a ON a.id = pa.activity_id
    WHERE pa.project_id = ?
    ORDER BY a.code ASC
  `;

  db.query(sql, [projectId], (err, rows) => {
    if (err) {
      console.error("Error loading project activities:", err);
      return res
        .status(500)
        .json({ message: "Failed to load project activities" });
    }
    res.json(rows);
  });
});

/**
 * POST /api/utilities/project-activities/:projectId
 * Body: { activityIds: number[] }
 * Replaces the list of activities for that project.
 */
router.post("/project-activities/:projectId", (req, res) => {
  const projectId = req.params.projectId;
  const { activityIds } = req.body;

  if (!Array.isArray(activityIds)) {
    return res
      .status(400)
      .json({ message: "activityIds must be an array of IDs" });
  }

  // 1) Delete existing
  db.query(
    "DELETE FROM project_activities WHERE project_id = ?",
    [projectId],
    (err) => {
      if (err) {
        console.error("Error deleting old project_activities:", err);
        return res
          .status(500)
          .json({ message: "Failed to reset project activities" });
      }

      if (activityIds.length === 0) {
        return res.json({
          success: true,
          message: "All activities cleared for project",
        });
      }

      const values = activityIds.map((id) => [projectId, id, 1]);
      const insertSql =
        "INSERT INTO project_activities (project_id, activity_id, is_active) VALUES ?";

      db.query(insertSql, [values], (err2) => {
        if (err2) {
          console.error("Error inserting new project_activities:", err2);
          return res
            .status(500)
            .json({ message: "Failed to assign activities to project" });
        }

        res.json({
          success: true,
          message: "Activities assigned to project",
        });
      });
    }
  );
});

module.exports = router;
