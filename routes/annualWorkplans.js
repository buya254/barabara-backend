const express = require("express");
const router = express.Router();

const multer = require("multer");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

const uploadDir = path.join(__dirname, "../uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: uploadDir });

router.use(authenticateJWT);

/**
 * GET /api/annual-workplans
 * List annual workplans with line count and total amount.
 */
router.get("/", async (req, res) => {
  try {
    const { financial_year, region, status } = req.query;

    let sql = `
      SELECT 
        aw.id,
        aw.financial_year,
        aw.region,
        aw.title,
        aw.status,
        aw.base_workplan_id,
        aw.created_by,
        aw.approved_by,
        aw.created_at,
        aw.updated_at,
        aw.approved_at,
        COUNT(awl.id) AS line_count,
        COALESCE(SUM(awl.planned_amount), 0) AS total_planned_amount
      FROM annual_workplans aw
      LEFT JOIN annual_workplan_lines awl 
        ON awl.workplan_id = aw.id
        AND awl.status <> 'cancelled'
      WHERE 1 = 1
    `;

    const params = [];

    if (financial_year) {
      sql += " AND aw.financial_year = ?";
      params.push(financial_year);
    }

    if (region) {
      sql += " AND aw.region = ?";
      params.push(region);
    }

    if (status) {
      sql += " AND aw.status = ?";
      params.push(status);
    }

    sql += `
      GROUP BY 
        aw.id,
        aw.financial_year,
        aw.region,
        aw.title,
        aw.status,
        aw.base_workplan_id,
        aw.created_by,
        aw.approved_by,
        aw.created_at,
        aw.updated_at,
        aw.approved_at
      ORDER BY aw.created_at DESC
    `;

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching annual workplans:", error);
    res.status(500).json({
      message: "Failed to fetch annual workplans",
      error: error.message,
    });
  }
});

/**
 * POST /api/annual-workplans
 * Create blank annual workplan header.
 */
router.post("/", async (req, res) => {
  try {
    const {
      financial_year,
      region = "Coast",
      title,
      created_by = null,
    } = req.body;

    if (!financial_year) {
      return res.status(400).json({
        message: "financial_year is required",
      });
    }

    const [existing] = await db.query(
      `
        SELECT id 
        FROM annual_workplans 
        WHERE financial_year = ? AND region = ?
        LIMIT 1
      `,
      [financial_year, region]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message:
          "An annual workplan already exists for this financial year and region",
        workplan_id: existing[0].id,
      });
    }

    const [result] = await db.query(
      `
        INSERT INTO annual_workplans (
          financial_year,
          region,
          title,
          created_by
        )
        VALUES (?, ?, ?, ?)
      `,
      [
        financial_year,
        region,
        title || `${region} Annual Roads Workplan ${financial_year}`,
        created_by,
      ]
    );

    res.status(201).json({
      message: "Annual workplan created successfully",
      workplan_id: result.insertId,
    });
  } catch (error) {
    console.error("Error creating annual workplan:", error);
    res.status(500).json({
      message: "Failed to create annual workplan",
      error: error.message,
    });
  }
});

/**
 * POST /api/annual-workplans/generate
 * Generate a new workplan from a previous one.
 */
