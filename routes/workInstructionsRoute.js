const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateJWT = require("../middlewares/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

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

const workInstructionAttachmentDir = path.join(
  __dirname,
  "..",
  "uploads",
  "work-instruction-attachments"
);

fs.mkdirSync(workInstructionAttachmentDir, { recursive: true });

const ALLOWED_WORK_INSTRUCTION_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".dwg",
  ".dxf",
  ".xml",
  ".csv",
  ".dwf",
  ".txt",
  ".landxml",
]);

const ALLOWED_WORK_INSTRUCTION_ATTACHMENT_LABEL =
  "PDF, DWG, DXF, XML, CSV, DWF, TXT, or LANDXML";

const workInstructionAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, workInstructionAttachmentDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || ".pdf") || ".pdf";
    const safeName = `wi-notes-${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}${ext}`;

    cb(null, safeName);
  },
});

const uploadWorkInstructionAttachment = multer({
  storage: workInstructionAttachmentStorage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();

    if (!ALLOWED_WORK_INSTRUCTION_ATTACHMENT_EXTENSIONS.has(ext)) {
      return cb(
        new Error(
          `Only ${ALLOWED_WORK_INSTRUCTION_ATTACHMENT_LABEL} files are allowed for notes, drawings, and instruction attachments.`
        )
      );
    }

    cb(null, true);
  },
});

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

