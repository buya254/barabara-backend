const express = require("express");
const db = require("../db");

const router = express.Router();

function extractFYKey(raw) {
  const original = String(raw || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();

  if (!original) return null;

  const s = original.replace(/-/g, "/");

  // 1. Best match: FY2025/26 or FY2025-26
  let m = s.match(/FY(20\d{2})\/(\d{2})/);
  if (m) {
    return `${m[1].slice(-2)}/${m[2]}`;
  }

  // 2. Normal financial year: 2025/26 or 2025-26
  m = s.match(/(20\d{2})\/(\d{2})(?!\d)/);
  if (m) {
    return `${m[1].slice(-2)}/${m[2]}`;
  }

  // 3. Full year range: 2025/2026 or 2025-2026
  m = s.match(/(20\d{2})\/(20\d{2})/);
  if (m) {
    return `${m[1].slice(-2)}/${m[2].slice(-2)}`;
  }

  return null;
}

function extractFYEnd(raw) {
  const key = extractFYKey(raw);
  if (!key) return null;
  return key.split("/")[1] || null; // "27"
}

function toStoredFinancialYear(fyKey) {
  if (!fyKey) return null;
  const [startYY, endYY] = fyKey.split("/");
  return `20${startYY}/${endYY}`; // "2025/26"
}

function parseBoolean(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}
function normalizeRole(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/_/g, "")
    .replace(/\s+/g, "");
}

