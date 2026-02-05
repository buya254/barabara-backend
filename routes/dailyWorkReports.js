const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

// ---------------- Helpers ----------------

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function safeJsonStringify(maybeObj) {
  if (typeof maybeObj === "string") return maybeObj;
  return JSON.stringify(maybeObj ?? {});
}

function isRole(user, role) {
  return String(user?.role || "").toLowerCase() === role;
}

async function getAssignment(project_id) {
  const [rows] = await db.query(
    "SELECT * FROM project_workflow_assignments WHERE project_id = ?",
    [project_id]
  );
  return rows[0] || null;
}

function isAssignedToProject(user, assignment) {
  const uid = String(user?.id ?? "");
  if (!assignment) return false;

  return (
    String(assignment.siteagent_id) === uid ||
    String(assignment.inspector_id || "") === uid ||
    String(assignment.are_id) === uid ||
    String(assignment.re_id) === uid
  );
}

async function getReport(report_id) {
  const [rows] = await db.query(
    "SELECT * FROM daily_work_reports WHERE id = ?",
    [report_id]
  );
  return rows[0] || null;
}

async function getReportWithParsed(id) {
  const r = await getReport(id);
  if (!r) return null;
  try {
    return { ...r, form_json_parsed: JSON.parse(r.form_json) };
  } catch {
    return { ...r, form_json_parsed: null };
  }
}

