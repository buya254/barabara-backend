// routes/dailyWorkReports.js
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
  const [rows] = await db.query("SELECT * FROM daily_work_reports WHERE id = ?", [
    report_id,
  ]);
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
  function toDateOnlyString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function getReportDateValidationError(reportDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate || ""))) {
      return "report_date must be in YYYY-MM-DD format";
    }

    const today = toDateOnlyString(new Date());

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = toDateOnlyString(tomorrowDate);

    if (reportDate < today) {
      return "You cannot create a daily report for a past date.";
    }

    if (reportDate > tomorrow) {
      return "You can only create a daily report for today or tomorrow.";
    }

    return null;
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
    const [pRows] = await db.query(
      "SELECT id FROM projects WHERE project_number = ? LIMIT 1",
      [project_number]
    );
    if (pRows.length === 0) return null;
    return Number(pRows[0].id);
  }

  return null;
}

/**
 * Tracking helper (YOUR workflow):
 * Site Agent creates draft -> submits to Inspector -> Inspector confirms -> ARE -> RE
 */
const statusTracker = (report) => {
  const s = String(report.status || "");
  const changeRequested = Number(report.change_requested || 0) === 1;

  if (changeRequested) {
    const changeMap = {
      SUBMITTED: {
        stage: 2,
        label: "Change Requested",
        nextRole: "siteagent",
        nextAction: "Amend and resubmit",
        waitingFor: "Site Agent to amend and resubmit",
      },
      CONFIRMED: {
        stage: 3,
        label: "Change Requested",
        nextRole: "inspector",
        nextAction: "Review requested change",
        waitingFor: "Inspector to review requested changes",
      },
      ARE_APPROVED: {
        stage: 4,
        label: "Change Requested",
        nextRole: "are",
        nextAction: "Review requested change",
        waitingFor: "A.R.E to review requested changes",
      },
    };

    if (changeMap[s]) return changeMap[s];
  }

  const map = {
    DRAFT: {
      stage: 1,
      label: "Draft (Site Agent)",
      nextRole: "siteagent",
      nextAction: "Submit to Inspector",
      waitingFor: "Site Agent to submit to Inspector",
    },
    SUBMITTED: {
      stage: 2,
      label: "Submitted (Waiting Inspector)",
      nextRole: "inspector",
      nextAction: "Approve",
      waitingFor: "Inspector to approve",
    },
    CONFIRMED: {
      stage: 3,
      label: "Inspector Approved",
      nextRole: "are",
      nextAction: "Approve",
      waitingFor: "A.R.E to approve",
    },
    ARE_APPROVED: {
      stage: 4,
      label: "ARE Approved",
      nextRole: "re",
      nextAction: "Final approve",
      waitingFor: "R.E to approve",
    },
    RE_APPROVED: {
      stage: 5,
      label: "RE Approved",
      nextRole: null,
      nextAction: "Print",
      waitingFor: "Completed (Printable)",
    },
  };

  return (
    map[s] || {
      stage: 0,
      label: s,
      nextRole: null,
      nextAction: null,
      waitingFor: "Unknown",
    }
  );
};

/**
 * Action logger -> writes into daily_work_reports_actions (NEW table created)
 */