router.post("/generate", async (req, res) => {
  let connection;

  try {
    const {
      base_workplan_id,
      new_financial_year,
      region = "Coast",
      title,
      created_by = null,
    } = req.body;

    if (!base_workplan_id || !new_financial_year) {
      return res.status(400).json({
        message: "base_workplan_id and new_financial_year are required",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [baseRows] = await connection.query(
      `
        SELECT id, financial_year, region, title
        FROM annual_workplans
        WHERE id = ?
        LIMIT 1
      `,
      [base_workplan_id]
    );

    if (baseRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "Base annual workplan not found",
      });
    }

    const [existing] = await connection.query(
      `
        SELECT id
        FROM annual_workplans
        WHERE financial_year = ? AND region = ?
        LIMIT 1
      `,
      [new_financial_year, region]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        message: "A workplan already exists for this financial year and region",
        workplan_id: existing[0].id,
      });
    }

    const [created] = await connection.query(
      `
        INSERT INTO annual_workplans (
          financial_year,
          region,
          title,
          status,
          base_workplan_id,
          created_by
        )
        VALUES (?, ?, ?, 'draft', ?, ?)
      `,
      [
        new_financial_year,
        region,
        title || `${region} Annual Roads Workplan ${new_financial_year}`,
        base_workplan_id,
        created_by,
      ]
    );

    const newWorkplanId = created.insertId;

    const [copied] = await connection.query(
      `
        INSERT INTO annual_workplan_lines (
          workplan_id,
          project_id,
          road_id,
          activity_id,
          financial_year,
          lot_no,
          category,
          chainage_start,
          chainage_end,
          planned_quantity,
          planned_rate,
          remarks,
          status
        )
        SELECT
          ? AS workplan_id,
          old.project_id,
          old.road_id,
          old.activity_id,
          ? AS financial_year,
          old.lot_no,
          old.category,
          old.chainage_start,
          old.chainage_end,
          old.planned_quantity,

          COALESCE(
            (
              SELECT ar.unit_rate
              FROM activity_rates ar
              WHERE ar.activity_id = old.activity_id
                AND ar.financial_year = ?
                AND ar.is_active = 1
                AND (ar.region = ? OR ar.region = 'National')
              ORDER BY 
                CASE 
                  WHEN ar.region = ? THEN 0
                  WHEN ar.region = 'National' THEN 1
                  ELSE 2
                END
              LIMIT 1
            ),
            old.planned_rate
          ) AS planned_rate,

          CONCAT('Generated from workplan ID ', old.workplan_id) AS remarks,
          'draft' AS status
        FROM annual_workplan_lines old
        WHERE old.workplan_id = ?
          AND old.status <> 'cancelled'
      `,
      [
        newWorkplanId,
        new_financial_year,
        new_financial_year,
        region,
        region,
        base_workplan_id,
      ]
    );

    await connection.commit();

    res.status(201).json({
      message: "Annual workplan generated successfully",
      new_workplan_id: newWorkplanId,
      copied_lines: copied.affectedRows,
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    console.error("Error generating annual workplan:", error);

    res.status(500).json({
      message: "Failed to generate annual workplan",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/annual-workplans/:id/lines
 * Get all lines in one annual workplan.
 */
router.get("/:id/lines", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
        SELECT
          awl.id,
          awl.workplan_id,
          awl.project_id,
          awl.road_id,
          awl.activity_id,
          awl.financial_year,
          awl.lot_no,
          awl.category,
          awl.chainage_start,
          awl.chainage_end,
          awl.planned_quantity,
          awl.planned_rate,
          awl.planned_amount,
          awl.remarks,
          awl.status,

          r.road_code,
          r.road_name,

          a.code AS activity_code,
          a.name AS activity_description,
          a.unit,

          p.project_number,
          p.project_name
        FROM annual_workplan_lines awl
        INNER JOIN roads r
          ON r.id = awl.road_id
        INNER JOIN activities a
          ON a.id = awl.activity_id
        LEFT JOIN projects p
          ON p.id = awl.project_id
        WHERE awl.workplan_id = ?
          AND awl.status <> 'cancelled'
        ORDER BY 
          p.project_number,
          r.road_code,
          a.code
      `,
      [id]
    );

    res.json(rows);
  } catch (error) {
    console.error("Error fetching annual workplan lines:", error);
    res.status(500).json({
      message: "Failed to fetch annual workplan lines",
      error: error.message,
    });
  }
});

/**
 * POST /api/annual-workplans/lines
 * Add one road/activity line to a workplan.
 */
router.post("/lines", async (req, res) => {
  try {
    const {
      workplan_id,
      project_id = null,
      road_id,
      activity_id,
      lot_no = null,
      category = null,
      chainage_start = 0,
      chainage_end = 0,
      planned_quantity = 0,
      planned_rate,
      remarks = null,
    } = req.body;

    if (!workplan_id || !road_id || !activity_id) {
      return res.status(400).json({
        message: "workplan_id, road_id, and activity_id are required",
      });
    }

    const [workplanRows] = await db.query(
      `
        SELECT financial_year, region
        FROM annual_workplans
        WHERE id = ?
        LIMIT 1
      `,
      [workplan_id]
    );

    if (workplanRows.length === 0) {
      return res.status(404).json({
        message: "Annual workplan not found",
      });
    }

    const workplan = workplanRows[0];

    let finalRate = planned_rate;

    if (finalRate === undefined || finalRate === null || finalRate === "") {
      const [rateRows] = await db.query(
        `
          SELECT unit_rate
          FROM activity_rates
          WHERE activity_id = ?
            AND financial_year = ?
            AND is_active = 1
            AND (region = ? OR region = 'National')
          ORDER BY 
            CASE 
              WHEN region = ? THEN 0
              WHEN region = 'National' THEN 1
              ELSE 2
            END
          LIMIT 1
        `,
        [
          activity_id,
          workplan.financial_year,
          workplan.region,
          workplan.region,
        ]
      );

      finalRate = rateRows.length > 0 ? rateRows[0].unit_rate : 0;
    }

    const [result] = await db.query(
      `
        INSERT INTO annual_workplan_lines (
          workplan_id,
          project_id,
          road_id,
          activity_id,
          financial_year,
          lot_no,
          category,
          chainage_start,
          chainage_end,
          planned_quantity,
          planned_rate,
          remarks
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        workplan_id,
        project_id,
        road_id,
        activity_id,
        workplan.financial_year,
        lot_no,
        category,
        chainage_start,
        chainage_end,
        planned_quantity,
        finalRate,
        remarks,
      ]
    );

    res.status(201).json({
      message: "Annual workplan line added successfully",
      line_id: result.insertId,
    });
  } catch (error) {
    console.error("Error adding annual workplan line:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This road/activity/chainage already exists in this workplan",
      });
    }

    res.status(500).json({
      message: "Failed to add annual workplan line",
      error: error.message,
    });
  }
});

/**
 * PUT /api/annual-workplans/lines/:lineId
 * Update quantity, rate, chainage, lot/category, remarks, or status.
 */
router.put("/lines/:lineId", async (req, res) => {
  try {
    const { lineId } = req.params;

    const {
      project_id,
      lot_no,
      category,
      chainage_start,
      chainage_end,
      planned_quantity,
      planned_rate,
      remarks,
      status,
    } = req.body;

    const fields = [];
    const params = [];

    const addField = (column, value) => {
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        params.push(value);
      }
    };

    addField("project_id", project_id);
    addField("lot_no", lot_no);
    addField("category", category);
    addField("chainage_start", chainage_start);
    addField("chainage_end", chainage_end);
    addField("planned_quantity", planned_quantity);
    addField("planned_rate", planned_rate);
    addField("remarks", remarks);
    addField("status", status);

    if (fields.length === 0) {
      return res.status(400).json({
        message: "No fields provided for update",
      });
    }

    params.push(lineId);

    const [result] = await db.query(
      `
        UPDATE annual_workplan_lines
        SET ${fields.join(", ")}
        WHERE id = ?
      `,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Annual workplan line not found",
      });
    }

    res.json({
      message: "Annual workplan line updated successfully",
    });
  } catch (error) {
    console.error("Error updating annual workplan line:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This update would duplicate another road/activity/chainage line",
      });
    }

    res.status(500).json({
      message: "Failed to update annual workplan line",
      error: error.message,
    });
  }
});