// POST /api/work-instructions/:instructionId/notes-attachment
// Uploads one combined Notes and Drawings PDF for a specific work instruction line.
router.post(
  "/:instructionId/notes-attachment",
  authenticateJWT,
  uploadWorkInstructionAttachment.single("file"),
  async (req, res) => {
    try {
      const instructionId = Number(req.params.instructionId);
      const userId = req.user?.id || req.user?.userId || null;
      const notesText = String(req.body.notes_text || "").trim();

      if (!Number.isInteger(instructionId) || instructionId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid work instruction ID.",
        });
      }

       if (!req.file) {
        return res.status(400).json({
          success: false,
          message: `Please attach a ${ALLOWED_WORK_INSTRUCTION_ATTACHMENT_LABEL} file.`,
        });
      }

      const [instructionRows] = await db.query(
        `
        SELECT
          id,
          project_id,
          instruction_number
        FROM work_instructions
        WHERE id = ?
        LIMIT 1
        `,
        [instructionId]
      );

      if (instructionRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Work instruction not found.",
        });
      }

      const instruction = instructionRows[0];

      const allowed = await canCreateProjectInstruction(
        req.user,
        Number(instruction.project_id)
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message:
            "Only the assigned R.E or Admin can attach notes and drawings.",
        });
      }

      const filePath = `/uploads/work-instruction-attachments/${req.file.filename}`;

      await db.query(
        `
        INSERT INTO work_instruction_notes_attachments
          (
            work_instruction_id,
            project_id,
            instruction_number,
            notes_text,
            original_name,
            file_name,
            file_path,
            mime_type,
            file_size_bytes,
            uploaded_by
          )
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          notes_text = VALUES(notes_text),
          original_name = VALUES(original_name),
          file_name = VALUES(file_name),
          file_path = VALUES(file_path),
          mime_type = VALUES(mime_type),
          file_size_bytes = VALUES(file_size_bytes),
          uploaded_by = VALUES(uploaded_by),
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          instruction.id,
          instruction.project_id,
          instruction.instruction_number,
          notesText || null,
          req.file.originalname,
          req.file.filename,
          filePath,
          req.file.mimetype,
          req.file.size,
          userId,
        ]
      );

      return res.json({
        success: true,
        message: "Notes, drawings, and instruction attachment saved successfully.",
        attachment: {
          work_instruction_id: instruction.id,
          project_id: instruction.project_id,
          instruction_number: instruction.instruction_number,
          notes_text: notesText || null,
          file_path: filePath,
          original_name: req.file.originalname,
        },
      });
    } catch (err) {
      console.error("❌ Work instruction attachment upload error:", err);

      return res.status(500).json({
        success: false,
        message:
          err.message ||
          "Failed to upload notes, drawings, or instruction attachment.",
      });
    }
  }
);

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
        issued_to.full_name AS issued_to_name,
        wia.id AS notes_attachment_id,
        wia.notes_text AS notes_attachment_text,
        wia.file_path AS notes_attachment_file_path,
        wia.original_name AS notes_attachment_original_name,
        wia.created_at AS notes_attachment_created_at
      FROM work_instructions wi
      LEFT JOIN projects p
        ON p.id = wi.project_id
      LEFT JOIN users issued
        ON issued.id = wi.issued_by
      LEFT JOIN users issued_to
        ON issued_to.id = wi.issued_to_user_id
      LEFT JOIN work_instruction_notes_attachments wia
        ON wia.work_instruction_id = wi.id
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

router.get("/activities/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (q.length < 2) {
      return res.json({
        success: true,
        activities: [],
      });
    }

    const like = `%${q}%`;
    const prefix = `${q}%`;

    const [rows] = await db.query(
      `
      SELECT
        id AS activity_id,
        code AS activity_code,
        name AS activity_name,
        unit AS unit_of_measure,
        work_category,
        work_description,
        0 AS planned_rate
      FROM activities
      WHERE
        code LIKE ?
        OR name LIKE ?
        OR work_description LIKE ?
      ORDER BY
        CASE
          WHEN code LIKE ? THEN 1
          WHEN name LIKE ? THEN 2
          ELSE 3
        END,
        code ASC
      LIMIT 12
      `,
      [like, like, like, prefix, prefix]
    );

    return res.json({
      success: true,
      activities: rows,
    });
  } catch (err) {
    console.error("❌ Failed to search activities:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to search activities.",
    });
  }
});

// GET /api/work-instructions/project/:projectId/arwp-lines
// R.E uses this to pick ARWP activity placeholders when creating a Site Instruction.
router.get("/project/:projectId/arwp-lines", async (req, res) => {
  const projectId = Number(req.params.projectId);
  const userId = req.user?.id || req.user?.userId || null;

  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid project ID.",
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [lockedLots] = await conn.query(
      `
      SELECT
        bl.id AS boq_lot_id,
        bl.workplan_id,
        bl.project_id,
        bl.lot_no,
        bl.category,
        bl.locked_contract_sum
      FROM boq_lots bl
      WHERE bl.project_id = ?
        AND bl.is_locked = 1
      ORDER BY bl.id ASC
      `,
      [projectId]
    );

    if (lockedLots.length === 0) {
      await conn.commit();

      return res.json({
        success: true,
        arwpLines: [],
      });
    }

    for (const lot of lockedLots) {
      await conn.query(
        `
        INSERT INTO wi_boq_lots
          (
            project_id,
            boq_lot_id,
            locked_contract_sum,
            available_amount,
            created_by,
            updated_by
          )
        VALUES
          (?, ?, ?, 0, ?, ?)
        ON DUPLICATE KEY UPDATE
          updated_by = updated_by
        `,
        [
          lot.project_id,
          lot.boq_lot_id,
          lot.locked_contract_sum || 0,
          userId,
          userId,
        ]
      );
    }

    await conn.query(
      `
      INSERT INTO wi_boq_lines
        (
          wi_boq_lot_id,
          project_id,
          boq_lot_id,
          source_boq_line_id,
          road_id,
          activity_id,
          activity_code_snapshot,
          activity_name_snapshot,
          unit_snapshot,
          section_text,
          source_quantity,
          source_rate,
          source_amount,
          adjusted_quantity,
          adjusted_rate,
          adjusted_amount,
          notes,
          line_origin,
          status,
          created_by,
          updated_by
        )
      SELECT
        wbl.id,
        bl.project_id,
        bl.id,
        bql.id,
        bql.road_id,
        bql.activity_id,
        a.code,
        a.name,
        a.unit,
        COALESCE(
          bql.wi_section_text,
          CONCAT(COALESCE(bql.chainage_start, 0), ' - ', COALESCE(bql.chainage_end, 0))
        ),
        COALESCE(bql.quantity, 0),
        COALESCE(bql.rate, 0),
        COALESCE(bql.amount, 0),
        COALESCE(bql.quantity, 0),
        COALESCE(bql.rate, 0),
        COALESCE(bql.amount, 0),
        bql.remarks,
        'LOCKED_BOQ_COPY',
        'active',
        ?,
        ?
      FROM boq_lines bql

      INNER JOIN boq_lots bl
        ON bl.id = bql.boq_lot_id

      INNER JOIN wi_boq_lots wbl
        ON wbl.project_id = bl.project_id
        AND wbl.boq_lot_id = bl.id

      INNER JOIN activities a
        ON a.id = bql.activity_id

      LEFT JOIN wi_boq_lines existing
        ON existing.project_id = bl.project_id
        AND existing.source_boq_line_id = bql.id

      WHERE bl.project_id = ?
        AND bl.is_locked = 1
        AND bql.status = 'active'
        AND existing.id IS NULL
      `,
      [userId, userId, projectId]
    );

    await conn.commit();

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

        wbl.id AS wi_boq_lot_id,
        wbl.available_amount AS wi_available_amount,
        wbl.locked_contract_sum,

        wbl.boq_lot_id,
        bl.lot_no,
        bl.category,

        wbln.id AS wi_boq_line_id,
        wbln.source_boq_line_id AS boq_line_id,
        NULL AS workplan_line_id,

        wbln.road_id,
        r.road_code,
        r.road_name,

        wbln.activity_id,
        COALESCE(wbln.activity_code_snapshot, a.code) AS activity_code,
        COALESCE(wbln.activity_name_snapshot, a.name) AS activity_name,
        COALESCE(wbln.unit_snapshot, a.unit) AS unit_of_measure,
        a.work_category,
        a.work_description,

        source_bql.chainage_start,
        source_bql.chainage_end,

        wbln.section_text AS wi_section_text,

        wbln.source_quantity AS planned_quantity,
        CASE
          WHEN COALESCE(wbln.source_rate, 0) > 0
            THEN wbln.source_rate
          ELSE wbln.adjusted_rate
        END AS planned_rate,
        wbln.source_amount AS planned_amount,

        (
          COALESCE(wi_used.already_instructed_quantity, 0)
          +
          COALESCE(old_used.already_instructed_quantity, 0)
        ) AS already_instructed_quantity,

        CASE
          WHEN wbln.line_origin = 'ENGINEER_ADDED' THEN 0
          ELSE GREATEST(
            COALESCE(wbln.source_quantity, 0)
            -
            (
              COALESCE(wi_used.already_instructed_quantity, 0)
              +
              COALESCE(old_used.already_instructed_quantity, 0)
            ),
            0
          )
        END AS original_pending_quantity,

        CASE
          WHEN wbln.line_origin = 'ENGINEER_ADDED' THEN 0
          WHEN COALESCE(wbln.source_quantity, 0) <= 0 THEN 0
          ELSE
            COALESCE(wbln.source_amount, 0)
            *
            (
              GREATEST(
                COALESCE(wbln.source_quantity, 0)
                -
                (
                  COALESCE(wi_used.already_instructed_quantity, 0)
                  +
                  COALESCE(old_used.already_instructed_quantity, 0)
                ),
                0
              )
              /
              COALESCE(wbln.source_quantity, 1)
            )
        END AS original_pending_amount,

        GREATEST(
          COALESCE(wbln.adjusted_quantity, 0)
          -
          (
            COALESCE(wi_used.already_instructed_quantity, 0)
            +
            COALESCE(old_used.already_instructed_quantity, 0)
          ),
          0
        ) AS pending_quantity,

        CASE
          WHEN COALESCE(wbln.adjusted_quantity, 0) <= 0 THEN 0
          ELSE
            COALESCE(wbln.adjusted_amount, 0)
            *
            (
              GREATEST(
                COALESCE(wbln.adjusted_quantity, 0)
                -
                (
                  COALESCE(wi_used.already_instructed_quantity, 0)
                  +
                  COALESCE(old_used.already_instructed_quantity, 0)
                ),
                0
              )
              /
              COALESCE(wbln.adjusted_quantity, 1)
            )
        END AS pending_amount,

        wbln.line_origin

      FROM wi_boq_lines wbln

      INNER JOIN wi_boq_lots wbl
        ON wbl.id = wbln.wi_boq_lot_id

      INNER JOIN boq_lots bl
        ON bl.id = wbln.boq_lot_id

      INNER JOIN projects p
        ON p.id = wbln.project_id

      INNER JOIN roads r
        ON r.id = wbln.road_id

      INNER JOIN activities a
        ON a.id = wbln.activity_id

      LEFT JOIN boq_lines source_bql
        ON source_bql.id = wbln.source_boq_line_id

      LEFT JOIN (
        SELECT
          wi_boq_line_id,
          SUM(COALESCE(instructed_quantity, 0)) AS already_instructed_quantity
        FROM work_instructions
        WHERE project_id = ?
          AND wi_boq_line_id IS NOT NULL
          AND COALESCE(status, 'draft') NOT IN ('cancelled', 'rejected', 'void')
        GROUP BY wi_boq_line_id
      ) wi_used
        ON wi_used.wi_boq_line_id = wbln.id

      LEFT JOIN (
        SELECT
          boq_line_id,
          SUM(COALESCE(instructed_quantity, 0)) AS already_instructed_quantity
        FROM work_instructions
        WHERE project_id = ?
          AND wi_boq_line_id IS NULL
          AND boq_line_id IS NOT NULL
          AND COALESCE(status, 'draft') NOT IN ('cancelled', 'rejected', 'void')
        GROUP BY boq_line_id
      ) old_used
        ON old_used.boq_line_id = wbln.source_boq_line_id

      WHERE wbln.project_id = ?
        AND wbln.status = 'active'

      ORDER BY
        r.road_name ASC,
        activity_code ASC,
        wbln.id ASC
      `,
      [projectId, projectId, projectId]
    );

    return res.json({
      success: true,
      arwpLines: rows,
    });
  } catch (err) {
    await conn.rollback();
    console.error("❌ Failed to load WI BOQ lines:", err);

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to load WI BOQ lines.",
    });
  } finally {
    conn.release();
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
      const wiBoqLineId = Number(line.wi_boq_line_id || 0);
      const boqLineId = Number(line.boq_line_id || 0);
      const requestedQty = Number(
        line.instructed_quantity || line.estimated_quantity || 0
      );

      if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
        throw new Error(
          "Each selected BOQ work item must have an instructed quantity greater than zero."
        );
      }

      let pendingRows = [];

      if (Number.isInteger(wiBoqLineId) && wiBoqLineId > 0) {
        const [rows] = await conn.query(
          `
          SELECT
            wbln.id AS wi_boq_line_id,
            wbln.source_boq_line_id AS boq_line_id,
            wbln.road_id,
            wbln.activity_id,
            wbln.adjusted_rate AS rate,
            COALESCE(wi_used.already_instructed_quantity, 0) AS wi_already_instructed_quantity,
            COALESCE(old_used.already_instructed_quantity, 0) AS old_already_instructed_quantity,
            GREATEST(
              COALESCE(wbln.adjusted_quantity, 0)
              -
              (
                COALESCE(wi_used.already_instructed_quantity, 0)
                +
                COALESCE(old_used.already_instructed_quantity, 0)
              ),
              0
            ) AS pending_quantity,
            r.road_code,
            r.road_name,
            COALESCE(wbln.activity_code_snapshot, a.code) AS activity_code,
            COALESCE(wbln.activity_name_snapshot, a.name) AS activity_name,
            COALESCE(wbln.unit_snapshot, a.unit) AS unit_of_measure
          FROM wi_boq_lines wbln

          INNER JOIN roads r
            ON r.id = wbln.road_id

          INNER JOIN activities a
            ON a.id = wbln.activity_id

          LEFT JOIN (
            SELECT
              wi_boq_line_id,
              SUM(COALESCE(instructed_quantity, 0)) AS already_instructed_quantity
            FROM work_instructions
            WHERE project_id = ?
              AND wi_boq_line_id IS NOT NULL
              AND COALESCE(status, 'draft') NOT IN ('cancelled', 'rejected', 'void')
            GROUP BY wi_boq_line_id
          ) wi_used
            ON wi_used.wi_boq_line_id = wbln.id

          LEFT JOIN (
            SELECT
              boq_line_id,
              SUM(COALESCE(instructed_quantity, 0)) AS already_instructed_quantity
            FROM work_instructions
            WHERE project_id = ?
              AND wi_boq_line_id IS NULL
              AND boq_line_id IS NOT NULL
              AND COALESCE(status, 'draft') NOT IN ('cancelled', 'rejected', 'void')
            GROUP BY boq_line_id
          ) old_used
            ON old_used.boq_line_id = wbln.source_boq_line_id

          WHERE wbln.id = ?
            AND wbln.project_id = ?
            AND wbln.status = 'active'
          LIMIT 1
          `,
          [projectId, projectId, wiBoqLineId, projectId]
        );

        pendingRows = rows;
      } else if (Number.isInteger(boqLineId) && boqLineId > 0) {
        const [rows] = await conn.query(
          `
          SELECT
            bql.id AS boq_line_id,
            NULL AS wi_boq_line_id,
            bql.road_id,
            bql.activity_id,
            bql.rate,
            COALESCE(used.already_instructed_quantity, 0) AS already_instructed_quantity,
            GREATEST(
              COALESCE(bql.quantity, 0) -
              COALESCE(used.already_instructed_quantity, 0),
              0
            ) AS pending_quantity,
            r.road_code,
            r.road_name,
            a.code AS activity_code,
            a.name AS activity_name,
            a.unit AS unit_of_measure
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

        pendingRows = rows;
      } else {
        throw new Error(
          "Work Instruction must be created from a saved WI BOQ line."
        );
      }

      if (pendingRows.length === 0) {
        throw new Error("Selected BOQ work item was not found for this project.");
      }

      const pendingQty = Number(pendingRows[0].pending_quantity || 0);

      if (requestedQty > pendingQty) {
        throw new Error(
          `Cannot instruct ${requestedQty}. Pending quantity for ${pendingRows[0].road_code} / ${pendingRows[0].activity_code} is only ${pendingQty}.`
        );
      }

      const finalRate = Number(
        line.instructed_rate || line.planned_rate || pendingRows[0].rate || 0
      );

      const [result] = await conn.query(
        `
        INSERT INTO work_instructions
          (
            workplan_line_id,
            boq_line_id,
            wi_boq_line_id,
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
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          null,
          boqLineId > 0 ? boqLineId : null,
          wiBoqLineId > 0 ? wiBoqLineId : null,

          projectId,
          line.project_name_snapshot ||
            project.project_name ||
            project.name ||
            null,

          line.road_id || pendingRows[0].road_id || null,
          line.road_code_snapshot || line.road_code || pendingRows[0].road_code || null,
          line.road_name_snapshot || line.road_name || pendingRows[0].road_name || null,
          line.contract_no_snapshot || project.project_number || null,
          line.contractor_snapshot || project.contractor || null,

          line.from_role || "RESIDENT ENGINEER",
          line.to_role || "SITE AGENT",

          line.activity_id || pendingRows[0].activity_id || null,

          finalInstructionNumber,
          sheet_no || null,
          d365_instruction_no || null,
          finalSource,

          instruction_date,
          requestedQty,
          finalRate,

          req.user.id,
          finalIssuedToUserId || line.issued_to_user_id || null,
          line.notes || note || null,

          line.bill_no || null,
          line.bill_item_no || line.activity_code || pendingRows[0].activity_code || null,
          line.bill_item_description ||
            line.description ||
            pendingRows[0].activity_name ||
            null,
          line.unit_of_measure || pendingRows[0].unit_of_measure || null,
          line.section_text || line.section || null,
          line.estimated_quantity || requestedQty || null,
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
      message: err.message || "Failed to save site instruction.",
    });
  } finally {
    conn.release();
  }
});