const logDwrAction = async ({
  reportId,
  actionType,
  userId,
  userRole,
  notes = null,
}) => {
  await db.query(
    `INSERT INTO daily_work_reports_actions
     (report_id, action_type, action_by, action_by_role, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [reportId, actionType, userId, userRole || null, notes]
  );
};

/**
 * Fetch latest action for a report
 */
async function getLastAction(reportId) {
  const [rows] = await db.query(
    `
    SELECT
      a.action_type,
      a.action_by_role,
      a.notes,
      a.created_at,
      u.full_name,
      u.username
    FROM daily_work_reports_actions a
    LEFT JOIN users u ON u.id = a.action_by
    WHERE a.report_id = ?
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1
    `,
    [reportId]
  );
  return rows[0] || null;
}

const PLANT_RETURN_ITEMS = [
  "Motor Grader",
  "Wheel Loader",
  "Track Loader",
  "Track Shovel",
  "Bulldozer",
  "Sheepfoot Roller",
  "Vibrate Roller",
  "Single Drum Steel Roller",
  "Double Drum Steel Roller",
  "Grid Roller",
  "Water Tanker",
  "Tippers",
  "Truck",
  "Concrete Mixer 0.1m3",
  "Concrete Mixer 0.3m3",
  "Concrete Mixer 0.6m3",
  "Hand Roller",
  "Tractor (Trailer)",
  "Pulver Mixer",
  "Rotavator + Tractor",
  "Bitumen distributor",
  "Hand Sprayer",
  "Paver",
  "Excavator",
  "Poker Vibrator",
  "Pneumatic Tyre Roller",
  "Pavement Cutter",
  "Plate Compactor",
];

function parseFormJsonFromDb(value) {
  if (!value) return {};

  if (typeof value === "object") {
    return value;
  }

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
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizePlantName(value) {
  const raw = cleanText(value);
  const key = raw.toLowerCase().replace(/\s+/g, " ");

  const map = {
    "motor grader": "Motor Grader",
    "wheel loader": "Wheel Loader",
    "backhoe loader": "Wheel Loader",
    "track loader": "Track Loader",
    "track shovel": "Track Shovel",
    bulldozer: "Bulldozer",
    "sheepfoot roller": "Sheepfoot Roller",
    "vibrate roller": "Vibrate Roller",
    "vibratory roller": "Vibrate Roller",
    "single drum steel roller": "Single Drum Steel Roller",
    "double drum steel roller": "Double Drum Steel Roller",
    "grid roller": "Grid Roller",
    "water tanker": "Water Tanker",
    "water bowser/ tanker": "Water Tanker",
    "water bowser/tanker": "Water Tanker",
    "water bowser": "Water Tanker",
    tippers: "Tippers",
    "tipper truck": "Tippers",
    truck: "Truck",
    "dump truck": "Truck",
    "concrete mixer 0.1 m³": "Concrete Mixer 0.1m3",
    "concrete mixer 0.1m3": "Concrete Mixer 0.1m3",
    "concrete mixer 0.3 m³": "Concrete Mixer 0.3m3",
    "concrete mixer 0.3m3": "Concrete Mixer 0.3m3",
    "concrete mixer 0.6 m³": "Concrete Mixer 0.6m3",
    "concrete mixer 0.6m3": "Concrete Mixer 0.6m3",
    "hand roller": "Hand Roller",
    tractor: "Tractor (Trailer)",
    "tractor with trailer": "Tractor (Trailer)",
    "tractor (trailer)": "Tractor (Trailer)",
    "pulver mixer": "Pulver Mixer",
    "rotavator + tractor": "Rotavator + Tractor",
    "bitumen distributor": "Bitumen distributor",
    "asphalt distributor": "Bitumen distributor",
    "hand sprayer": "Hand Sprayer",
    paver: "Paver",
    "asphalt paver": "Paver",
    excavator: "Excavator",
    "crawler excavator": "Excavator",
    "mini excavator": "Excavator",
    "poker vibrator": "Poker Vibrator",
    "concrete vibrator": "Poker Vibrator",
    "pneumatic tyre roller": "Pneumatic Tyre Roller",
    "pneumatic tyred roller": "Pneumatic Tyre Roller",
    "pavement cutter": "Pavement Cutter",
    "plate compactor": "Plate Compactor",
    compactor: "Plate Compactor",
  };

  return map[key] || raw;
}

function calculatePercentWorked(hoursWorked, hoursIdle, hoursBreakdown) {
  const total = hoursWorked + hoursIdle + hoursBreakdown;

  if (!total) return "";

  return `${((hoursWorked / total) * 100).toFixed(1)}%`;
}

const LABOUR_RETURN_PERSONNEL = [
  "Site Agent",
  "Deputy Site Agents",
  "Senior Foremen",
  "Patch work Headmen",
  "Concrete Foremen",
  "Bitumen Foremen",
  "Masonry Foremen",
  "Carpentry Foreman",
  "Levelers",
  "Surveyors",
  "Stone pitching Headmen",
  "Concrete Works Headmen",
  "Crusher Foremen",
  "Blasters",
  "Culverts/Gabion Headmen",
  "Stabilization Foremen",
  "Material Technicians",
  "Assistant Surveyors",
  "Site Clerks",
  "High Power Electricians",
  "Store Keepers",
  "Security officers",
  "Welders",
  "Plant Mechanics",
  "Pre-coating Mechanics",
  "Crusher Mechanics",
  "Crusher Operators",
  "Motor vehicle Mechanics",
  "Distributor operators",
  "Dressers",
  "Plant Operators",
  "Drillers",
  "Drivers",
  "Auto Electricians",
  "Masons",
  "Concrete Mixer Operators",
  "Time Keepers",
  "Security Guards",
  "Tyremen",
  "Greasers",
  "General Labourers",
  "Spanner Boys",
  "Chainmen",
  "Fuel Attendants",
  "Turn Boys",
  "Carpenters",
  "Students",
  "Secretaries",
  "",
  "",
];

function calculateLabourPercent(part, total) {
  if (!total) return "";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function makeEmptyLabourSummaryRows() {
  return LABOUR_RETURN_PERSONNEL.map((personnel, index) => ({
    no: index + 1,
    personnel,
    requiredNo: 0,
    mobilized: 0,
    balance: 0,
    male: 0,
    female: 0,
    plwds: 0,
    malePercent: "",
    femalePercent: "",
    plwdsPercent: "",
  }));
}

async function getNextUserReportNo(userId) {
  const [rows] = await db.query(
    `
    SELECT COALESCE(MAX(user_report_no), 0) + 1 AS next_no
    FROM daily_work_reports
    WHERE created_by = ?
    `,
    [String(userId)]
  );

  return Number(rows?.[0]?.next_no || 1);
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
      return res
        .status(400)
        .json({ message: "form_date is required (YYYY-MM-DD)" });
    }

    let contractId = contract_id;

    // If contract_id isn't provided, resolve via project_id/project_number
    if (!contractId) {
      const resolvedProjectId = await resolveProjectId({ project_id, project_number });

      if (!resolvedProjectId) {
        return res.status(400).json({
          message:
            "Provide contract_id OR project_id OR project_number (and ensure projects.project_number exists).",
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
 * PLANT & EQUIPMENT RETURNS SUMMARY
 * GET /api/daily-work-reports/plant-equipment-summary?project_id=&from_date=&to_date=
 *
 * Reads submitted/approved daily work reports and aggregates plantRows.
 */
router.get("/plant-equipment-summary", authenticateJWT, async (req, res) => {
  try {
    const { project_id, project_number, from_date, to_date } = req.query;

    if (!from_date || !to_date) {
      return res.status(400).json({
        message: "from_date and to_date are required in YYYY-MM-DD format.",
      });
    }

    const resolvedProjectId = await resolveProjectId({
      project_id,
      project_number,
    });

    if (!resolvedProjectId) {
      return res.status(400).json({
        message: "project_id or project_number is required.",
      });
    }

    const assignment = await getAssignment(resolvedProjectId);
    const userRole = String(req.user.role || "").toLowerCase();
    const uid = String(req.user.id);

    const [userProjectRows] = await db.query(
      `
      SELECT 1
      FROM user_projects
      WHERE user_id = ?
        AND project_id = ?
      LIMIT 1
      `,
      [req.user.id, resolvedProjectId]
    );

    const allowed =
      userRole === "admin" ||
      isAssignedToProject(req.user, assignment) ||
      userProjectRows.length > 0;

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to view plant returns for this project.",
      });
    }

    const [projectRows] = await db.query(
      `
      SELECT
        p.id,
        p.project_number,
        p.project_name,
        p.name,
        p.contractor,
        p.region,
        c.id AS contract_id,
        c.contract_name
      FROM projects p
      LEFT JOIN contracts c
        ON c.project_id = p.id
      WHERE p.id = ?
      ORDER BY c.id DESC
      LIMIT 1
      `,
      [resolvedProjectId]
    );

    const project = projectRows[0] || null;

    const [reportRows] = await db.query(
      `
      SELECT
        id,
        user_report_no,
        project_id,
        contract_id,
        report_date,
        status,
        form_json,
        created_by,
        submitted_at,
        confirmed_at,
        are_approved_at,
        re_approved_at
      FROM daily_work_reports
      WHERE project_id = ?
        AND DATE(report_date) BETWEEN ? AND ?
        AND status IN ('SUBMITTED', 'CONFIRMED', 'ARE_APPROVED', 'RE_APPROVED')
        AND COALESCE(change_requested, 0) = 0
      ORDER BY report_date ASC, id ASC
      `,
      [resolvedProjectId, from_date, to_date]
    );

    const summaryMap = new Map();

    PLANT_RETURN_ITEMS.forEach((name, index) => {
      summaryMap.set(name, {
        no: index + 1,
        machineryOnSite: name,
        count: 0,
        plateNumbers: new Set(),
        hoursWorked: 0,
        hoursIdle: 0,
        hoursBreakdown: 0,
        percentWorked: "",
        remarks: "",
      });
    });

    const extraItems = new Map();

    reportRows.forEach((report) => {
      const formJson = parseFormJsonFromDb(report.form_json);
      const plantRows = Array.isArray(formJson.plantRows)
        ? formJson.plantRows
        : [];

      plantRows.forEach((row) => {
        const rawDescription = cleanText(row.description);
        if (!rawDescription) return;

        const normalizedName = normalizePlantName(rawDescription);

        const targetMap = summaryMap.has(normalizedName)
          ? summaryMap
          : extraItems;

        if (!targetMap.has(normalizedName)) {
          targetMap.set(normalizedName, {
            no: PLANT_RETURN_ITEMS.length + extraItems.size + 1,
            machineryOnSite: normalizedName,
            count: 0,
            plateNumbers: new Set(),
            hoursWorked: 0,
            hoursIdle: 0,
            hoursBreakdown: 0,
            percentWorked: "",
            remarks: "Other / not in standard KURA list",
          });
        }

        const item = targetMap.get(normalizedName);

        const plateNo = cleanText(row.plateNo);
        if (plateNo) {
          item.plateNumbers.add(plateNo.toUpperCase());
        } else {
          item.count += 1;
        }

        item.hoursWorked += toNumber(row.hoursWorked);
        item.hoursIdle += toNumber(row.hoursIdle);
        item.hoursBreakdown += toNumber(row.hoursBreakdown);
      });
    });

    const finalizeItem = (item) => {
      const uniquePlateCount = item.plateNumbers.size;
      const fallbackCount = item.count;

      const count = uniquePlateCount || fallbackCount || "";

      return {
        no: item.no,
        machineryOnSite: item.machineryOnSite,
        count,
        hoursWorked: Number(item.hoursWorked.toFixed(2)),
        hoursIdle: Number(item.hoursIdle.toFixed(2)),
        hoursBreakdown: Number(item.hoursBreakdown.toFixed(2)),
        percentWorked: calculatePercentWorked(
          item.hoursWorked,
          item.hoursIdle,
          item.hoursBreakdown
        ),
        remarks: item.remarks || "",
        plateNumbers: Array.from(item.plateNumbers),
      };
    };

    const standardRows = Array.from(summaryMap.values()).map(finalizeItem);
    const extraRows = Array.from(extraItems.values()).map(finalizeItem);

    return res.json({
      project: project
        ? {
            id: project.id,
            project_number: project.project_number,
            project_name: project.project_name || project.name || "",
            name: project.name || project.project_name || "",
            contractor: project.contractor || "",
            region: project.region || "",
            contract_id: project.contract_id || null,
            contract_no: project.contract_name || project.project_number || "",
          }
        : {
            id: resolvedProjectId,
          },

      period: {
        from_date,
        to_date,
      },

      reports_used: reportRows.map((r) => ({
        id: r.id,
        user_report_no: r.user_report_no,
        report_date: r.report_date,
        status: r.status,
      })),

      rows: [...standardRows, ...extraRows],
    });
  } catch (err) {
    console.error("❌ plant-equipment-summary error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * LABOUR RETURNS SUMMARY
 * GET /api/daily-work-reports/labour-returns-summary?project_id=&from_date=&to_date=
 *
 * Reads submitted/approved daily work reports and aggregates labourReturnRows.
 * Cumulative logic is person-days:
 * same driver present for 7 days = 7 driver entries.
 */
router.get("/labour-returns-summary", authenticateJWT, async (req, res) => {
  try {
    const { project_id, project_number, from_date, to_date } = req.query;

    if (!from_date || !to_date) {
      return res.status(400).json({
        message: "from_date and to_date are required in YYYY-MM-DD format.",
      });
    }

    const resolvedProjectId = await resolveProjectId({
      project_id,
      project_number,
    });

    if (!resolvedProjectId) {
      return res.status(400).json({
        message: "project_id or project_number is required.",
      });
    }

    const assignment = await getAssignment(resolvedProjectId);
    const userRole = String(req.user.role || "").toLowerCase();

    const [userProjectRows] = await db.query(
      `
      SELECT 1
      FROM user_projects
      WHERE user_id = ?
        AND project_id = ?
      LIMIT 1
      `,
      [req.user.id, resolvedProjectId]
    );

    const allowed =
      userRole === "admin" ||
      isAssignedToProject(req.user, assignment) ||
      userProjectRows.length > 0;

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to view labour returns for this project.",
      });
    }

    const [projectRows] = await db.query(
      `
      SELECT
        p.id,
        p.project_number,
        p.project_name,
        p.name,
        p.contractor,
        p.region,
        c.id AS contract_id,
        c.contract_name
      FROM projects p
      LEFT JOIN contracts c
        ON c.project_id = p.id
      WHERE p.id = ?
      ORDER BY c.id DESC
      LIMIT 1
      `,
      [resolvedProjectId]
    );

    const project = projectRows[0] || null;

    const [reportRows] = await db.query(
      `
      SELECT
        id,
        user_report_no,
        project_id,
        contract_id,
        report_date,
        status,
        form_json,
        created_by,
        submitted_at,
        confirmed_at,
        are_approved_at,
        re_approved_at
      FROM daily_work_reports
      WHERE project_id = ?
        AND DATE(report_date) BETWEEN ? AND ?
        AND status IN ('SUBMITTED', 'CONFIRMED', 'ARE_APPROVED', 'RE_APPROVED')
        AND COALESCE(change_requested, 0) = 0
      ORDER BY report_date ASC, id ASC
      `,
      [resolvedProjectId, from_date, to_date]
    );

    const summaryRows = makeEmptyLabourSummaryRows();

    reportRows.forEach((report) => {
      const formJson = parseFormJsonFromDb(report.form_json);
      const labourReturnRows = Array.isArray(formJson.labourReturnRows)
        ? formJson.labourReturnRows
        : [];

      labourReturnRows.forEach((row) => {
        const rowNo = Number(row.no);

        if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > 50) {
          return;
        }

        const target = summaryRows[rowNo - 1];

        // Allow rows 49 and 50 to carry custom personnel names.
        if (rowNo >= 49 && cleanText(row.personnel)) {
          target.personnel = cleanText(row.personnel);
        }

        const requiredNo = toNumber(row.requiredNo);
        const male = toNumber(row.male);
        const female = toNumber(row.female);
        const plwds = toNumber(row.plwds);

        target.requiredNo += requiredNo;
        target.male += male;
        target.female += female;
        target.plwds += plwds;
      });
    });

    let requiredTotal = 0;
    let mobilizedTotal = 0;
    let maleTotal = 0;
    let femaleTotal = 0;
    let plwdsTotal = 0;
    let casualTotal = 0;
    let skilledTotal = 0;

    const finalizedRows = summaryRows.map((row) => {
      const mobilized = row.male + row.female;
      const balance = row.requiredNo - mobilized;

      const finalRow = {
        no: row.no,
        personnel: row.personnel,
        requiredNo: Number(row.requiredNo.toFixed(2)),
        mobilized: Number(mobilized.toFixed(2)),
        balance: Number(balance.toFixed(2)),
        male: Number(row.male.toFixed(2)),
        female: Number(row.female.toFixed(2)),
        plwds: Number(row.plwds.toFixed(2)),
        malePercent: calculateLabourPercent(row.male, mobilized),
        femalePercent: calculateLabourPercent(row.female, mobilized),
        plwdsPercent: calculateLabourPercent(row.plwds, mobilized),
      };

      requiredTotal += row.requiredNo;
      mobilizedTotal += mobilized;
      maleTotal += row.male;
      femaleTotal += row.female;
      plwdsTotal += row.plwds;

      // Row 41 General Labourers + Row 47 Students = casual labourers.
      if (row.no === 41 || row.no === 47) {
        casualTotal += mobilized;
      } else {
        skilledTotal += mobilized;
      }

      return finalRow;
    });

    return res.json({
      project: project
        ? {
            id: project.id,
            project_number: project.project_number,
            project_name: project.project_name || project.name || "",
            name: project.name || project.project_name || "",
            contractor: project.contractor || "",
            region: project.region || "",
            contract_id: project.contract_id || null,
            contract_no: project.contract_name || project.project_number || "",
          }
        : {
            id: resolvedProjectId,
          },

      period: {
        from_date,
        to_date,
      },

      reports_used: reportRows.map((r) => ({
        id: r.id,
        user_report_no: r.user_report_no,
        report_date: r.report_date,
        status: r.status,
      })),

      totals: {
        requiredNo: Number(requiredTotal.toFixed(2)),
        mobilized: Number(mobilizedTotal.toFixed(2)),
        balance: Number((requiredTotal - mobilizedTotal).toFixed(2)),
        male: Number(maleTotal.toFixed(2)),
        female: Number(femaleTotal.toFixed(2)),
        plwds: Number(plwdsTotal.toFixed(2)),
        malePercent: calculateLabourPercent(maleTotal, mobilizedTotal),
        femalePercent: calculateLabourPercent(femaleTotal, mobilizedTotal),
        plwdsPercent: calculateLabourPercent(plwdsTotal, mobilizedTotal),
        casualLabourers: Number(casualTotal.toFixed(2)),
        skilledLabourers: Number(skilledTotal.toFixed(2)),
      },

      rows: finalizedRows,
    });
  } catch (err) {
    console.error("❌ labour-returns-summary error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET list (role-filtered)
 * GET /api/daily-work-reports?project_id=&project_number=&status=&report_date=
 */
// LIST DAILY REPORTS + TRACKING
router.get("/", authenticateJWT, async (req, res) => {
  try {
    const { project_id, project_number, status, report_date } = req.query;
    const resolvedProjectId = await resolveProjectId({ project_id, project_number });

    let sql = `
      SELECT
        dwr.*,

        -- last action summary
        act.created_at AS last_action_at,
        act.action_type     AS last_action_type,
        act.action_by_role  AS last_action_role,
        act.notes           AS last_action_notes,
        ua.full_name        AS last_actor_name,
        ua.username         AS last_actor_username,

        -- assignment ids
        pwa.siteagent_id    AS assigned_siteagent_id,
        pwa.inspector_id    AS assigned_inspector_id,
        pwa.are_id          AS assigned_are_id,
        pwa.re_id           AS assigned_re_id,

        -- usernames / names for each role
        sa.username         AS siteagent_username,
        sa.full_name        AS siteagent_full_name,
        ins.username        AS inspector_username,
        ins.full_name       AS inspector_full_name,
        areu.username       AS are_username,
        areu.full_name      AS are_full_name,
        reu.username        AS re_username,
        reu.full_name       AS re_full_name

      FROM daily_work_reports dwr
      LEFT JOIN (
        SELECT report_id, MAX(id) AS last_action_id
        FROM daily_work_reports_actions
        GROUP BY report_id
      ) la ON la.report_id = dwr.id
      LEFT JOIN daily_work_reports_actions act
        ON act.id = la.last_action_id
      LEFT JOIN users ua ON ua.id = act.action_by

      LEFT JOIN project_workflow_assignments pwa
        ON pwa.project_id = dwr.project_id
      LEFT JOIN users sa   ON sa.id   = pwa.siteagent_id
      LEFT JOIN users ins  ON ins.id  = pwa.inspector_id
      LEFT JOIN users areu ON areu.id = pwa.are_id
      LEFT JOIN users reu  ON reu.id  = pwa.re_id

      WHERE 1 = 1
    `;

    const vals = [];

    if (resolvedProjectId) {
      sql += " AND dwr.project_id = ?";
      vals.push(resolvedProjectId);
    }

    if (status) {
      sql += " AND dwr.status = ?";
      vals.push(status);
    }

    if (report_date) {
      sql += " AND dwr.report_date = ?";
      vals.push(report_date);
    }

    sql += " ORDER BY dwr.report_date DESC, dwr.id DESC";

    const [rows] = await db.query(sql, vals);

    // Build tracking object, including assigned usernames
    const buildTracking = (r) => {
      const base = statusTracker(r);

      const assignedSiteAgent =
        r.siteagent_username || r.siteagent_full_name || null;
      const assignedInspector =
        r.inspector_username || r.inspector_full_name || null;
      const assignedARE = r.are_username || r.are_full_name || null;
      const assignedRE = r.re_username || r.re_full_name || null;

      // Put the *person* in the "waitingFor" text where we know them
      let waitingFor = base.waitingFor;
      if (base.nextRole === "siteagent" && assignedSiteAgent) {
        waitingFor = `Site Agent (${assignedSiteAgent}) to ${base.nextAction?.toLowerCase() || "continue"}`;
      } else if (base.nextRole === "inspector" && assignedInspector) {
        waitingFor = `Inspector (${assignedInspector}) to ${base.nextAction?.toLowerCase() || "continue"}`;
      } else if (base.nextRole === "are" && assignedARE) {
        waitingFor = `A.R.E (${assignedARE}) to ${base.nextAction?.toLowerCase() || "continue"}`;
      } else if (base.nextRole === "re" && assignedRE) {
        waitingFor = `R.E (${assignedRE}) to ${base.nextAction?.toLowerCase() || "continue"}`;
      }

      return {
        ...base,
        waitingFor,
        lastActionAt: r.last_action_at || null,
        lastActionType: r.last_action_type || null,
        lastActorName: r.last_actor_name || r.last_actor_username || null,
        lastActorRole: r.last_action_role || null,
        lastActionNotes: r.last_action_notes || null,
        assignedSiteAgentUsername: assignedSiteAgent,
        assignedInspectorUsername: assignedInspector,
        assignedAREUsername: assignedARE,
        assignedREUsername: assignedRE,
      };
    };

    const withTracking = rows.map((r) => ({
      ...r,
      tracking: buildTracking(r),
    }));

    const userRole = String(req.user.role).toLowerCase();

    // Admin sees everything
    if (userRole === "admin") {
      return res.json(withTracking);
    }

    // Others: only see reports where they're in the workflow
    const uid = String(req.user.id);
    const filtered = withTracking.filter((r) => {
      return (
        String(r.assigned_siteagent_id || "") === uid ||
        String(r.assigned_inspector_id || "") === uid ||
        String(r.assigned_are_id || "") === uid ||
        String(r.assigned_re_id || "") === uid
      );
    });

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

    const userRole = String(req.user.role || "").toLowerCase();
    const uid = String(req.user.id);

    const isAdminUser = userRole === "admin";
    const isWorkflowAssigned = isAssignedToProject(req.user, assignment);
    const isCreator = String(report.created_by || "") === uid;

    const [userProjectRows] = await db.query(
      `
      SELECT 1
      FROM user_projects
      WHERE user_id = ?
        AND project_id = ?
      LIMIT 1
      `,
      [req.user.id, report.project_id]
    );

    const isInUserProjects = userProjectRows.length > 0;

    const allowed =
      isAdminUser || isWorkflowAssigned || isCreator || isInUserProjects;

    if (!allowed) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const withParsed = await getReportWithParsed(report.id);
    const lastAction = await getLastAction(report.id);

    const [projectRows] = await db.query(
      `
      SELECT
        p.id,
        p.project_number,
        p.project_name,
        p.name,
        p.region,
        p.financial_year,
        p.contractor,
        p.chainage,
        p.project_duration,

        c.id AS contract_id,
        c.contract_name,
        c.financial_year AS contract_financial_year
      FROM projects p
      LEFT JOIN contracts c
        ON c.project_id = p.id
      WHERE p.id = ?
      ORDER BY c.id DESC
      LIMIT 1
      `,
      [report.project_id]
    );

    const project = projectRows[0] || null;

    return res.json({
      ...withParsed,

      form_json: withParsed.form_json_parsed || {},
      user_report_no: report.user_report_no,

      project: project
        ? {
            id: project.id,
            project_number: project.project_number,
            project_name: project.project_name,
            name: project.name,
            region: project.region,
            financial_year: project.financial_year,
            contractor: project.contractor,
            chainage: project.chainage,
            project_duration: project.project_duration,
          }
        : null,

      contract: project
        ? {
            id: project.contract_id || report.contract_id || null,
            contract_name: project.contract_name || project.project_number,
            financial_year:
              project.contract_financial_year || project.financial_year,
          }
        : null,

      tracking: {
        ...statusTracker(report),
        lastActionAt: lastAction?.created_at || null,
        lastActionType: lastAction?.action_type || null,
        lastActorName: lastAction?.full_name || lastAction?.username || null,
        lastActorRole: lastAction?.action_by_role || null,
        lastActionNotes: lastAction?.notes || null,
      },
    });
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
    const reportDateError = getReportDateValidationError(report_date);

    if (reportDateError) {
      return res.status(400).json({ message: reportDateError });
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

    // Create/Open Today should only reuse an existing NORMAL draft.
    // Submitted reports should not block a new blank draft.
    const [existingDraft] = await db.query(
      `
      SELECT *
      FROM daily_work_reports
      WHERE project_id = ?
        AND report_date = ?
        AND created_by = ?
        AND status = 'DRAFT'
        AND submitted_at IS NULL
        AND amendment_of_report_id IS NULL
      ORDER BY id DESC
      LIMIT 1
      `,
      [resolvedProjectId, report_date, String(req.user.id)]
    );

    if (existingDraft.length > 0) {
      const existingReport = await getReportWithParsed(existingDraft[0].id);

      return res.status(200).json({
        message: "Draft already exists for this project and date.",
        report: existingReport,
      });
    }

    const nextUserReportNo = await getNextUserReportNo(req.user.id);

      const insertSql = `
        INSERT INTO daily_work_reports
          (
            user_report_no,
            amendment_of_report_id,
            amendment_type,
            project_id,
            contract_id,
            report_date,
            status,
            form_json,
            created_by
          )
        VALUES (?, NULL, NULL, ?, ?, ?, 'DRAFT', ?, ?)
      `;

      const [result] = await db.query(insertSql, [
        nextUserReportNo,
        resolvedProjectId,
        contract_id || null,
        report_date,
        jsonStr,
        String(req.user.id),
      ]);
    
      // ✅ action log
    await logDwrAction({
      reportId: result.insertId,
      actionType: "CREATED",
      userId: req.user.id,
      userRole: req.user.role,
    });

    const created = await getReportWithParsed(result.insertId);
    return res.status(201).json({ message: "Draft created", report: created });
  } catch (err) {
    console.error("❌ daily-work-reports create error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * CREATE AMENDMENT DRAFT
 * Clones a submitted change-requested report into a new editable DRAFT.
 * POST /api/daily-work-reports/:id/create-amendment
 */
router.post("/:id/create-amendment", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "siteagent")) {
      return res.status(403).json({
        message: "Only Site Agent can create amendment drafts",
      });
    }

    const sourceReport = await getReport(req.params.id);
    if (!sourceReport) {
      return res.status(404).json({ message: "Original report not found" });
    }

    if (String(sourceReport.status) !== "SUBMITTED") {
      return res.status(409).json({
        message: "Only SUBMITTED reports can be amended.",
      });
    }

    if (Number(sourceReport.change_requested || 0) !== 1) {
      return res.status(409).json({
        message: "This report does not have a pending change request.",
      });
    }

    const assignment = await getAssignment(sourceReport.project_id);
    if (
      !assignment ||
      String(assignment.siteagent_id) !== String(req.user.id)
    ) {
      return res.status(403).json({
        message: "You are not the assigned Site Agent for this project",
      });
    }

    // If an amendment draft already exists for this original report, open it.
    const [existingDraft] = await db.query(
      `
      SELECT *
      FROM daily_work_reports
      WHERE amendment_of_report_id = ?
        AND status = 'DRAFT'
        AND submitted_at IS NULL
        AND created_by = ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [sourceReport.id, String(req.user.id)]
    );

    if (existingDraft.length > 0) {
      const existing = await getReportWithParsed(existingDraft[0].id);
      return res.status(200).json({
        message: "Amendment draft already exists.",
        report: existing,
      });
    }

    const nextUserReportNo = await getNextUserReportNo(req.user.id);

    const [result] = await db.query(
      `
      INSERT INTO daily_work_reports
        (
          user_report_no,
          amendment_of_report_id,
          amendment_type,
          project_id,
          contract_id,
          report_date,
          status,
          change_requested,
          form_json,
          created_by
        )
      VALUES (?, ?, 'CHANGE_REQUEST', ?, ?, ?, 'DRAFT', 0, ?, ?)
      `,
      [
        nextUserReportNo,
        sourceReport.id,
        sourceReport.project_id,
        sourceReport.contract_id || null,
        sourceReport.report_date,
        sourceReport.form_json || "{}",
        String(req.user.id),
      ]
    );

    await logDwrAction({
      reportId: result.insertId,
      actionType: "AMENDMENT_DRAFT_CREATED",
      userId: req.user.id,
      userRole: req.user.role,
      notes: `Created from report ID ${sourceReport.id}`,
    });

    const created = await getReportWithParsed(result.insertId);

    return res.status(201).json({
      message: "Amendment draft created.",
      report: created,
    });
  } catch (err) {
    console.error("❌ create amendment draft error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * UPDATE (Site Agent only)
 * Allows:
 * - DRAFT update
 * - SUBMITTED + change_requested = 1 amendment
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

    const isDraft = String(report.status) === "DRAFT";
    const isAmendmentDraft =
      isDraft && Number(report.amendment_of_report_id || 0) > 0;

    if (!isDraft) {
      return res.status(409).json({
        message: "Only DRAFT reports can be edited by Site Agent.",
      });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.siteagent_id) !== String(req.user.id)) {
      return res.status(403).json({
        message: "You are not the assigned Site Agent for this project",
      });
    }

    const { form_json, contract_id } = req.body;
    const jsonStr = safeJsonStringify(form_json);

    const amendedAt = isAmendmentDraft ? nowSql() : null;

    await db.query(
      `
      UPDATE daily_work_reports
      SET form_json = ?,
          contract_id = COALESCE(?, contract_id),
          amended_at = COALESCE(?, amended_at)
      WHERE id = ?
      `,
      [jsonStr, contract_id ?? null, amendedAt, report.id]
    );

    await logDwrAction({
      reportId: report.id,
      actionType: isAmendmentDraft ? "UPDATED_AMENDMENT_DRAFT" : "UPDATED_DRAFT",
      userId: req.user.id,
      userRole: req.user.role,
    });

    const updated = await getReportWithParsed(report.id);

    return res.json({
      message: isAmendmentDraft ? "Amendment draft updated" : "Draft updated",
      report: updated,
    });
  } catch (err) {
    console.error("❌ daily-work-reports update error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * DELETE draft (Site Agent only) – Only deletes DRAFT
 * DELETE /api/daily-work-reports/:id
 */
router.delete("/:id", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "siteagent")) {
      return res.status(403).json({ message: "Only Site Agent can delete drafts" });
    }

    const report = await getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ message: "Draft not found" });
    }

    if (String(report.status) !== "DRAFT" || report.submitted_at) {
      return res.status(409).json({
        message: "Only drafts that have never been submitted can be deleted.",
      });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.siteagent_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned Site Agent for this project" });
    }

    await db.query("DELETE FROM daily_work_reports WHERE id = ? AND status = 'DRAFT'", [
      report.id,
    ]);

    await logDwrAction({
      reportId: report.id,
      actionType: "DELETED_DRAFT",
      userId: req.user.id,
      userRole: req.user.role,
    });

    return res.json({ success: true, message: "Draft deleted successfully." });
  } catch (err) {
    console.error("❌ Delete draft error:", err);
    return res.status(500).json({ message: "Failed to delete draft. Internal server error." });
  }
});

