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
function toFYEnd(raw) {
  return extractFYEnd(raw);
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

function normalizeProjectRole(raw) {
  const role = normalizeRole(raw);

  if (
    role === "siteagent" ||
    role === "inspector" ||
    role === "are" ||
    role === "re"
  ) {
    return role;
  }

  return null;
}

function allowedProjectRolesForAccount(accountRoleRaw) {
  const accountRole = normalizeRole(accountRoleRaw);

  if (accountRole === "siteagent") {
    return ["siteagent"];
  }

  if (accountRole === "inspector") {
    return ["inspector"];
  }

  if (
    accountRole === "are" ||
    accountRole === "re"
  ) {
    return ["are", "re"];
  }

  return [];
}

function normalizeProjectRole(raw) {
  const role = normalizeRole(raw);

  if (
    role === "siteagent" ||
    role === "inspector" ||
    role === "are" ||
    role === "re"
  ) {
    return role;
  }

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
 * GET /api/utilities/users-by-financial-year?financial_year=2025/26
 *
 * Assignment user dropdown:
 * We DO NOT filter users by users.financial_year anymore.
 * The FY is only kept in the response for display/context.
 *
 * Reason:
 * Financial year belongs to projects/ARWP, not to the user's eligibility.
 */
router.get("/users-by-financial-year", async (req, res) => {
  try {
    console.log("HIT GET /api/utilities/users-by-financial-year", req.query);

    const fyRaw = req.query.financial_year;
    const selectedFYKey = extractFYKey(fyRaw);
    const selectedFYEnd = extractFYEnd(fyRaw);
    const storedFY = selectedFYKey ? toStoredFinancialYear(selectedFYKey) : null;

    const [rows] = await db.query(
      `
      SELECT
        u.id,
        u.username,
        u.full_name,
        u.role,
        u.region,
        u.email,
        u.phone,

        u.financial_year AS primary_financial_year,
        u.financial_year,

        ? AS assignment_financial_year,
        ? AS fy_end

      FROM users u
      ORDER BY
        u.role,
        u.region,
        u.full_name,
        u.username
      `,
      [storedFY, selectedFYEnd]
    );

    return res.json({
      success: true,
      financial_year: storedFY,
      financial_year_end: selectedFYEnd,
      users: rows || [],
    });
  } catch (err) {
    console.error("Error loading assignment users:", err);

    return res.status(500).json({
      message: "Failed to load users for assignment",
      error: err.message,
      code: err.code || null,
      sqlMessage: err.sqlMessage || null,
    });
  }
});

/**
 * GET /api/utilities/assignment-projects?user_id=123&financial_year=2025/26
 *
 * Returns ARWP-linked projects for the selected FY.
 *
 * Region rule:
 * - RE can see projects across regions.
 * - Other roles only see projects matching their user region.
 *
 * Already-assigned projects are excluded for that same user.
 */

router.get("/assignment-projects", async (req, res) => {
  try {
    console.log(
      "HIT GET /api/utilities/assignment-projects",
      req.query
    );

    const userId = Number(req.query.user_id);
    const fyRaw = req.query.financial_year;
    const projectRole = normalizeProjectRole(
      req.query.project_role
    );

    if (!Number.isInteger(userId)) {
      return res.status(400).json({
        message: "Valid user_id is required",
      });
    }

    if (!projectRole) {
      return res.status(400).json({
        message:
          "A valid project_role is required: siteagent, inspector, are or re",
      });
    }

    const selectedFYKey = extractFYKey(fyRaw);
    const selectedFYEnd = extractFYEnd(fyRaw);

    if (!selectedFYKey || !selectedFYEnd) {
      return res.status(400).json({
        message:
          "Valid financial_year is required, for example 2025/26",
      });
    }

    const storedFY = toStoredFinancialYear(
      selectedFYKey
    );

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
      return res.status(404).json({
        message: "User not found",
      });
    }

    const selectedUser = userRows[0];

    /*
     * Regional authority now comes from the role being
     * assigned on this project—not users.role.
     */
    const canCrossRegions = projectRole === "re";

    if (!canCrossRegions && !selectedUser.region) {
      return res.status(400).json({
        message:
          "Selected user has no region set. Site Agent, Inspector and A.R.E assignments require a user region.",
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

      LEFT JOIN user_projects up
        ON up.project_id = p.id
        AND up.user_id = ?

      WHERE up.project_id IS NULL
        AND (
          ? = 1
          OR LOWER(
            TRIM(
              COALESCE(
                NULLIF(p.region, ''),
                aw.region
              )
            )
          ) = LOWER(TRIM(?))
        )

      ORDER BY
        p.project_number ASC,
        p.project_name ASC
      `,
      [
        userId,
        canCrossRegions ? 1 : 0,
        selectedUser.region || "",
      ]
    );

    const filteredProjects = (rows || []).filter(
      (project) => {
        const arwpFYEnd = extractFYEnd(
          project.workplan_financial_year
        );

        return arwpFYEnd === selectedFYEnd;
      }
    );

    return res.json({
      success: true,

      user: {
        id: selectedUser.id,
        username: selectedUser.username,
        full_name: selectedUser.full_name,
        account_role: selectedUser.role,
        region: selectedUser.region,
        financial_year:
          selectedUser.financial_year,
      },

      selected_project_role: projectRole,
      financial_year: storedFY,
      financial_year_end: selectedFYEnd,

      region_rule_applied: canCrossRegions
        ? "R.E project role may be assigned across regions"
        : selectedUser.region,

      projects: filteredProjects,
    });
  } catch (err) {
    console.error(
      "Error loading assignment projects:",
      err
    );

    return res.status(500).json({
      message:
        "Failed to load ARWP-linked projects for assignment",
      error: err.message,
      code: err.code || null,
      sqlMessage: err.sqlMessage || null,
    });
  }
});

/**
 * POST /api/utilities/assign-user-project
 *
 * Assignment rule:
 * - Do not enforce users.financial_year.
 * - Do not update users.financial_year.
 * - Non-RE users must match the project region.
 * - RE can be assigned across regions.
 */
router.post("/assign-user-project", async (req, res) => {
  try {
    console.log(
      "HIT POST /api/utilities/assign-user-project",
      req.body
    );

    const userId = Number(req.body.user_id);
    const projectId = Number(req.body.project_id);

    const projectRole = normalizeProjectRole(
      req.body.project_role
    );

    const makePrimary = parseBoolean(
      req.body.make_primary
    );

    if (
      !Number.isInteger(userId) ||
      !Number.isInteger(projectId)
    ) {
      return res.status(400).json({
        message:
          "Valid user_id and project_id are required",
      });
    }

    if (!projectRole) {
      return res.status(400).json({
        message:
          "Select a valid role for this project: Site Agent, Inspector, A.R.E or R.E",
      });
    }

    const workflowColumn =
      workflowColumnForRole(projectRole);

    if (!workflowColumn) {
      return res.status(400).json({
        message: "Unsupported project workflow role",
      });
    }

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
      return res.status(404).json({
        message: "User not found",
      });
    }

    const user = userRows[0];

    const normalizedAccountRole = normalizeRole(
      user.role
    );

    if (
      normalizedAccountRole === "admin" ||
      normalizedAccountRole === "systemadmin" ||
      normalizedAccountRole ===
        "systemadministrator"
    ) {
      return res.status(403).json({
        message:
          "Admin users cannot be assigned workflow roles on projects.",
      });
    }

    const [projectRows] = await db.query(
      `
      SELECT
        id,
        project_number,
        project_name,
        region,
        financial_year
      FROM projects
      WHERE id = ?
      LIMIT 1
      `,
      [projectId]
    );

    if (
      !projectRows ||
      projectRows.length === 0
    ) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    const project = projectRows[0];

    /*
     * Regional rule is now based on the role selected
     * for this particular project.
     */
    const canCrossRegions = projectRole === "re";

    const userRegion = String(
      user.region || ""
    )
      .trim()
      .toLowerCase();

    const projectRegion = String(
      project.region || ""
    )
      .trim()
      .toLowerCase();

    if (!canCrossRegions) {
      if (!userRegion) {
        return res.status(400).json({
          message:
            "Selected user has no region set. This project role requires a user region.",
        });
      }

      if (!projectRegion) {
        return res.status(400).json({
          message:
            "Selected project has no region set. Cannot enforce the regional assignment rule.",
        });
      }

      if (userRegion !== projectRegion) {
        return res.status(409).json({
          message:
            `${user.full_name || user.username} is in ` +
            `${user.region}, while this project is in ` +
            `${project.region}. Only an R.E project role ` +
            `may be assigned across regions.`,

          userRegion: user.region,
          projectRegion: project.region,
          projectRole,
        });
      }
    }

    const projectFYKey =
      extractFYKey(project.project_number) ||
      extractFYKey(project.financial_year);

    const storedProjectFY = projectFYKey
      ? toStoredFinancialYear(projectFYKey)
      : project.financial_year || null;

    if (makePrimary) {
      await db.query(
        `
        UPDATE user_projects
        SET is_primary = 0
        WHERE user_id = ?
        `,
        [userId]
      );
    }

    /*
     * user_projects grants access to the project.
     */
    await db.query(
      `
      INSERT INTO user_projects (
        user_id,
        project_id,
        is_primary
      )
      VALUES (?, ?, ?)

      ON DUPLICATE KEY UPDATE
        is_primary = VALUES(is_primary)
      `,
      [
        userId,
        projectId,
        makePrimary ? 1 : 0,
      ]
    );

    /*
     * Ensure the workflow row exists first.
     */
    await db.query(
      `
      INSERT INTO project_workflow_assignments (
        project_id
      )
      VALUES (?)

      ON DUPLICATE KEY UPDATE
        project_id = VALUES(project_id)
      `,
      [projectId]
    );

    /*
     * A user may have only one workflow role within
     * this same project.
     *
     * This removes them from any former slot on this
     * project before assigning the newly selected role.
     */
    await db.query(
      `
      UPDATE project_workflow_assignments
      SET
        siteagent_id =
          CASE
            WHEN siteagent_id = ? THEN NULL
            ELSE siteagent_id
          END,

        inspector_id =
          CASE
            WHEN inspector_id = ? THEN NULL
            ELSE inspector_id
          END,

        are_id =
          CASE
            WHEN are_id = ? THEN NULL
            ELSE are_id
          END,

        re_id =
          CASE
            WHEN re_id = ? THEN NULL
            ELSE re_id
          END

      WHERE project_id = ?
      `,
      [
        userId,
        userId,
        userId,
        userId,
        projectId,
      ]
    );

    /*
     * Assign the user into the selected role slot.
     *
     * workflowColumn is safe because it can only come
     * from workflowColumnForRole().
     */
    await db.query(
      `
      UPDATE project_workflow_assignments
      SET ${workflowColumn} = ?
      WHERE project_id = ?
      `,
      [userId, projectId]
    );

    return res.json({
      success: true,

      message:
        `Project assigned successfully as ${projectRole.toUpperCase()}.`,

      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        account_role: user.role,
        region: user.region,
        primary_financial_year:
          user.financial_year,
      },

      project: {
        id: project.id,
        project_number:
          project.project_number,
        project_name:
          project.project_name,
        region: project.region,
        financial_year:
          project.financial_year,
        normalized_financial_year:
          storedProjectFY,
      },

      project_role: projectRole,

      regionRule: canCrossRegions
        ? "R.E cross-region assignment allowed"
        : "Region matched",
    });
  } catch (err) {
    console.error(
      "Error assigning project to user:",
      err
    );

    return res.status(500).json({
      message:
        "Failed to assign project to user",
      error: err.message,
      code: err.code || null,
      sqlMessage: err.sqlMessage || null,
    });
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
              p.financial_year,

              CASE
                WHEN pwa.siteagent_id = up.user_id
                  THEN 'siteagent'

                WHEN pwa.inspector_id = up.user_id
                  THEN 'inspector'

                WHEN pwa.are_id = up.user_id
                  THEN 'are'

                WHEN pwa.re_id = up.user_id
                  THEN 're'

                ELSE NULL
              END AS project_role

            FROM user_projects up

            JOIN projects p
              ON p.id = up.project_id

            LEFT JOIN project_workflow_assignments pwa
              ON pwa.project_id = p.id

            WHERE up.user_id = ?

            ORDER BY
              up.is_primary DESC,
              p.project_number ASC
          `;

    const [rows] = await db.query(sql, [userId]);
    return res.json(rows || []);
  } catch (err) {
    console.error("Error getting user projects:", err);
    return res.status(500).json({ message: "Failed to load user projects" });
  }
});
/**
 * POST /api/utilities/unassign-user-projects
 *
 * Removes one or more projects from a user.
 * Also clears the matching workflow role column if that same user is assigned there.
 */
router.post("/unassign-user-projects", async (req, res) => {
  try {
    console.log("HIT POST /api/utilities/unassign-user-projects", req.body);

    const userId = Number(req.body.user_id);
    const projectIds = uniquePositiveIntegers(req.body.project_ids);

    if (!Number.isInteger(userId) || projectIds.length === 0) {
      return res.status(400).json({
        message: "Valid user_id and non-empty project_ids[] are required",
      });
    }

    const [userRows] = await db.query(
      `
      SELECT id, username, full_name, role
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId]
    );

    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userRows[0];
    

    const placeholders = projectIds.map(() => "?").join(", ");

    // 1. Remove from user_projects
    const [deletedUserProjects] = await db.query(
      `
      DELETE FROM user_projects
      WHERE user_id = ?
        AND project_id IN (${placeholders})
      `,
      [userId, ...projectIds]
    );

    let workflowRowsCleared = 0;

/*
 * Clear this user from whichever role they occupy
 * on each selected project.
 */
const [workflowResult] = await db.query(
  `
  UPDATE project_workflow_assignments
  SET
    siteagent_id =
      CASE
        WHEN siteagent_id = ? THEN NULL
        ELSE siteagent_id
      END,

    inspector_id =
      CASE
        WHEN inspector_id = ? THEN NULL
        ELSE inspector_id
      END,

    are_id =
      CASE
        WHEN are_id = ? THEN NULL
        ELSE are_id
      END,

    re_id =
      CASE
        WHEN re_id = ? THEN NULL
        ELSE re_id
      END

  WHERE project_id IN (${placeholders})
  `,
  [
    userId,
    userId,
    userId,
    userId,
    ...projectIds,
  ]
);

workflowRowsCleared =
  workflowResult.affectedRows || 0;

    return res.json({
      success: true,
      message: "Selected project assignment(s) removed.",
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
      },
      project_ids: projectIds,
      deleted_user_project_rows: deletedUserProjects.affectedRows || 0,
      workflow_rows_cleared: workflowRowsCleared,
    });
  } catch (err) {
    console.error("Error unassigning user projects:", err);

    return res.status(500).json({
      message: "Failed to unassign selected projects",
      error: err.message,
      code: err.code || null,
      sqlMessage: err.sqlMessage || null,
    });
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
 *
 * Keeps users.financial_year for Manage Users,
 * but also activates the user in user_financial_years for assignment filtering.
 */
router.post("/set-user-financial-year", async (req, res) => {
  try {
    const userId = Number(req.body.user_id);
    const fyRaw = req.body.financial_year;

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: "Valid user_id is required" });
    }

    const fyKey = extractFYKey(fyRaw);
    const fyEnd = extractFYEnd(fyRaw);

    if (!fyKey || !fyEnd) {
      return res.status(400).json({
        message: "Invalid financial_year. Use something like 2027/28 or FY2027/28.",
      });
    }

    const storedFY = toStoredFinancialYear(fyKey);

    await db.query(
      "UPDATE users SET financial_year = ? WHERE id = ?",
      [storedFY, userId]
    );

    await db.query(
      `
      INSERT INTO user_financial_years (
        user_id,
        financial_year,
        fy_end,
        is_active
      )
      VALUES (?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        fy_end = VALUES(fy_end),
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP
      `,
      [userId, storedFY, fyEnd]
    );

    return res.json({
      success: true,
      message: `User financial year set to ${storedFY}`,
      financial_year: storedFY,
      fy_end: fyEnd,
    });
  } catch (err) {
    console.error("Error updating user financial year:", err);

    return res.status(500).json({
      message: "Failed to update user FY",
      error: err.message,
      code: err.code || null,
      sqlMessage: err.sqlMessage || null,
    });
  }
});

// ✅ GET /api/utilities/activities
// Works even if your table columns differ (unit missing, etc.)
// ✅ GET /api/utilities/activities
// Loads all available road-work activities for Utilities.
router.get("/activities", async (req, res) => {
  try {
    const [tables] = await db.query("SHOW TABLES LIKE 'activities'");

    if (!tables || tables.length === 0) {
      return res.status(500).json({
        message:
          "Table `activities` not found. Confirm the real table name in your DB.",
      });
    }

    const [cols] = await db.query("SHOW COLUMNS FROM activities");

    const fields = (cols || []).map((c) =>
      String(c.Field || "").toLowerCase()
    );

    const has = (name) => fields.includes(String(name).toLowerCase());

    const pick = (options) => options.find((o) => has(o)) || null;

    const idCol = pick(["id", "activity_id"]);
    const codeCol = pick(["code", "activity_code", "act_code"]);
    const nameCol = pick(["name", "activity_name", "act_name", "description"]);
    const unitCol = pick(["unit", "uom", "unit_of_measure"]);

    if (!idCol || !codeCol || !nameCol) {
      return res.status(500).json({
        message: "Activities table columns not recognized. Need id + code + name.",
        found_columns: fields,
      });
    }

    const sql = `
      SELECT
        ${idCol} AS id,
        ${codeCol} AS code,
        ${nameCol} AS name,
        ${unitCol ? unitCol : "NULL"} AS unit
      FROM activities
      ORDER BY ${codeCol} ASC
    `;

    const [rows] = await db.query(sql);

    return res.json(rows || []);
  } catch (err) {
    console.error("Activities route error:", err);

    return res.status(500).json({
      message: "Failed to load activities",
      error: err.message,
      code: err.code || null,
      sqlMessage: err.sqlMessage || null,
    });
  }
});

module.exports = router;