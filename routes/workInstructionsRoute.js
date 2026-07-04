const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

function normalizeRole(role) {
  return String(role || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/_/g, "")
    .replace(/\s+/g, "");
}

function makeTempInstructionNumber() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);

  return `BBR-SI-${stamp}`;
}

async function userHasProjectAccess(userId, projectId) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM user_projects
    WHERE user_id = ?
      AND project_id = ?
    LIMIT 1
    `,
    [userId, projectId]
  );

  return rows.length > 0;
}

async function getWorkflowAssignment(projectId) {
  const [rows] = await db.query(
    `
    SELECT *
    FROM project_workflow_assignments
    WHERE project_id = ?
    LIMIT 1
    `,
    [projectId]
  );

  return rows[0] || null;
}

function isWorkflowUser(user, assignment) {
  if (!assignment) return false;

  const uid = String(user?.id || "");

  return (
    String(assignment.siteagent_id || "") === uid ||
    String(assignment.inspector_id || "") === uid ||
    String(assignment.are_id || "") === uid ||
    String(assignment.re_id || "") === uid
  );
}

async function canViewProjectInstructions(user, projectId) {
  const role = normalizeRole(user?.role);

  if (role === "admin") return true;

  const hasAccess = await userHasProjectAccess(user.id, projectId);
  if (hasAccess) return true;

  const assignment = await getWorkflowAssignment(projectId);
  return isWorkflowUser(user, assignment);
}

async function canCreateProjectInstruction(user, projectId) {
  const role = normalizeRole(user?.role);

  if (role === "admin") return true;
  if (role !== "re") return false;

  const hasAccess = await userHasProjectAccess(user.id, projectId);
  if (hasAccess) return true;

  const assignment = await getWorkflowAssignment(projectId);
  return String(assignment?.re_id || "") === String(user.id);
}

async function getProject(projectId) {
  const [rows] = await db.query(
    `
    SELECT
      id,
      project_number,
      project_name,
      name,
      region,
      contractor,
      financial_year
    FROM projects
    WHERE id = ?
    LIMIT 1
    `,
    [projectId]
  );

  return rows[0] || null;
}

// GET /api/work-instructions/project/:projectId
router.get("/project/:projectId", authenticateJWT, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Invalid project id." });
    }

    const allowed = await canViewProjectInstructions(req.user, projectId);

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to view site instructions for this project.",
      });
    }

    const [rows] = await db.query(
      `
      SELECT
        wi.*,
        p.project_number,
        p.project_name,
        p.name AS project_name_alt,
        p.contractor AS project_contractor,
        p.region AS project_region,
        issued.username AS issued_by_username,
        issued.full_name AS issued_by_name,
        issued_to.username AS issued_to_username,
        issued_to.full_name AS issued_to_name
      FROM work_instructions wi
      LEFT JOIN projects p
        ON p.id = wi.project_id
      LEFT JOIN users issued
        ON issued.id = wi.issued_by
      LEFT JOIN users issued_to
        ON issued_to.id = wi.issued_to_user_id
      WHERE wi.project_id = ?
      ORDER BY
        wi.instruction_date DESC,
        wi.instruction_number DESC,
        wi.id ASC
      `,
      [projectId]
    );

    return res.json({
      success: true,
      instructions: rows,
    });
  } catch (err) {
    console.error("Work instructions list error:", err);
    return res.status(500).json({ message: "Failed to load site instructions." });
  }
});

// GET /api/work-instructions/project/:projectId/usage
// Shows which work instruction lines have been used in Daily Work Reports.
router.get("/project/:projectId/usage", authenticateJWT, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Invalid project id." });
    }

    const allowed = await canViewProjectInstructions(req.user, projectId);

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to view work instruction usage for this project.",
      });
    }

    const [instructionRows] = await db.query(
      `
      SELECT
        wi.*,
        p.project_number,
        p.project_name,
        p.name AS project_name_alt,
        p.contractor AS project_contractor,
        p.region AS project_region,
        issued.username AS issued_by_username,
        issued.full_name AS issued_by_name,
        issued_to.username AS issued_to_username,
        issued_to.full_name AS issued_to_name
      FROM work_instructions wi
      LEFT JOIN projects p
        ON p.id = wi.project_id
      LEFT JOIN users issued
        ON issued.id = wi.issued_by
      LEFT JOIN users issued_to
        ON issued_to.id = wi.issued_to_user_id
      WHERE wi.project_id = ?
      ORDER BY
        wi.instruction_date DESC,
        wi.instruction_number DESC,
        wi.id ASC
      `,
      [projectId]
    );

    const [reportRows] = await db.query(
      `
      SELECT
        id,
        user_report_no,
        project_id,
        report_date,
        status,
        form_json,
        submitted_at,
        confirmed_at,
        are_approved_at,
        re_approved_at
      FROM daily_work_reports
      WHERE project_id = ?
        AND status IN ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'ARE_APPROVED', 'RE_APPROVED')
      ORDER BY report_date ASC, id ASC
      `,
      [projectId]
    );

    const usageByInstructionLineId = new Map();

    const parseFormJson = (value) => {
      if (!value) return {};

      if (typeof value === "object") return value;

      if (Buffer.isBuffer(value)) {
        try {
          return JSON.parse(value.toString("utf8"));
        } catch {
          return {};
        }
      }

      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return {};
        }
      }

      return {};
    };

    for (const report of reportRows) {
      const formJson = parseFormJson(report.form_json);
      const operationRows = Array.isArray(formJson.operationRows)
        ? formJson.operationRows
        : [];

      operationRows.forEach((operation, index) => {
        const lineId = Number(operation.workInstructionLineId);

        if (!Number.isInteger(lineId) || lineId <= 0) return;

        if (!usageByInstructionLineId.has(lineId)) {
          usageByInstructionLineId.set(lineId, []);
        }

        usageByInstructionLineId.get(lineId).push({
          report_id: report.id,
          user_report_no: report.user_report_no,
          report_date: report.report_date,
          report_status: report.status,
          operation_index: index,
          chainage_from: operation.chainageFrom || "",
          chainage_to: operation.chainageTo || "",
          activity_description: operation.activityDescription || "",
          remarks: operation.remarks || "",
          submitted_at: report.submitted_at,
          confirmed_at: report.confirmed_at,
          are_approved_at: report.are_approved_at,
          re_approved_at: report.re_approved_at,
        });
      });
    }

    const rows = instructionRows.map((instruction) => {
      const usage = usageByInstructionLineId.get(Number(instruction.id)) || [];

      let usageStatus = "DUE_FOR_EXECUTION";

      if (usage.some((u) => u.report_status === "RE_APPROVED")) {
        usageStatus = "USED_IN_RE_APPROVED_REPORT";
      } else if (usage.some((u) => u.report_status === "ARE_APPROVED")) {
        usageStatus = "USED_IN_ARE_APPROVED_REPORT";
      } else if (usage.some((u) => u.report_status === "CONFIRMED")) {
        usageStatus = "USED_IN_INSPECTOR_APPROVED_REPORT";
      } else if (usage.some((u) => u.report_status === "SUBMITTED")) {
        usageStatus = "USED_IN_SUBMITTED_REPORT";
      } else if (usage.some((u) => u.report_status === "DRAFT")) {
        usageStatus = "USED_IN_DRAFT";
      }

      return {
        ...instruction,
        usage_status: usageStatus,
        usage_count: usage.length,
        usage,
      };
    });

    return res.json({
      success: true,
      instructions: rows,
    });
  } catch (err) {
    console.error("Work instruction usage error:", err);
    return res.status(500).json({
      message: "Failed to load work instruction usage.",
    });
  }
});

// GET /api/work-instructions/project/:projectId/arwp-lines
// R.E uses this to pick ARWP activity placeholders when creating a Site Instruction.
router.get("/project/:projectId/arwp-lines", authenticateJWT, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Invalid project id." });
    }

    const allowed = await canViewProjectInstructions(req.user, projectId);

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to view ARWP lines for this project.",
      });
    }

    const [rows] = await db.query(
      `
      SELECT
        p.id AS project_id,
        p.project_number,
        p.project_name,
        p.name AS project_name_alt,
        p.contractor,
        p.region,
        p.financial_year,

        bl.id AS boq_lot_id,
        bl.lot_no,
        bl.category,
        bl.locked_contract_sum,

        bql.id AS boq_line_id,
        bql.source_arwp_line_id AS workplan_line_id,

        bql.road_id,
        r.road_code,
        r.road_name,

        bql.activity_id,
        a.code AS activity_code,
        a.name AS activity_name,
        a.unit AS unit_of_measure,
        a.work_category,
        a.work_description,

        bql.category,
        bql.method,
        bql.chainage_start,
        bql.chainage_end,

        bql.quantity AS planned_quantity,
        bql.rate AS planned_rate,
        bql.amount AS planned_amount,

        COALESCE(wi_used.already_instructed_quantity, 0) AS already_instructed_quantity,

        GREATEST(
          COALESCE(bql.quantity, 0) - COALESCE(wi_used.already_instructed_quantity, 0),
          0
        ) AS pending_quantity,

        (
          GREATEST(
            COALESCE(bql.quantity, 0) - COALESCE(wi_used.already_instructed_quantity, 0),
            0
          ) * COALESCE(bql.rate, 0)
        ) AS pending_amount

      FROM boq_lots bl

      JOIN projects p
        ON p.id = bl.project_id

      JOIN boq_lines bql
        ON bql.boq_lot_id = bl.id

      JOIN roads r
        ON r.id = bql.road_id

      JOIN activities a
        ON a.id = bql.activity_id

      LEFT JOIN (
        SELECT
          boq_line_id,
          SUM(COALESCE(instructed_quantity, 0)) AS already_instructed_quantity
        FROM work_instructions
        WHERE project_id = ?
          AND boq_line_id IS NOT NULL
          AND COALESCE(status, 'draft') NOT IN ('cancelled', 'rejected', 'void')
        GROUP BY boq_line_id
      ) wi_used
        ON wi_used.boq_line_id = bql.id

      WHERE bl.project_id = ?
        AND bl.is_locked = 1
        AND bql.status = 'active'

      ORDER BY
        r.road_name ASC,
        a.code ASC,
        bql.id ASC
      `,
      [projectId, projectId]
    );

    return res.json({
      success: true,
      arwpLines: rows,
    });
  } catch (err) {
    console.error("ARWP lines for work instruction error:", err);
    return res.status(500).json({
      message: "Failed to load ARWP activity lines.",
    });
  }
});

// GET /api/work-instructions/project/:projectId/:instructionNumber
router.get("/project/:projectId/:instructionNumber", authenticateJWT, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const instructionNumber = String(req.params.instructionNumber || "").trim();

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Invalid project id." });
    }

    if (!instructionNumber) {
      return res.status(400).json({ message: "instructionNumber is required." });
    }

    const allowed = await canViewProjectInstructions(req.user, projectId);

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to view this site instruction.",
      });
    }

    const [rows] = await db.query(
      `
      SELECT
        wi.*,
        p.project_number,
        p.project_name,
        p.name AS project_name_alt,
        p.contractor AS project_contractor,
        p.region AS project_region,
        issued.username AS issued_by_username,
        issued.full_name AS issued_by_name,
        issued_to.username AS issued_to_username,
        issued_to.full_name AS issued_to_name
      FROM work_instructions wi
      LEFT JOIN projects p
        ON p.id = wi.project_id
      LEFT JOIN users issued
        ON issued.id = wi.issued_by
      LEFT JOIN users issued_to
        ON issued_to.id = wi.issued_to_user_id
      WHERE wi.project_id = ?
        AND wi.instruction_number = ?
      ORDER BY wi.id ASC
      `,
      [projectId, instructionNumber]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Site instruction not found." });
    }

    return res.json({
      success: true,
      instruction_number: instructionNumber,
      lines: rows,
    });
  } catch (err) {
    console.error("Work instruction detail error:", err);
    return res.status(500).json({ message: "Failed to load site instruction." });
  }
});

// POST /api/work-instructions
// R.E/Admin creates/imports a site instruction with one or more lines.
router.post("/", authenticateJWT, async (req, res) => {
  const conn = await db.getConnection();

  try {
    const {
      project_id,
      instruction_number,
      d365_instruction_no,
      sheet_no,
      instruction_date,
      source,
      issued_to_user_id,
      note,
      lines,
    } = req.body || {};

    const projectId = Number(project_id);

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Valid project_id is required." });
    }

    const allowed = await canCreateProjectInstruction(req.user, projectId);

    if (!allowed) {
      return res.status(403).json({
        message: "Only the assigned R.E or Admin can create site instructions.",
      });
    }

    if (!instruction_date) {
      return res.status(400).json({
        message: "instruction_date is required.",
      });
    }

    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({
        message: "At least one instructed work line is required.",
      });
    }

    const project = await getProject(projectId);

    if (!project) {
      return res.status(404).json({ message: "Project not found." });
    }

    const assignment = await getWorkflowAssignment(projectId);
    const finalIssuedToUserId =
        issued_to_user_id || assignment?.siteagent_id || null;

    const finalInstructionNumber =
      String(d365_instruction_no || instruction_number || "").trim() ||
      makeTempInstructionNumber();

    const finalSource =
      d365_instruction_no || instruction_number
        ? String(source || "D365_IMPORT").toUpperCase()
        : "BARABARA_CREATED";

    await conn.beginTransaction();

    const insertedIds = [];

    for (const line of lines) {
  const boqLineId = Number(line.boq_line_id || 0);
  const requestedQty = Number(line.instructed_quantity || line.estimated_quantity || 0);

  if (!Number.isInteger(boqLineId) || boqLineId <= 0) {
    throw new Error(
      "Work Instruction must be created from a locked BOQ line. Lock the ARWP into BOQ first."
    );
  }

  if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
    throw new Error(
      "Each selected BOQ work item must have an instructed quantity greater than zero."
    );
  }

  const [pendingRows] = await conn.query(
    `
    SELECT
      bql.id AS boq_line_id,
      bql.quantity,
      bql.rate,
      COALESCE(used.already_instructed_quantity, 0) AS already_instructed_quantity,
      GREATEST(
        COALESCE(bql.quantity, 0) - COALESCE(used.already_instructed_quantity, 0),
        0
      ) AS pending_quantity,
      r.road_code,
      a.code AS activity_code,
      a.name AS activity_name
    FROM boq_lines bql

    INNER JOIN boq_lots bl
      ON bl.id = bql.boq_lot_id

    INNER JOIN roads r
      ON r.id = bql.road_id

    INNER JOIN activities a
      ON a.id = bql.activity_id

    LEFT JOIN (
      SELECT
        boq_line_id,
        SUM(COALESCE(instructed_quantity, 0)) AS already_instructed_quantity
      FROM work_instructions
      WHERE project_id = ?
        AND boq_line_id IS NOT NULL
        AND COALESCE(status, 'draft') NOT IN ('cancelled', 'rejected', 'void')
      GROUP BY boq_line_id
    ) used
      ON used.boq_line_id = bql.id

    WHERE bql.id = ?
      AND bl.project_id = ?
      AND bl.is_locked = 1
      AND bql.status = 'active'
    LIMIT 1
    `,
    [projectId, boqLineId, projectId]
  );

  if (pendingRows.length === 0) {
    throw new Error("Selected BOQ work item was not found for this project.");
  }

  const pendingQty = Number(pendingRows[0].pending_quantity || 0);

  if (requestedQty > pendingQty) {
    throw new Error(
      `Cannot instruct ${requestedQty}. Pending quantity for ${pendingRows[0].road_code} / ${pendingRows[0].activity_code} is only ${pendingQty}.`
    );
  }

  const [result] = await conn.query(
        `
        INSERT INTO work_instructions
          (
            workplan_line_id,
            boq_line_id,
            project_id,
            project_name_snapshot,
            road_id,
            road_code_snapshot,
            road_name_snapshot,
            contract_no_snapshot,
            contractor_snapshot,
            from_role,
            to_role,
            activity_id,
            instruction_number,
            sheet_no,
            d365_instruction_no,
            source,
            instruction_date,
            instructed_quantity,
            instructed_rate,
            status,
            issued_by,
            issued_to_user_id,
            notes,
            bill_no,
            bill_item_no,
            bill_item_description,
            unit_of_measure,
            section_text,
            estimated_quantity,
            additional_instruction_notes
          )
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          line.workplan_line_id || null,
          line.boq_line_id || null,
          projectId,
          line.project_name_snapshot ||
            project.project_name ||
            project.name ||
            null,

          line.road_id || null,
          line.road_code_snapshot || line.road_code || null,
          line.road_name_snapshot || line.road_name || null,
          line.contract_no_snapshot || project.project_number || null,
          line.contractor_snapshot || project.contractor || null,

          line.from_role || "RESIDENT ENGINEER",
          line.to_role || "SITE AGENT",

          line.activity_id || null,

          finalInstructionNumber,
          sheet_no || null,
          d365_instruction_no || null,
          finalSource,

          instruction_date,
          line.instructed_quantity || line.estimated_quantity || 0,
          line.instructed_rate || 0,

          req.user.id,
          finalIssuedToUserId || line.issued_to_user_id || null,
          line.notes || note || null,

          line.bill_no || null,
          line.bill_item_no || null,
          line.bill_item_description || line.description || null,
          line.unit_of_measure || null,
          line.section_text || line.section || null,
          line.estimated_quantity || line.instructed_quantity || null,
          line.additional_instruction_notes || null,
        ]
      );

      insertedIds.push(result.insertId);
    }

    await conn.commit();

    return res.status(201).json({
      success: true,
      message: "Site instruction saved.",
      instruction_number: finalInstructionNumber,
      inserted_ids: insertedIds,
    });
  } catch (err) {
    await conn.rollback();

    console.error("Work instruction create error:", err);
    return res.status(500).json({
      message: "Failed to save site instruction.",
    });
  } finally {
    conn.release();
  }
});

module.exports = router;