function workflowColumnForRole(roleRaw) {
  const role = normalizeRole(roleRaw);

  if (role === "siteagent") return "siteagent_id";
  if (role === "inspector") return "inspector_id";
  if (role === "are") return "are_id";
  if (role === "re") return "re_id";

  return null;
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
 * GET /api/utilities/assignment-projects?user_id=123&financial_year=2025/26
 *
 * Option A strict ARWP-linked projects:
 * Returns only projects already linked through annual_workplan_project_lots.
 *
 * Financial year rule:
 * We compare by FY ending, e.g. 26, not exact text.
 */
router.get("/assignment-projects", async (req, res) => {
  try {
    console.log("HIT GET /api/utilities/assignment-projects", req.query);

    const userId = Number(req.query.user_id);
    const fyRaw = req.query.financial_year;

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: "Valid user_id is required" });
    }

    const selectedFYKey = extractFYKey(fyRaw);
    const selectedFYEnd = extractFYEnd(fyRaw);

    if (!selectedFYKey || !selectedFYEnd) {
      return res.status(400).json({
        message: "Valid financial_year is required, for example 2025/26",
      });
    }

    const storedFY = toStoredFinancialYear(selectedFYKey);

    const [userRows] = await db.query(
      `
      SELECT 
        id,
        username,
        full_name,
        role,
        region,
        financial_year
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId]
    );

    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const selectedUser = userRows[0];

    if (!selectedUser.region) {
      return res.status(400).json({
        message: "Selected user has no region set in the users table",
      });
    }

    const userFYEnd = extractFYEnd(selectedUser.financial_year);

    if (userFYEnd !== selectedFYEnd) {
      return res.status(409).json({
        message: `Selected user belongs to FY ending ${userFYEnd || "unknown"}, not FY ending ${selectedFYEnd}`,
        userFinancialYear: selectedUser.financial_year,
        selectedFinancialYear: storedFY,
      });
    }

    const [rows] = await db.query(
      `
      SELECT DISTINCT
        p.id,
        p.project_number,
        p.project_name,
        p.region,
        p.financial_year,

        aw.id AS workplan_id,
        aw.financial_year AS workplan_financial_year,
        aw.region AS workplan_region,

        awpl.lot_no,
        awpl.category

      FROM annual_workplans aw
      INNER JOIN annual_workplan_project_lots awpl
        ON awpl.workplan_id = aw.id
      INNER JOIN projects p
        ON p.id = awpl.project_id

      WHERE LOWER(TRIM(aw.region)) = LOWER(TRIM(?))

      ORDER BY
        p.project_number ASC,
        p.project_name ASC
      `,
      [selectedUser.region]
    );

    const filteredProjects = (rows || []).filter((project) => {
      const arwpFYEnd = extractFYEnd(project.workplan_financial_year);
      return arwpFYEnd === selectedFYEnd;
    });

    console.log("ASSIGNMENT PROJECTS DEBUG:", {
      selectedUser: selectedUser.username,
      selectedRegion: selectedUser.region,
      selectedFYEnd,
      rawCount: rows.length,
      filteredCount: filteredProjects.length,
      rawProjects: rows.map((p) => ({
        id: p.id,
        project_number: p.project_number,
        project_name: p.project_name,
        project_fy: p.financial_year,
        arwp_fy: p.workplan_financial_year,
        arwp_region: p.workplan_region,
      })),
    });

    return res.json({
      success: true,
      user: {
        id: selectedUser.id,
        username: selectedUser.username,
        full_name: selectedUser.full_name,
        role: selectedUser.role,
        region: selectedUser.region,
        financial_year: selectedUser.financial_year,
      },
      financial_year: storedFY,
      financial_year_end: selectedFYEnd,
      region: selectedUser.region,
      projects: filteredProjects,
    });
  } catch (err) {
    console.error("Error loading assignment projects:", err);
    return res.status(500).json({
      message: "Failed to load ARWP-linked projects for assignment",
    });
  }
});

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
      "SELECT id, username, full_name, role, financial_year FROM users WHERE id = ? LIMIT 1",
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
          "Project FY is missing/invalid. Ensure project_number or financial_year contains FY2025/26 or 2025-2026 etc.",
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
    const workflowColumn = workflowColumnForRole(user.role);

if (workflowColumn) {
  const [workflowRows] = await db.query(
    "SELECT project_id FROM project_workflow_assignments WHERE project_id = ? LIMIT 1",
    [projectId]
  );

  if (workflowRows.length > 0) {
    await db.query(
      `UPDATE project_workflow_assignments
       SET ${workflowColumn} = ?
       WHERE project_id = ?`,
      [userId, projectId]
    );
  } else {
    await db.query(
      `INSERT INTO project_workflow_assignments
       (project_id, ${workflowColumn})
       VALUES (?, ?)`,
      [projectId, userId]
    );
  }
}

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
router.get("/project-roads/:projectId", async (req, res) => {
  try {
    console.log("HIT GET /api/utilities/project-roads/:projectId", req.params.projectId);

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

    const [rows] = await db.query(sql, [projectId]);
    return res.json(rows || []);
  } catch (err) {
    console.error("Error loading project roads:", err);
    return res.status(500).json({ message: "Failed to load roads for project" });
  }
});

/**
 * POST /api/utilities/package-roads
 */
router.post("/package-roads", async (req, res) => {
  try {
    console.log("HIT POST /api/utilities/package-roads", req.body);

    const projectId = Number(req.body.project_id);
    const roadCodes = uniqueRoadCodes(req.body.road_codes);
    const reset = parseBoolean(req.body.reset);

    if (!Number.isInteger(projectId) || roadCodes.length === 0) {
      return res.status(400).json({
        message: "project_id and a non-empty road_codes[] array are required",
      });
    }

    const [projectRows] = await db.query(
      "SELECT project_number FROM projects WHERE id = ?",
      [projectId]
    );

    if (!projectRows || projectRows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    // ✅ Validate against roads table first
    const placeholders = roadCodes.map(() => "?").join(", ");
    const [validRows] = await db.query(
      `
      SELECT UPPER(TRIM(road_code)) AS road_code
      FROM roads
      WHERE UPPER(TRIM(road_code)) IN (${placeholders})
      `,
      roadCodes
    );

    const validSet = new Set(
      (validRows || []).map((r) => String(r.road_code || "").toUpperCase())
    );

    const invalidRoadCodes = roadCodes.filter((code) => !validSet.has(code));

    if (invalidRoadCodes.length > 0) {
      return res.status(400).json({
        message: `These road codes do not exist in the roads table: ${invalidRoadCodes.join(", ")}`,
        invalidRoadCodes,
      });
    }

    const projectNumber = projectRows[0].project_number;
    const jsonRoadCodes = JSON.stringify(roadCodes);

    await db.query(
      "CALL package_roads_to_contract(?, ?, ?)",
      [projectNumber, jsonRoadCodes, reset ? 1 : 0]
    );

    return res.json({
      success: true,
      message: "Roads packaged to project successfully",
      roadCodes,
    });
  } catch (err) {
    console.error("Error packaging roads:", err);
    return res.status(500).json({ message: "Failed to package roads to project" });
  }
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