async function logAction(report_id, action, user, notes = null) {
  await db.query(
    `
    INSERT INTO daily_work_report_actions
      (report_id, action, actor_id, actor_role, notes)
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      report_id,
      action,
      String(user?.id ?? ""),
      String(user?.role ?? ""),
      notes,
    ]
  );
}

/**
 * Resolve project_id.
 * Accepts:
 *  - project_id (number)
 *  - project_number (string)  <-- requires projects.project_number column
 */
async function resolveProjectId({ project_id, project_number }) {
  if (project_id) return Number(project_id);

  if (project_number) {
    // IMPORTANT: This requires you to add projects.project_number
    const [pRows] = await db.query(
      "SELECT id FROM projects WHERE project_number = ? LIMIT 1",
      [project_number]
    );

    if (pRows.length === 0) return null;
    return Number(pRows[0].id);
  }

  return null;
}

// ---------------- ROUTES ----------------

/**
 * READ-ONLY: approved sealed form
 * GET /api/daily-work-reports/approved/view?contract_id=&form_date=
 * OR  /approved/view?project_id=&form_date=
 * OR  /approved/view?project_number=&form_date=   (requires projects.project_number)
 *
 * NOTE: placed BEFORE "/:id" so Express doesn't treat "approved" as an id.
 */
router.get("/approved/view", authenticateJWT, async (req, res) => {
  try {
    const { contract_id, project_id, project_number, form_date } = req.query;

    if (!form_date) {
      return res.status(400).json({ message: "form_date is required (YYYY-MM-DD)" });
    }

    let contractId = contract_id;

    // If contract_id isn't provided, resolve via project_id/project_number
    if (!contractId) {
      const resolvedProjectId = await resolveProjectId({ project_id, project_number });

      if (!resolvedProjectId) {
        return res.status(400).json({
          message: "Provide contract_id OR project_id OR project_number (and ensure projects.project_number exists).",
        });
      }

      const [cRows] = await db.query(
        "SELECT id FROM contracts WHERE project_id = ? ORDER BY id DESC LIMIT 1",
        [resolvedProjectId]
      );

      if (cRows.length === 0) {
        return res.status(404).json({ message: "No contract found for this project" });
      }

      contractId = cRows[0].id;
    }

    const [rows] = await db.query(
      "SELECT * FROM approved_daily_forms WHERE contract_id = ? AND form_date = ? LIMIT 1",
      [contractId, form_date]
    );

    if (rows.length === 0) return res.status(404).json({ message: "Approved form not found" });

    return res.json(rows[0]);
  } catch (err) {
    console.error("❌ approved form read error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET list (role-filtered)
 * GET /api/daily-work-reports?project_id=&project_number=&status=&report_date=
 */
router.get("/", authenticateJWT, async (req, res) => {
  try {
    const { project_id, project_number, status, report_date } = req.query;

    const resolvedProjectId = await resolveProjectId({ project_id, project_number });

    let sql = "SELECT * FROM daily_work_reports WHERE 1=1";
    const vals = [];

    if (resolvedProjectId) {
      sql += " AND project_id = ?";
      vals.push(resolvedProjectId);
    }

    if (status) {
      sql += " AND status = ?";
      vals.push(status);
    }

    if (report_date) {
      sql += " AND report_date = ?";
      vals.push(report_date);
    }

    sql += " ORDER BY report_date DESC, id DESC";

    const [rows] = await db.query(sql, vals);

    // Admin sees all; others see only assigned projects
    if (String(req.user.role).toLowerCase() === "admin") {
      return res.json(rows);
    }

    const filtered = [];
    for (const r of rows) {
      const assignment = await getAssignment(r.project_id);
      if (isAssignedToProject(req.user, assignment)) filtered.push(r);
    }

    return res.json(filtered);
  } catch (err) {
    console.error("❌ daily-work-reports list error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET single report
 * GET /api/daily-work-reports/:id
 */
router.get("/:id", authenticateJWT, async (req, res) => {
  try {
    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    const assignment = await getAssignment(report.project_id);

    const isAdmin = String(req.user.role).toLowerCase() === "admin";
    const allowed = isAdmin || isAssignedToProject(req.user, assignment);

    if (!allowed) return res.status(403).json({ message: "Forbidden" });

    const withParsed = await getReportWithParsed(report.id);
    return res.json(withParsed);
  } catch (err) {
    console.error("❌ daily-work-reports get error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * CREATE (Site Agent only) -> DRAFT
 * POST /api/daily-work-reports
 * body: { project_id OR project_number, contract_id?, report_date, form_json }
 */
router.post("/", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "siteagent")) {
      return res.status(403).json({ message: "Only Site Agent can create reports" });
    }

    const { project_id, project_number, contract_id, report_date, form_json } = req.body;

    if (!report_date) {
      return res.status(400).json({ message: "report_date is required" });
    }

    const resolvedProjectId = await resolveProjectId({ project_id, project_number });
    if (!resolvedProjectId) {
      return res.status(400).json({
        message:
          "project_id or project_number is required (and project_number requires projects.project_number column).",
      });
    }

    const assignment = await getAssignment(resolvedProjectId);
    if (!assignment || String(assignment.siteagent_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned Site Agent for this project" });
    }

    const jsonStr = safeJsonStringify(form_json);

    // Prevent duplicate by project/date
    const [existing] = await db.query(
      "SELECT * FROM daily_work_reports WHERE project_id = ? AND report_date = ?",
      [resolvedProjectId, report_date]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: "A report already exists for this project and date",
        report: existing[0],
      });
    }

    const insertSql = `
      INSERT INTO daily_work_reports
        (project_id, contract_id, report_date, status, form_json, created_by)
      VALUES (?, ?, ?, 'DRAFT', ?, ?)
    `;

    const [result] = await db.query(insertSql, [
      resolvedProjectId,
      contract_id || null,
      report_date,
      jsonStr,
      String(req.user.id),
    ]);

    await logAction(result.insertId, "CREATE_DRAFT", req.user, null);

    const created = await getReportWithParsed(result.insertId);
    return res.status(201).json({ message: "Draft created", report: created });
  } catch (err) {
    console.error("❌ daily-work-reports create error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * UPDATE (Site Agent only) when status = DRAFT
 * PUT /api/daily-work-reports/:id
 * body: { form_json, contract_id? }
 */
router.put("/:id", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "siteagent")) {
      return res.status(403).json({ message: "Only Site Agent can update reports" });
    }

    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    if (String(report.status) !== "DRAFT") {
      return res.status(409).json({ message: "Only DRAFT reports can be edited" });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.siteagent_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned Site Agent for this project" });
    }

    const { form_json, contract_id } = req.body;
    const jsonStr = safeJsonStringify(form_json);

    await db.query(
      `
      UPDATE daily_work_reports
      SET form_json = ?, contract_id = COALESCE(?, contract_id)
      WHERE id = ?
      `,
      [jsonStr, contract_id ?? null, report.id]
    );

    await logAction(report.id, "UPDATE_DRAFT", req.user, null);

    const updated = await getReportWithParsed(report.id);
    return res.json({ message: "Draft updated", report: updated });
  } catch (err) {
    console.error("❌ daily-work-reports update error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * SUBMIT (Site Agent) DRAFT -> SUBMITTED
 * PUT /api/daily-work-reports/:id/submit
 */
router.put("/:id/submit", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "siteagent")) {
      return res.status(403).json({ message: "Only Site Agent can submit" });
    }

    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    if (String(report.status) !== "DRAFT") {
      return res.status(409).json({ message: "Only DRAFT reports can be submitted" });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.siteagent_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned Site Agent for this project" });
    }

    await db.query(
      `
      UPDATE daily_work_reports
      SET status = 'SUBMITTED', submitted_at = ?
      WHERE id = ?
      `,
      [nowSql(), report.id]
    );

    await logAction(report.id, "SUBMIT", req.user, null);

    const updated = await getReportWithParsed(report.id);
    return res.json({ message: "Submitted to Inspector", report: updated });
  } catch (err) {
    console.error("❌ submit error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * CONFIRM (Inspector) SUBMITTED -> CONFIRMED
 * PUT /api/daily-work-reports/:id/confirm
 * body: { notes? }
 */
router.put("/:id/confirm", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "inspector")) {
      return res.status(403).json({ message: "Only Inspector can confirm" });
    }

    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    if (String(report.status) !== "SUBMITTED") {
      return res.status(409).json({ message: "Only SUBMITTED reports can be confirmed" });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.inspector_id || "") !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned Inspector for this project" });
    }

    const { notes } = req.body || {};

    await db.query(
      `
      UPDATE daily_work_reports
      SET status = 'CONFIRMED', confirmed_at = ?
      WHERE id = ?
      `,
      [nowSql(), report.id]
    );

    await logAction(report.id, "CONFIRM", req.user, notes || null);

    const updated = await getReportWithParsed(report.id);
    return res.json({ message: "Confirmed by Inspector", report: updated });
  } catch (err) {
    console.error("❌ confirm error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * ARE APPROVE (ARE) CONFIRMED -> ARE_APPROVED
 * PUT /api/daily-work-reports/:id/are-approve
 * body: { notes? }
 */
router.put("/:id/are-approve", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "are")) {
      return res.status(403).json({ message: "Only ARE can approve at this stage" });
    }

    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    if (String(report.status) !== "CONFIRMED") {
      return res.status(409).json({ message: "Only CONFIRMED reports can be ARE approved" });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.are_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned ARE for this project" });
    }

    const { notes } = req.body || {};

    await db.query(
      `
      UPDATE daily_work_reports
      SET status = 'ARE_APPROVED', are_approved_at = ?
      WHERE id = ?
      `,
      [nowSql(), report.id]
    );

    await logAction(report.id, "ARE_APPROVE", req.user, notes || null);

    const updated = await getReportWithParsed(report.id);
    return res.json({ message: "Approved by ARE", report: updated });
  } catch (err) {
    console.error("❌ ARE approve error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * RE APPROVE (RE) ARE_APPROVED -> RE_APPROVED + seal into approved_daily_forms
 * PUT /api/daily-work-reports/:id/re-approve
 * body: { notes? }
 */
router.put("/:id/re-approve", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "re")) {
      return res.status(403).json({ message: "Only RE can approve at this stage" });
    }

    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    if (String(report.status) !== "ARE_APPROVED") {
      return res.status(409).json({ message: "Only ARE_APPROVED reports can be RE approved" });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.re_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned RE for this project" });
    }

    const { notes } = req.body || {};

    // Ensure contract_id exists (THIS is the line you asked about — keep it)
    let contractId = report.contract_id;

    if (!contractId) {
      const [cRows] = await db.query(
        "SELECT id FROM contracts WHERE project_id = ? ORDER BY id DESC LIMIT 1",
        [report.project_id]
      );
      if (cRows.length > 0) {
        contractId = cRows[0].id;
        await db.query(
          "UPDATE daily_work_reports SET contract_id = ? WHERE id = ?",
          [contractId, report.id]
        );
      }
    }

    if (!contractId) {
      return res.status(400).json({
        message: "Cannot seal report: contract_id missing and no contract found for this project",
      });
    }

    // Validate JSON for CAST(? AS JSON)
    let jsonForDb = report.form_json;
    try {
      JSON.parse(jsonForDb);
    } catch {
      jsonForDb = JSON.stringify({});
    }

    // 1) Mark RE approved
    await db.query(
      `
      UPDATE daily_work_reports
      SET status = 'RE_APPROVED', re_approved_at = ?
      WHERE id = ?
      `,
      [nowSql(), report.id]
    );

    await logAction(report.id, "RE_APPROVE", req.user, notes || null);

    // 2) Upsert into approved_daily_forms (contract_id + form_date)
    const [existing] = await db.query(
      "SELECT id FROM approved_daily_forms WHERE contract_id = ? AND form_date = ? LIMIT 1",
      [contractId, report.report_date]
    );

    const approvedBy = String(req.user.username || req.user.id || "");

    if (existing.length > 0) {
      await db.query(
        `
        UPDATE approved_daily_forms
        SET form_data = CAST(? AS JSON),
            approved_by = ?
        WHERE id = ?
        `,
        [jsonForDb, approvedBy, existing[0].id]
      );
    } else {
      await db.query(
        `
        INSERT INTO approved_daily_forms
          (contract_id, form_date, form_data, approved_by)
        VALUES (?, ?, CAST(? AS JSON), ?)
        `,
        [contractId, report.report_date, jsonForDb, approvedBy]
      );
    }

    const updated = await getReportWithParsed(report.id);
    return res.json({
      message: "Approved by RE and sealed into approved_daily_forms",
      report: updated,
      sealed: { contract_id: contractId, form_date: report.report_date },
    });
  } catch (err) {
    console.error("❌ RE approve/seal error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
