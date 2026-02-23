const express = require("express");
const db = require("../db");

const router = express.Router();

/**
 * POST /api/utilities/assign-user-project
 * Body: { user_id, project_id, make_primary?: boolean }
 *
 * Link user <-> project in user_projects.
 * We no longer touch columns on users (since you dropped project_* there).
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

      return res.json({
        success: true,
        message: "Project assigned to user",
      });
    }
  );
});

/**
 * GET /api/utilities/user-projects/:userId
 * All projects linked to a user (primary first)
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
 * GET /api/utilities/project-roads/:projectId
 * Roads already packaged into a given project (via contracts + contract_roads)
 */
router.get("/project-roads/:projectId", (req, res) => {
  const projectId = req.params.projectId;

  const sql = `
    SELECT 
      r.id,
      r.road_code,
      r.road_name,
      r.town
    FROM contracts c
    JOIN contract_roads cr ON cr.contract_id = c.id
    JOIN roads r          ON r.id = cr.road_id
    WHERE c.project_id = ?
    ORDER BY r.town ASC, r.road_code ASC
  `;

  db.query(sql, [projectId], (err, rows) => {
    if (err) {
      console.error("Error loading project roads:", err);
      return res
        .status(500)
        .json({ message: "Failed to load roads for project" });
    }
    res.json(rows);
  });
});

/**
 * POST /api/utilities/package-roads
 * Body: { project_id: number, road_codes: string[], reset?: boolean }
 *
 * Calls your stored procedure package_roads_to_contract()
 * so you can re-use it every financial year.
 */
router.post("/package-roads", (req, res) => {
  const { project_id, road_codes, reset } = req.body;

  if (!project_id || !Array.isArray(road_codes) || road_codes.length === 0) {
    return res.status(400).json({
      message: "project_id and a non-empty road_codes[] array are required",
    });
  }

  // 1) get the project_number for this project
  const projectSql = "SELECT project_number FROM projects WHERE id = ?";

  db.query(projectSql, [project_id], (err, rows) => {
    if (err) {
      console.error("Error fetching project_number:", err);
      return res
        .status(500)
        .json({ message: "Failed to find project_number for project" });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    const projectNumber = rows[0].project_number;
    const jsonRoadCodes = JSON.stringify(road_codes);

    // 2) call the stored procedure
    const callSql = "CALL package_roads_to_contract(?, ?, ?)";

    db.query(
      callSql,
      [projectNumber, jsonRoadCodes, reset ? 1 : 0],
      (err2) => {
        if (err2) {
          console.error("Error packaging roads:", err2);
          return res
            .status(500)
            .json({ message: "Failed to package roads to project" });
        }

        return res.json({
          success: true,
          message: "Roads packaged to project successfully",
        });
      }
    );
  });
});

/**
 * GET /api/utilities/road-activities/:roadId
 * All activities mapped to a specific road
 */
router.get("/road-activities/:roadId", (req, res) => {
  const roadId = req.params.roadId;

  const sql = `
    SELECT 
      ra.id,
      ra.is_active,
      a.id   AS activity_id,
      a.code,
      a.name,
      a.unit
    FROM road_activities ra
    JOIN activities a ON a.id = ra.activity_id
    WHERE ra.road_id = ?
    ORDER BY a.code ASC
  `;

  db.query(sql, [roadId], (err, rows) => {
    if (err) {
      console.error("Error loading road activities:", err);
      return res
        .status(500)
        .json({ message: "Failed to load activities for road" });
    }
    res.json(rows);
  });
});

/**
 * POST /api/utilities/road-activities/:roadId
 * Body: { activityIds: number[] }
 * Replaces the list of activities for that road
 */
router.post("/road-activities/:roadId", (req, res) => {
  const roadId = req.params.roadId;
  const { activityIds } = req.body;

  if (!Array.isArray(activityIds)) {
    return res
      .status(400)
      .json({ message: "activityIds must be an array of IDs" });
  }

  // 1) delete existing mappings
  db.query("DELETE FROM road_activities WHERE road_id = ?", [roadId], (err) => {
    if (err) {
      console.error("Error deleting old road_activities:", err);
      return res
        .status(500)
        .json({ message: "Failed to reset activities for road" });
    }

    if (activityIds.length === 0) {
      return res.json({
        success: true,
        message: "All activities cleared for road",
      });
    }

    const values = activityIds.map((id) => [roadId, id, 1]);
    const insertSql =
      "INSERT INTO road_activities (road_id, activity_id, is_active) VALUES ?";

    db.query(insertSql, [values], (err2) => {
      if (err2) {
        console.error("Error inserting new road_activities:", err2);
        return res
          .status(500)
          .json({ message: "Failed to assign activities to road" });
      }

      res.json({
        success: true,
        message: "Activities assigned to road",
      });
    });
  });
});

module.exports = router;
