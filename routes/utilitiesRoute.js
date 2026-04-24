const express = require("express");
const db = require("../db");

const router = express.Router();

function extractFYKey(raw) {
  const s = String(raw || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "/");

  const m = s.match(/(?:FY)?(?:20)?(\d{2})\/(?:20)?(\d{2})/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`; // "26/27"
}

function extractFYEnd(raw) {
  const key = extractFYKey(raw);
  if (!key) return null;
  return key.split("/")[1] || null; // "27"
}

function toStoredFinancialYear(fyKey) {
  if (!fyKey) return null;
  const [startYY, endYY] = fyKey.split("/");
  return `20${startYY}/${endYY}`; // "2026/27"
}

function parseBoolean(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function uniqueRoadCodes(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((v) => String(v || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
}

function uniquePositiveIntegers(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0)
    ),
  ];
}

/**
 * POST /api/utilities/assign-user-project
 */
router.post("/assign-user-project", async (req, res) => {
  try {
    console.log("HIT POST /api/utilities/assign-user-project", req.body);

    const userId = Number(req.body.user_id);
    const projectId = Number(req.body.project_id);
    const makePrimary = parseBoolean(req.body.make_primary);
    const confirmMismatch = parseBoolean(req.body.confirm_mismatch);

    if (!Number.isInteger(userId) || !Number.isInteger(projectId)) {
      return res
        .status(400)
        .json({ message: "Valid user_id and project_id are required" });
    }

    const [userRows] = await db.query(
      "SELECT id, username, full_name, financial_year FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userRows[0];
    const userFYKey = extractFYKey(user.financial_year);
    const userFYEnd = extractFYEnd(user.financial_year);

    const [projectRows] = await db.query(
      "SELECT id, project_number, project_name, financial_year FROM projects WHERE id = ? LIMIT 1",
      [projectId]
    );

    if (!projectRows || projectRows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    const project = projectRows[0];
    const projectFYKey =
      extractFYKey(project.project_number) ||
      extractFYKey(project.financial_year);

    if (!projectFYKey) {
      return res.status(400).json({
        message:
          "Project FY is missing/invalid. Ensure project_number or financial_year contains FY2026/27 or 2026-2027 etc.",
      });
    }

    const storedProjectFY = toStoredFinancialYear(projectFYKey);
    const projectFYEnd =
      extractFYEnd(project.project_number) || extractFYEnd(project.financial_year);

    const mismatch = !!userFYEnd && userFYEnd !== projectFYEnd;

    if (mismatch && !confirmMismatch) {
      return res.status(409).json({
        require_confirmation: true,
        message: `FY mismatch: user is ${userFYKey || "unset"} but project is ${projectFYKey}. Click OK to assign anyway and update the user to ${storedProjectFY}.`,
        userFY: userFYKey,
        projectFY: projectFYKey,
        newUserFinancialYear: storedProjectFY,
      });
    }

    if (makePrimary) {
      await db.query(
        "UPDATE user_projects SET is_primary = 0 WHERE user_id = ?",
        [userId]
      );
    }

    await db.query(
      `
      INSERT INTO user_projects (user_id, project_id, is_primary)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary)
      `,
      [userId, projectId, makePrimary ? 1 : 0]
    );

    if (storedProjectFY && user.financial_year !== storedProjectFY) {
      await db.query(
        "UPDATE users SET financial_year = ? WHERE id = ?",
        [storedProjectFY, userId]
      );
    }

    return res.json({
      success: true,
      message: mismatch
        ? "Project assigned. User financial year updated to match the project."
        : "Project assigned to user.",
      userFYBefore: userFYKey,
      projectFY: projectFYKey,
      userFinancialYear: storedProjectFY,
      mismatchOverridden: mismatch,
    });
  } catch (err) {
    console.error("Error assigning project to user:", err);
    return res.status(500).json({ message: "Failed to assign project to user" });
  }
});

/**
 * GET /api/utilities/user-projects/:userId
 */
router.get("/user-projects/:userId", async (req, res) => {
  try {
    console.log("HIT GET /api/utilities/user-projects/:userId", req.params.userId);

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

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

    const [rows] = await db.query(sql, [userId]);
    return res.json(rows || []);
  } catch (err) {
    console.error("Error getting user projects:", err);
    return res.status(500).json({ message: "Failed to load user projects" });
  }
});

/**
 * GET /api/utilities/project-roads/:projectId
 */
router.get("/project-roads/:projectId", (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ message: "Invalid project ID" });
  }

  const sql = `
    SELECT 
      r.id,
      r.road_code,
      r.road_name,
      r.town
    FROM contracts c
    JOIN contract_roads cr ON cr.contract_id = c.id
    JOIN roads r ON r.id = cr.road_id
    WHERE c.project_id = ?
    ORDER BY r.town ASC, r.road_code ASC
  `;

  db.query(sql, [projectId], (err, rows) => {
    if (err) {
      console.error("Error loading project roads:", err);
      return res.status(500).json({ message: "Failed to load roads for project" });
    }
    res.json(rows || []);
  });
});

/**
 * POST /api/utilities/package-roads
 */
router.post("/package-roads", (req, res) => {
  const projectId = Number(req.body.project_id);
  const roadCodes = uniqueRoadCodes(req.body.road_codes);
  const reset = parseBoolean(req.body.reset);

  if (!Number.isInteger(projectId) || roadCodes.length === 0) {
    return res.status(400).json({
      message: "project_id and a non-empty road_codes[] array are required",
    });
  }

  db.query("SELECT project_number FROM projects WHERE id = ?", [projectId], (err, rows) => {
    if (err) {
      console.error("Error fetching project_number:", err);
      return res.status(500).json({ message: "Failed to find project_number for project" });
    }
    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    const projectNumber = rows[0].project_number;
    const jsonRoadCodes = JSON.stringify(roadCodes);

    db.query("CALL package_roads_to_contract(?, ?, ?)", [projectNumber, jsonRoadCodes, reset ? 1 : 0], (err2) => {
      if (err2) {
        console.error("Error packaging roads:", err2);
        return res.status(500).json({ message: "Failed to package roads to project" });
      }
      return res.json({ success: true, message: "Roads packaged to project successfully", roadCodes });
    });
  });
});

/**
 * GET /api/utilities/road-activities/:roadId
 */
router.get("/road-activities/:roadId", (req, res) => {
  const roadId = Number(req.params.roadId);
  if (!Number.isInteger(roadId)) {
    return res.status(400).json({ message: "Invalid road ID" });
  }

  const sql1 = `
    SELECT 
      ra.id,
      ra.is_active,
      a.id AS activity_id,
      a.code,
      a.name,
      a.unit
    FROM road_activities ra
    JOIN activities a ON a.id = ra.activity_id
    WHERE ra.road_id = ?
    ORDER BY a.code ASC
  `;

  db.query(sql1, [roadId], (err, rows) => {
    if (!err) return res.json(rows || []);

    const isMissingUnit =
      err.code === "ER_BAD_FIELD_ERROR" &&
      String(err.sqlMessage || "").toLowerCase().includes("unit");

    if (isMissingUnit) {
      const sql2 = `
        SELECT 
          ra.id,
          ra.is_active,
          a.id AS activity_id,
          a.code,
          a.name,
          NULL AS unit
        FROM road_activities ra
        JOIN activities a ON a.id = ra.activity_id
        WHERE ra.road_id = ?
        ORDER BY a.code ASC
      `;
      return db.query(sql2, [roadId], (err2, rows2) => {
        if (err2) {
          console.error("Error loading road activities (fallback):", err2);
          return res.status(500).json({ message: "Failed to load activities for road" });
        }
        return res.json(rows2 || []);
      });
    }

    console.error("Error loading road activities:", err);
    return res.status(500).json({ message: "Failed to load activities for road" });
  });
});

/**
 * POST /api/utilities/road-activities/:roadId
 */
router.post("/road-activities/:roadId", (req, res) => {
  const roadId = Number(req.params.roadId);
  const activityIds = uniquePositiveIntegers(req.body.activityIds);

  if (!Number.isInteger(roadId)) {
    return res.status(400).json({ message: "Invalid road ID" });
  }

  db.query("DELETE FROM road_activities WHERE road_id = ?", [roadId], (err) => {
    if (err) {
      console.error("Error deleting old road_activities:", err);
      return res.status(500).json({ message: "Failed to reset activities for road" });
    }

    if (activityIds.length === 0) {
      return res.json({ success: true, message: "All activities cleared for road" });
    }

    const values = activityIds.map((id) => [roadId, id, 1]);
    const insertSql =
      "INSERT INTO road_activities (road_id, activity_id, is_active) VALUES ?";

    db.query(insertSql, [values], (err2) => {
      if (err2) {
        console.error("Error inserting new road_activities:", err2);
        return res.status(500).json({ message: "Failed to assign activities to road" });
      }
      return res.json({ success: true, message: "Activities assigned to road" });
    });
  });
});

/**
 * POST /api/utilities/set-user-financial-year
 */
router.post("/set-user-financial-year", (req, res) => {
  const userId = Number(req.body.user_id);
  const fyRaw = req.body.financial_year;

  if (!Number.isInteger(userId)) {
    return res.status(400).json({ message: "Valid user_id is required" });
  }

  const fyKey = extractFYKey(fyRaw);
  if (!fyKey) {
    return res.status(400).json({
      message: "Invalid financial_year. Use something like 2027/28 or FY2027/28.",
    });
  }

  const storedFY = toStoredFinancialYear(fyKey);

  db.query("UPDATE users SET financial_year = ? WHERE id = ?", [storedFY, userId], (err) => {
    if (err) {
      console.error("Error updating user financial_year:", err);
      return res.status(500).json({ message: "Failed to update user FY" });
    }
    return res.json({
      success: true,
      message: `User financial year set to ${storedFY}`,
      financial_year: storedFY,
    });
  });
});

// ✅ GET /api/utilities/activities
// Works even if your table columns differ (unit missing, etc.)
router.get("/activities", (req, res) => {
  // 1) confirm table exists
  db.query("SHOW TABLES LIKE 'activities'", (errT, tables) => {
    if (errT) {
      console.error("SHOW TABLES error:", errT);
      return res.status(500).json({ message: "Failed to check activities table" });
    }

    if (!tables || tables.length === 0) {
      return res.status(500).json({
        message:
          "Table `activities` not found. Confirm the real table name in your DB (maybe activity_list / work_activities) and update this route.",
      });
    }

    // 2) inspect columns so we pick the right ones
    db.query("SHOW COLUMNS FROM activities", (errC, cols) => {
      if (errC) {
        console.error("SHOW COLUMNS error:", errC);
        return res.status(500).json({ message: "Failed to inspect activities table" });
      }

      const fields = (cols || []).map((c) => String(c.Field || "").toLowerCase());
      const has = (name) => fields.includes(String(name).toLowerCase());
      const pick = (options) => options.find((o) => has(o)) || null;

      const idCol = pick(["id", "activity_id"]);
      const codeCol = pick(["code", "activity_code", "act_code"]);
      const nameCol = pick(["name", "activity_name", "act_name", "description"]);
      const unitCol = pick(["unit", "uom", "unit_of_measure"]);

      if (!idCol || !codeCol || !nameCol) {
        return res.status(500).json({
          message: "Activities table columns not recognized (need id + code + name).",
          found_columns: fields,
        });
      }

      const sql = `
        SELECT
          ${idCol}  AS id,
          ${codeCol} AS code,
          ${nameCol} AS name,
          ${unitCol ? unitCol : "NULL"} AS unit
        FROM activities
        ORDER BY code ASC
      `;

      db.query(sql, (errQ, rows) => {
        if (errQ) {
          console.error("Activities query error:", errQ);
          return res.status(500).json({ message: "Failed to load activities" });
        }
        return res.json(rows || []);
      });
    });
  });
});

module.exports = router;