/**
 * DELETE /api/annual-workplans/lines/:lineId
 * Soft-cancel a workplan line.
 */
router.delete("/lines/:lineId", async (req, res) => {
  try {
    const { lineId } = req.params;

    const [result] = await db.query(
      `
        UPDATE annual_workplan_lines
        SET status = 'cancelled'
        WHERE id = ?
      `,
      [lineId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Annual workplan line not found",
      });
    }

    res.json({
      message: "Annual workplan line cancelled successfully",
    });
  } catch (error) {
    console.error("Error cancelling annual workplan line:", error);
    res.status(500).json({
      message: "Failed to cancel annual workplan line",
      error: error.message,
    });
  }
});

/**
 * POST /api/annual-workplans/rates
 * Add or update one activity rate for a financial year.
 */
router.post("/rates", async (req, res) => {
  try {
    const {
      activity_id,
      financial_year,
      region = "National",
      unit_rate,
      source = "KRB",
      notes = null,
    } = req.body;

    if (!activity_id || !financial_year || unit_rate === undefined) {
      return res.status(400).json({
        message: "activity_id, financial_year, and unit_rate are required",
      });
    }

    await db.query(
      `
        INSERT INTO activity_rates (
          activity_id,
          financial_year,
          region,
          unit_rate,
          source,
          notes,
          is_active
        )
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          unit_rate = ?,
          source = ?,
          notes = ?,
          is_active = 1,
          updated_at = CURRENT_TIMESTAMP
      `,
      [
        activity_id,
        financial_year,
        region,
        unit_rate,
        source,
        notes,
        unit_rate,
        source,
        notes,
      ]
    );

    res.json({
      message: "Activity rate saved successfully",
    });
  } catch (error) {
    console.error("Error saving activity rate:", error);
    res.status(500).json({
      message: "Failed to save activity rate",
      error: error.message,
    });
  }
});