/**
 * SUBMIT (Site Agent)
 * Allows:
 * - DRAFT -> SUBMITTED
 * - SUBMITTED + change_requested = 1 -> SUBMITTED + change_requested = 0
 * PUT /api/daily-work-reports/:id/submit
 */
router.put("/:id/submit", authenticateJWT, async (req, res) => {
  try {
    if (!isRole(req.user, "siteagent")) {
      return res.status(403).json({ message: "Only Site Agent can submit" });
    }

    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    const isDraft = String(report.status) === "DRAFT";
    const isAmendmentDraft =
      isDraft && Number(report.amendment_of_report_id || 0) > 0;

    if (!isDraft) {
      return res.status(409).json({
        message: "Only DRAFT reports can be submitted.",
      });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.siteagent_id) !== String(req.user.id)) {
      return res.status(403).json({
        message: "You are not the assigned Site Agent for this project",
      });
    }

    const submitTime = nowSql();
    const amendedAt = isAmendmentDraft ? submitTime : null;

    await db.query(
      `
      UPDATE daily_work_reports
      SET status = 'SUBMITTED',
          submitted_at = ?,
          change_requested = 0,
          change_request_notes = NULL,
          change_requested_by = NULL,
          change_requested_role = NULL,
          change_requested_at = NULL,
          amended_at = COALESCE(?, amended_at)
      WHERE id = ?
      `,
      [submitTime, amendedAt, report.id]
    );

    await logDwrAction({
      reportId: report.id,
      actionType: isAmendmentDraft ? "AMENDED_RESUBMITTED" : "SUBMITTED",
      userId: req.user.id,
      userRole: req.user.role,
      notes: req.body?.notes || null,
    });

    if (report.amendment_of_report_id) {
      await db.query(
        `
        UPDATE daily_work_reports
        SET status = 'SUPERSEDED',
            change_requested = 0,
            superseded_by_report_id = ?
        WHERE id = ?
        `,
        [report.id, report.amendment_of_report_id]
      );

      await logDwrAction({
        reportId: report.amendment_of_report_id,
        actionType: "SUPERSEDED_BY_AMENDMENT",
        userId: req.user.id,
        userRole: req.user.role,
        notes: `Superseded by amended report ID ${report.id}`,
      });
    }

    const updated = await getReportWithParsed(report.id);

    return res.json({
      message: isAmendmentDraft
        ? "Amendment resubmitted to Inspector"
        : "Submitted to Inspector",
      report: updated,
    });
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
    if (Number(report.change_requested || 0) === 1) {
      return res.status(409).json({
        message:
          "This report has a pending change request. Site Agent must create and submit an amendment draft before Inspector approval.",
      });
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

    await logDwrAction({
      reportId: report.id,
      actionType: "INSPECTOR_APPROVED",
      userId: req.user.id,
      userRole: req.user.role,
      notes: notes || null,
    });

    const updated = await getReportWithParsed(report.id);
    return res.json({ message: "Confirmed by Inspector", report: updated });
  } catch (err) {
    console.error("❌ confirm error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * REQUEST CHANGE
 * Inspector: SUBMITTED -> stays SUBMITTED, change_requested = 1
 * ARE: CONFIRMED -> stays CONFIRMED, change_requested = 1
 * RE: ARE_APPROVED -> stays ARE_APPROVED, change_requested = 1
 * PUT /api/daily-work-reports/:id/request-change
 * body: { notes }
 */
router.put("/:id/request-change", authenticateJWT, async (req, res) => {
  try {
    const userRole = String(req.user.role || "").toLowerCase();

    const rules = {
      inspector: {
        expectedStatus: "SUBMITTED",
        assignmentColumn: "inspector_id",
        actionType: "INSPECTOR_REQUESTED_CHANGE",
        targetRole: "Site Agent",
      },
      are: {
        expectedStatus: "CONFIRMED",
        assignmentColumn: "are_id",
        actionType: "ARE_REQUESTED_CHANGE",
        targetRole: "Inspector",
      },
      re: {
        expectedStatus: "ARE_APPROVED",
        assignmentColumn: "re_id",
        actionType: "RE_REQUESTED_CHANGE",
        targetRole: "A.R.E",
      },
    };

    const rule = rules[userRole];

    if (!rule) {
      return res.status(403).json({
        message: "Only Inspector, A.R.E, or R.E can request changes",
      });
    }

    const report = await getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (String(report.status) !== rule.expectedStatus) {
      return res.status(409).json({
        message: `This report must be ${rule.expectedStatus} before ${userRole.toUpperCase()} can request changes.`,
      });
    }

    if (Number(report.change_requested || 0) === 1) {
      return res.status(409).json({
        message: "This report already has a pending change request.",
      });
    }

    const assignment = await getAssignment(report.project_id);
    if (
      !assignment ||
      String(assignment[rule.assignmentColumn] || "") !== String(req.user.id)
    ) {
      return res.status(403).json({
        message: `You are not the assigned ${userRole.toUpperCase()} for this project`,
      });
    }

    const { notes } = req.body || {};

    if (!notes || !String(notes).trim()) {
      return res.status(400).json({
        message: "Please provide instructions for the requested change.",
      });
    }

    await db.query(
      `
      UPDATE daily_work_reports
      SET change_requested = 1,
          change_request_notes = ?,
          change_requested_by = ?,
          change_requested_role = ?,
          change_requested_at = ?
      WHERE id = ?
      `,
      [
        String(notes).trim(),
        req.user.id,
        req.user.role || userRole,
        nowSql(),
        report.id,
      ]
    );

    await logDwrAction({
      reportId: report.id,
      actionType: rule.actionType,
      userId: req.user.id,
      userRole: req.user.role,
      notes: String(notes).trim(),
    });

    const updated = await getReportWithParsed(report.id);

    return res.json({
      message: `Change requested. Report sent back to ${rule.targetRole} with notes.`,
      report: updated,
    });
  } catch (err) {
    console.error("❌ request-change error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.put("/:id/inspector-edit", authenticateJWT, async (req, res) => {
  try {
    // Only Inspector can edit at this stage
    if (String(req.user.role).toLowerCase() !== "inspector") {
      return res.status(403).json({ message: "Only Inspector can edit at this stage" });
    }

    const reportId = parseInt(req.params.id, 10);
    if (Number.isNaN(reportId)) {
      return res.status(400).json({ message: "Invalid report id" });
    }

    const report = await getReport(reportId);
    if (!report) return res.status(404).json({ message: "Report not found" });

    // Only SUBMITTED reports can be edited by Inspector
    if (String(report.status) !== "SUBMITTED") {
      return res.status(409).json({ message: "Only SUBMITTED reports can be edited by Inspector" });
    }

    if (Number(report.change_requested || 0) === 1) {
      return res.status(409).json({
        message:
          "This report has a pending change request. Site Agent must amend and resubmit before Inspector approval.",
      });
    }

    // Must be assigned inspector for this project
    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.inspector_id || "") !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned Inspector for this project" });
    }

    const { form_json, contract_id } = req.body || {};
    if (form_json === undefined) {
      return res.status(400).json({ message: "form_json is required" });
    }

    const jsonStr = safeJsonStringify(form_json);

    await db.query(
      `
      UPDATE daily_work_reports
      SET form_json = ?, contract_id = COALESCE(?, contract_id)
      WHERE id = ?
      `,
      [jsonStr, contract_id ?? null, reportId]
    );

    // Log the edit
    await logDwrAction({
      reportId,
      actionType: "INSPECTOR_EDITED",
      userId: req.user.id,
      userRole: req.user.role,
    });

    const updated = await getReportWithParsed(reportId);
    return res.json({ message: "Inspector edit saved", report: updated });
  } catch (err) {
    console.error("❌ inspector-edit error:", err);
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

    if (Number(report.change_requested || 0) === 1) {
      return res.status(409).json({
        message:
          "This report has a pending change request. It must be resolved before A.R.E approval.",
      });
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

    await logDwrAction({
      reportId: report.id,
      actionType: "ARE_APPROVED",
      userId: req.user.id,
      userRole: req.user.role,
      notes: notes || null,
    });

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

    if (Number(report.change_requested || 0) === 1) {
      return res.status(409).json({
        message:
          "This report has a pending change request. It must be resolved before R.E final approval.",
      });
    }

    const assignment = await getAssignment(report.project_id);
    if (!assignment || String(assignment.re_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not the assigned RE for this project" });
    }

    const { notes } = req.body || {};

    // Ensure contract_id exists (keep this behavior)
    let contractId = report.contract_id;

    if (!contractId) {
      const [cRows] = await db.query(
        "SELECT id FROM contracts WHERE project_id = ? ORDER BY id DESC LIMIT 1",
        [report.project_id]
      );
      if (cRows.length > 0) {
        contractId = cRows[0].id;
        await db.query("UPDATE daily_work_reports SET contract_id = ? WHERE id = ?", [
          contractId,
          report.id,
        ]);
      }
    }

    if (!contractId) {
      return res.status(400).json({
        message:
          "Cannot seal report: contract_id missing and no contract found for this project",
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

    await logDwrAction({
      reportId: report.id,
      actionType: "RE_APPROVED",
      userId: req.user.id,
      userRole: req.user.role,
      notes: notes || null,
    });

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