router.put("/project/:projectId/boq-adjustments", async (req, res) => {
  const projectId = Number(req.params.projectId);
  const userId = req.user?.id || req.user?.userId || null;

  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const availableAmount = Number(req.body.available_amount || 0);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid project ID.",
    });
  }

  if (lines.length === 0) {
    return res.status(400).json({
      success: false,
      message: "No BOQ adjustment lines were provided.",
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [lotRows] = await conn.query(
      `
      SELECT
        wbl.id AS wi_boq_lot_id,
        wbl.boq_lot_id,
        bl.workplan_id,
        bl.lot_no,
        bl.category,
        bl.locked_contract_sum
      FROM wi_boq_lots wbl
      INNER JOIN boq_lots bl
        ON bl.id = wbl.boq_lot_id
      WHERE wbl.project_id = ?
      ORDER BY wbl.id ASC
      LIMIT 1
      `,
      [projectId]
    );

    if (lotRows.length === 0) {
      throw new Error(
        "No editable Work Instruction BOQ lot found. Open the BOQ screen again to initialize it."
      );
    }

    const wiBoqLot = lotRows[0];

    for (const line of lines) {
      const isNewRow = !!line.is_new_boq_row;
      const sectionText = String(line.section_text || "").trim();
      const editedPendingQty = Number(line.edited_pending_quantity || 0);
      const rate = Number(line.rate || 0);
      const notes = line.notes || null;

      if (!Number.isFinite(editedPendingQty) || editedPendingQty < 0) {
        throw new Error("Pending quantity cannot be negative.");
      }

      if (isNewRow) {
        const roadId = Number(line.road_id || 0);
        const activityId = Number(line.activity_id || 0);

        if (!Number.isInteger(roadId) || roadId <= 0) {
          throw new Error("Select a road for every new BOQ activity.");
        }

        if (!Number.isInteger(activityId) || activityId <= 0) {
          throw new Error("Select an activity for every new BOQ activity.");
        }

        if (!Number.isFinite(rate) || rate <= 0) {
          throw new Error("Enter a valid rate for every new BOQ activity.");
        }

        if (editedPendingQty <= 0) {
          throw new Error(
            "New BOQ activity pending quantity must be greater than zero."
          );
        }

        const [activityRows] = await conn.query(
          `
          SELECT
            code,
            name,
            unit
          FROM activities
          WHERE id = ?
          LIMIT 1
          `,
          [activityId]
        );

        if (activityRows.length === 0) {
          throw new Error("Selected activity was not found.");
        }

        const activity = activityRows[0];
        const adjustedAmount = editedPendingQty * rate;

        await conn.query(
          `
          INSERT INTO wi_boq_lines
            (
              wi_boq_lot_id,
              project_id,
              boq_lot_id,
              source_boq_line_id,
              road_id,
              activity_id,
              activity_code_snapshot,
              activity_name_snapshot,
              unit_snapshot,
              section_text,
              source_quantity,
              source_rate,
              source_amount,
              adjusted_quantity,
              adjusted_rate,
              adjusted_amount,
              notes,
              line_origin,
              status,
              created_by,
              updated_by
            )
          VALUES
            (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 'ENGINEER_ADDED', 'active', ?, ?)
          `,
          [
            wiBoqLot.wi_boq_lot_id,
            projectId,
            wiBoqLot.boq_lot_id,
            roadId,
            activityId,
            activity.code,
            activity.name,
            activity.unit,
            sectionText,
            editedPendingQty,
            rate,
            adjustedAmount,
            notes,
            userId,
            userId,
          ]
        );

        continue;
      }

      const wiBoqLineId = Number(line.wi_boq_line_id || 0);

      if (!Number.isInteger(wiBoqLineId) || wiBoqLineId <= 0) {
        continue;
      }

      const [existingRows] = await conn.query(
        `
        SELECT
          wbln.id,
          wbln.adjusted_rate,
          COALESCE(used.already_instructed_quantity, 0) AS already_instructed_quantity
        FROM wi_boq_lines wbln
        LEFT JOIN (
          SELECT
            wi_boq_line_id,
            SUM(COALESCE(instructed_quantity, 0)) AS already_instructed_quantity
          FROM work_instructions
          WHERE project_id = ?
            AND wi_boq_line_id IS NOT NULL
            AND COALESCE(status, 'draft') NOT IN ('cancelled', 'rejected', 'void')
          GROUP BY wi_boq_line_id
        ) used
          ON used.wi_boq_line_id = wbln.id
        WHERE wbln.id = ?
          AND wbln.project_id = ?
        LIMIT 1
        `,
        [projectId, wiBoqLineId, projectId]
      );

      if (existingRows.length === 0) {
        throw new Error("One selected WI BOQ line was not found.");
      }

      const alreadyInstructedQty = Number(
        existingRows[0].already_instructed_quantity || 0
      );

      const finalRate =
        Number.isFinite(rate) && rate > 0
          ? rate
          : Number(existingRows[0].adjusted_rate || 0);

      const adjustedTotalQty = alreadyInstructedQty + editedPendingQty;
      const adjustedAmount = adjustedTotalQty * finalRate;

      await conn.query(
        `
        UPDATE wi_boq_lines
        SET
          section_text = ?,
          adjusted_quantity = ?,
          adjusted_rate = ?,
          adjusted_amount = ?,
          notes = ?,
          updated_by = ?
        WHERE id = ?
          AND project_id = ?
        `,
        [
          sectionText,
          adjustedTotalQty,
          finalRate,
          adjustedAmount,
          notes,
          userId,
          wiBoqLineId,
          projectId,
        ]
      );
    }

    await conn.query(
      `
      UPDATE wi_boq_lots
      SET
        available_amount = ?,
        updated_by = ?
      WHERE project_id = ?
      `,
      [availableAmount, userId, projectId]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: "BOQ adjustments saved successfully.",
      available_amount: availableAmount,
    });
  } catch (err) {
    await conn.rollback();
    console.error("❌ Failed to save WI BOQ adjustments:", err);

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to save BOQ adjustments.",
    });
  } finally {
    conn.release();
  }
});

module.exports = router;