/**
 * GET /api/annual-workplans/rates/list
 * List rates with activity details.
 */
router.get("/rates/list", async (req, res) => {
  try {
    const { financial_year, region } = req.query;

    let sql = `
      SELECT
        ar.id,
        ar.activity_id,
        ar.financial_year,
        ar.region,
        ar.unit_rate,
        ar.source,
        ar.notes,
        ar.is_active,
        ar.created_at,
        ar.updated_at,
        a.code AS activity_code,
        a.name AS activity_description,
        a.unit
      FROM activity_rates ar
      INNER JOIN activities a
        ON a.id = ar.activity_id
      WHERE 1 = 1
    `;

    const params = [];

    if (financial_year) {
      sql += " AND ar.financial_year = ?";
      params.push(financial_year);
    }

    if (region) {
      sql += " AND ar.region = ?";
      params.push(region);
    }

    sql += `
      ORDER BY ar.financial_year DESC, ar.region, a.code
    `;

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching activity rates:", error);
    res.status(500).json({
      message: "Failed to fetch activity rates",
      error: error.message,
    });
  }
});
function getCellText(row, index) {
  const value = row.getCell(index).value;

  if (value === null || value === undefined) return "";

  if (typeof value === "object") {
    if (value.result !== undefined && value.result !== null) {
      return String(value.result).trim();
    }

    if (value.text) {
      return String(value.text).trim();
    }

    if (value.richText && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("").trim();
    }

    return String(value).trim();
  }

  return String(value).trim();
}

function getCellNumber(row, index) {
  const text = getCellText(row, index);

  if (!text) return null;

  const cleaned = text.replace(/,/g, "").replace(/[^\d.-]/g, "");
  const number = Number(cleaned);

  return Number.isFinite(number) ? number : null;
}

function normalizeFinancialYear(value) {
  if (!value) return "";

  const text = String(value).trim();

  if (/^\d{4}\/\d{2}$/.test(text)) {
    return text;
  }

  if (/^\d{4}-\d{4}$/.test(text)) {
    return `${text.slice(0, 4)}/${text.slice(-2)}`;
  }

  return text;
}

function chainageToDecimal(value) {
  if (value === null || value === undefined || value === "") return 0;

  const text = String(value).trim();

  if (!text) return 0;

  if (text.includes("+")) {
    const [kmPart, metrePart] = text.split("+");
    const km = Number(kmPart || 0);
    const metres = Number(metrePart || 0);

    if (Number.isFinite(km) && Number.isFinite(metres)) {
      return km + metres / 1000;
    }
  }

  const number = Number(text.replace(/,/g, ""));

  return Number.isFinite(number) ? number : 0;
}
function normalizeRoadCode(value) {
  return String(value || "").trim();
}

function normalizeActivityCode(value) {
  const text = String(value || "").trim();

  if (!text) return "";

  return text.replace(/\s+/g, "").replace(/\./g, "-");
}
function looksLikeActivityCode(value) {
  const text = normalizeActivityCode(value);
  return /^\d{2}-\d{2}-\d{3}[A-Za-z0-9]*$/.test(text);
}

async function getOrCreateWorkplanId(connection, financialYear, region, title, createdBy) {
  const [existing] = await connection.query(
    `
      SELECT id
      FROM annual_workplans
      WHERE financial_year = ? AND region = ?
      LIMIT 1
    `,
    [financialYear, region]
  );

  if (existing.length > 0) {
    return existing[0].id;
  }

  const [created] = await connection.query(
    `
      INSERT INTO annual_workplans (
        financial_year,
        region,
        title,
        created_by
      )
      VALUES (?, ?, ?, ?)
    `,
    [
      financialYear,
      region,
      title || `${region} Annual Roads Workplan ${financialYear}`,
      createdBy || null,
    ]
  );

  return created.insertId;
}

async function upsertRoad(connection, road) {
  const roadCode = normalizeRoadCode(road.road_code);
  const roadName = String(road.road_name || "").trim();
  const town = String(road.town || road.region || "Unknown").trim();
  const region = String(road.region || "Coast").trim();

  if (!roadCode) {
    throw new Error("Cannot save road without road_code");
  }

  if (!roadName) {
    throw new Error(`Cannot save road ${roadCode} without road_name`);
  }

  const [result] = await connection.query(
    `
      INSERT INTO roads (
        road_code,
        region,
        town,
        road_name,
        surface_type,
        condition_status,
        road_length_km
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        id = LAST_INSERT_ID(id),
        region = VALUES(region),
        surface_type = VALUES(surface_type),
        condition_status = VALUES(condition_status),
        road_length_km = VALUES(road_length_km)
    `,
    [
      roadCode,
      region,
      town,
      roadName,
      road.surface_type || null,
      road.condition_status || null,
      road.road_length_km || null,
    ]
  );

  return result.insertId;
}

async function upsertActivity(connection, activity) {
  const activityCode = normalizeActivityCode(activity.code);

  if (!activityCode) {
    throw new Error("Cannot save activity without code");
  }

  const [result] = await connection.query(
    `
      INSERT INTO activities (
        code,
        name,
        unit,
        work_category,
        work_description
      )
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        id = LAST_INSERT_ID(id),
        name = VALUES(name),
        unit = COALESCE(VALUES(unit), unit),
        work_category = COALESCE(VALUES(work_category), work_category),
        work_description = COALESCE(VALUES(work_description), work_description)
    `,
    [
      activityCode,
      activity.name,
      activity.unit || null,
      activity.work_category || null,
      activity.work_description || null,
    ]
  );

  return result.insertId;
}

async function saveActivityRateIfClean(connection, rate, rateConflicts) {
  const [existing] = await connection.query(
    `
      SELECT unit_rate, direct_cost
      FROM activity_rates
      WHERE activity_id = ?
        AND financial_year = ?
        AND region = ?
      LIMIT 1
    `,
    [rate.activity_id, rate.financial_year, rate.region]
  );

  if (existing.length > 0) {
    const oldRate = Number(existing[0].unit_rate);
    const newRate = Number(rate.unit_rate);

    if (Math.abs(oldRate - newRate) > 0.01) {
      rateConflicts.push({
        activity_code: rate.activity_code,
        activity_name: rate.activity_name,
        existing_rate: oldRate,
        new_rate: newRate,
      });
    }

    await connection.query(
      `
        UPDATE activity_rates
        SET
          direct_cost = ?,
          unit_rate = ?,
          source = ?,
          notes = ?,
          is_active = 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE activity_id = ?
          AND financial_year = ?
          AND region = ?
      `,
      [
        rate.direct_cost || null,
        rate.unit_rate,
        rate.source || "KRB 2025",
        rate.notes || "Imported from KRB Coast Region rate schedule",
        rate.activity_id,
        rate.financial_year,
        rate.region,
      ]
    );

    return;
  }

  await connection.query(
    `
      INSERT INTO activity_rates (
        activity_id,
        financial_year,
        region,
        unit_rate,
        direct_cost,
        source,
        notes,
        is_active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `,
    [
      rate.activity_id,
      rate.financial_year,
      rate.region,
      rate.unit_rate,
      rate.direct_cost || null,
      rate.source || "KRB 2025",
      rate.notes || "Imported from KRB Coast Region rate schedule",
    ]
  );
}
router.post("/import-arwp", upload.single("file"), async (req, res) => {
  let connection;

  try {
    if (!req.file) {
      return res.status(400).json({
        message: "Please upload an Excel file using the field name 'file'",
      });
    }

    const financialYear = normalizeFinancialYear(
      req.body.financial_year || "2025/26"
    );

    const region = req.body.region || "Coast";
    const title =
      req.body.title || `${region} Annual Roads Workplan ${financialYear}`;

    const arwpSheetName = req.body.arwp_sheet || "ARWP FY 2025-2026";
    const packagesSheetName = req.body.packages_sheet || "PACKAGES";

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const arwpSheet = workbook.getWorksheet(arwpSheetName);
    const packagesSheet = workbook.getWorksheet(packagesSheetName);

    if (!arwpSheet) {
      return res.status(400).json({
        message: `Sheet '${arwpSheetName}' was not found in the workbook`,
      });
    }

    if (!packagesSheet) {
      return res.status(400).json({
        message: `Sheet '${packagesSheetName}' was not found in the workbook`,
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const createdBy = req.user?.id || null;

    const workplanId = await getOrCreateWorkplanId(
      connection,
      financialYear,
      region,
      title,
      createdBy
    );

    const packageMap = new Map();

    packagesSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const roadCode = normalizeRoadCode(getCellText(row, 2));
      const roadName = getCellText(row, 3);

      if (!roadCode || !roadName) return;

      packageMap.set(roadCode, {
        town: getCellText(row, 1) || null,
        road_code: roadCode,
        road_name: roadName,
        surface_type: getCellText(row, 4) || null,
        condition_status: getCellText(row, 5) || null,
        road_length_km: getCellNumber(row, 6),
        budget: getCellNumber(row, 7),
        lot_no: getCellText(row, 8) || null,
        category: getCellText(row, 9) || null,
      });
    });

    let currentRoad = null;

    let roadsCreatedOrUpdated = 0;
    let activitiesCreatedOrUpdated = 0;
    let ratesInserted = 0;
    let linesInsertedOrUpdated = 0;
    let skippedRows = 0;

    const rateConflicts = [];

    let arwpHeaderRow = 0;

for (let rowNumber = 1; rowNumber <= arwpSheet.rowCount; rowNumber++) {
  const row = arwpSheet.getRow(rowNumber);

  const col1 = getCellText(row, 1).toLowerCase();
  const col6 = getCellText(row, 6).toLowerCase();

  if (col1 === "road code" && col6 === "activity code") {
    arwpHeaderRow = rowNumber;
    break;
  }
}

const startRow = arwpHeaderRow > 0 ? arwpHeaderRow + 1 : 1;

for (let rowNumber = startRow; rowNumber <= arwpSheet.rowCount; rowNumber++) {
  const row = arwpSheet.getRow(rowNumber);

  const possibleRoadCode = normalizeRoadCode(getCellText(row, 1));
  const possibleRoadName = getCellText(row, 2);
  const possibleSurfaceType = getCellText(row, 3);
  const possibleCondition = getCellText(row, 4);
  const possibleRoadLength = getCellNumber(row, 5);

  const lowerRoadCode = possibleRoadCode.toLowerCase();

  const isRealRoadRow =
    possibleRoadCode &&
    possibleRoadName &&
    lowerRoadCode !== "road code" &&
    !lowerRoadCode.startsWith("region:") &&
    !lowerRoadCode.startsWith("district:") &&
    !lowerRoadCode.includes("maintenance") &&
    !lowerRoadCode.includes("subtotal") &&
    !lowerRoadCode.includes("total");

  if (isRealRoadRow) {
    currentRoad = {
      road_code: possibleRoadCode,
      road_name: possibleRoadName,
      surface_type: possibleSurfaceType || null,
      condition_status: possibleCondition || null,
      road_length_km: possibleRoadLength,
    };
  }

  const rawActivityCode = getCellText(row, 6);
  const activityCode = normalizeActivityCode(rawActivityCode);
  const activityName = getCellText(row, 7);
  const method = getCellText(row, 8);
  const unit = getCellText(row, 9);

  if (
    !currentRoad ||
    !activityCode ||
    !activityName ||
    !looksLikeActivityCode(rawActivityCode)
  ) {
    skippedRows++;
    continue;
  }

  const plannedQuantity = getCellNumber(row, 10) || 0;
  const fromChainage = chainageToDecimal(getCellText(row, 11));
  const toChainage = chainageToDecimal(getCellText(row, 12));

  const rateWithoutVat = getCellNumber(row, 14);
  const rateWithVat = getCellNumber(row, 15);

  const plannedRate = rateWithVat || rateWithoutVat || 0;

  const packageInfo = packageMap.get(currentRoad.road_code);

  const roadId = await upsertRoad(connection, {
    road_code: currentRoad.road_code,
    region,
    town: packageInfo?.town || region,
    road_name: currentRoad.road_name,
    surface_type: currentRoad.surface_type || packageInfo?.surface_type || null,
    condition_status:
      currentRoad.condition_status || packageInfo?.condition_status || null,
    road_length_km:
      currentRoad.road_length_km || packageInfo?.road_length_km || null,
  });

  roadsCreatedOrUpdated++;

  const activityId = await upsertActivity(connection, {
    code: activityCode,
    name: activityName,
    unit,
  });

  activitiesCreatedOrUpdated++;

  const beforeConflictCount = rateConflicts.length;

  await saveActivityRateIfClean(
    connection,
    {
      activity_id: activityId,
      activity_code: activityCode,
      activity_name: activityName,
      financial_year: financialYear,
      region,
      unit_rate: plannedRate,
    },
    rateConflicts
  );

  if (rateConflicts.length === beforeConflictCount) {
    ratesInserted++;
  }

  await connection.query(
    `
      INSERT INTO annual_workplan_lines (
        workplan_id,
        project_id,
        road_id,
        activity_id,
        financial_year,
        lot_no,
        category,
        method,
        chainage_start,
        chainage_end,
        planned_quantity,
        planned_rate,
        remarks,
        status
      )
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
      ON DUPLICATE KEY UPDATE
        lot_no = VALUES(lot_no),
        category = VALUES(category),
        method = VALUES(method),
        planned_quantity = VALUES(planned_quantity),
        planned_rate = VALUES(planned_rate),
        remarks = VALUES(remarks),
        status = 'draft'
    `,
    [
      workplanId,
      roadId,
      activityId,
      financialYear,
      packageInfo?.lot_no || null,
      packageInfo?.category || null,
      method || null,
      fromChainage,
      toChainage,
      plannedQuantity,
      plannedRate,
      `Imported from ${arwpSheetName}, row ${rowNumber}`,
    ]
  );

  linesInsertedOrUpdated++;
}

    await connection.commit();

    fs.unlink(req.file.path, () => {});

    res.status(201).json({
      message: "ARWP Excel imported successfully",
      workplan_id: workplanId,
      financial_year: financialYear,
      region,
      summary: {
        roads_created_or_updated: roadsCreatedOrUpdated,
        activities_created_or_updated: activitiesCreatedOrUpdated,
        rates_checked_or_inserted: ratesInserted,
        workplan_lines_inserted_or_updated: linesInsertedOrUpdated,
        skipped_rows: skippedRows,
        rate_conflicts: rateConflicts.length,
      },
      rate_conflicts: rateConflicts.slice(0, 20),
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }

    console.error("Error importing ARWP Excel:", error);

    res.status(500).json({
      message: "Failed to import ARWP Excel",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.post("/import-krb-rates-excel", upload.single("file"), async (req, res) => {
  let connection;

  try {
    if (!req.file) {
      return res.status(400).json({
        message: "Please upload the KRB rates Excel file using the field name 'file'",
      });
    }

    const financialYear = normalizeFinancialYear(
      req.body.financial_year || "2025/26"
    );

    const region = req.body.region || "Coast";
    const sheetName = req.body.sheet || "KRB_Rates_2025_Coast";

    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return res.status(400).json({
        message: `Sheet '${sheetName}' was not found in the workbook`,
        available_sheets: workbook.SheetNames,
      });
    }

    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
      raw: false,
    });

    connection = await db.getConnection();
    await connection.beginTransaction();

    let activitiesImported = 0;
    let ratesImported = 0;
    let skippedRows = 0;
    const rateConflicts = [];

    for (const row of rows) {
      const workCategory = String(row["Work Category"] || "").trim();
      const code = normalizeActivityCode(row["Code"]);
      const workItem = String(row["Work Item"] || "").trim();
      const workDescription = String(row["Work Description"] || "").trim();
      const unit = String(row["Unit"] || "").trim();

      const directCost = Number(
        String(row["Direct Cost"] || "")
          .replace(/,/g, "")
          .replace(/[^\d.-]/g, "")
      );

      const unitRate = Number(
        String(row["Unit Rate"] || "")
          .replace(/,/g, "")
          .replace(/[^\d.-]/g, "")
      );

      if (
        !code ||
        !workItem ||
        !looksLikeActivityCode(code) ||
        !Number.isFinite(unitRate)
      ) {
        skippedRows++;
        continue;
      }

      const activityId = await upsertActivity(connection, {
        code,
        name: workItem,
        unit,
        work_category: workCategory,
        work_description: workDescription,
      });

      activitiesImported++;

      await saveActivityRateIfClean(
        connection,
        {
          activity_id: activityId,
          activity_code: code,
          activity_name: workItem,
          financial_year: financialYear,
          region,
          direct_cost: Number.isFinite(directCost) ? directCost : null,
          unit_rate: unitRate,
          source: "KRB 2025",
          notes: "Imported from cleaned KRB Coast Region rates workbook",
        },
        rateConflicts
      );

      ratesImported++;
    }

    await connection.commit();

    fs.unlink(req.file.path, () => {});

    res.status(201).json({
      message: "KRB rates imported successfully",
      financial_year: financialYear,
      region,
      summary: {
        activities_imported_or_updated: activitiesImported,
        rates_imported_or_updated: ratesImported,
        skipped_rows: skippedRows,
        rate_conflicts: rateConflicts.length,
      },
      rate_conflicts: rateConflicts.slice(0, 20),
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }

    console.error("Error importing KRB rates:", error);

    res.status(500).json({
      message: "Failed to import KRB rates",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

module.exports = router;