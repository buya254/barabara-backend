const express = require("express");
const router = express.Router();

const multer = require("multer");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

const {
  appendTextLog,
} = require("../utils/textLogger");

const uploadDir = path.join(__dirname, "../uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: uploadDir });

router.use(authenticateJWT);

function normalizeFYForCompare(value) {
  const text = String(value || "").trim();

  if (/^\d{4}\/\d{2}$/.test(text)) {
    return text;
  }

  if (/^\d{4}-\d{2}$/.test(text)) {
    return `${text.slice(0, 4)}/${text.slice(-2)}`;
  }

  if (/^\d{4}-\d{4}$/.test(text)) {
    return `${text.slice(0, 4)}/${text.slice(-2)}`;
  }

  return text;
}

async function handleActiveWorkplanByRegion(req, res) {
  try {
    const rawFY = req.query.financial_year;
    const rawRegion = req.query.region;

    if (!rawFY || !rawRegion) {
      return res.status(400).json({
        message: "financial_year and region are required",
      });
    }

    const financialYear = normalizeFYForCompare(rawFY);
    const region = String(rawRegion || "").trim();

    const [rows] = await db.query(
      `
        SELECT *
        FROM annual_workplans
        WHERE REPLACE(financial_year, '-', '/') = REPLACE(?, '-', '/')
          AND LOWER(TRIM(region)) = LOWER(TRIM(?))
        ORDER BY id DESC
        LIMIT 1
      `,
      [financialYear, region]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: `No annual workplan found for ${financialYear} and ${region}`,
      });
    }

    return res.json(rows[0]);
  } catch (error) {
    console.error("Error fetching active regional ARWP:", error);
    return res.status(500).json({
      message: "Failed to fetch active regional ARWP",
      error: error.message,
    });
  }
}

// Support both old and new frontend URLs.
router.get("/active", handleActiveWorkplanByRegion);
router.get("/active/by-region", handleActiveWorkplanByRegion);

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
          awl.is_ignored,
          awl.line_type,
          awl.ignored_reason,
          awl.ignored_by,
          awl.ignored_at,    

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

  return text
    .replace(/\s+/g, "")
    .replace(/-/g, ".")
    .replace(/\.+/g, ".");
}

function looksLikeActivityCode(value) {
  const text = normalizeActivityCode(value);
  return /^\d{2}\.\d{2}\.\d{3}[A-Za-z0-9]*$/.test(text);
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
        region = COALESCE(VALUES(region), region),
        town = COALESCE(NULLIF(VALUES(town), ''), town),
        road_name = COALESCE(NULLIF(VALUES(road_name), ''), road_name),
        surface_type = COALESCE(VALUES(surface_type), surface_type),
        condition_status = COALESCE(VALUES(condition_status), condition_status),
        road_length_km = COALESCE(VALUES(road_length_km), road_length_km)
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

    appendTextLog("admin-utilities", {
  event: "ARWP_REVISED_WORKBOOK_IMPORTED",

  user_id: req.user?.id || null,
  username:
    req.user?.username ||
    req.user?.email ||
    null,

  role: req.user?.role || null,

  workplan_id: workplanId,
  financial_year: financialYear,
  region,

  roads_processed:
    roadsCreatedOrUpdated,

  activities_processed:
    activitiesCreatedOrUpdated,

  lines_imported_or_updated:
    linesInsertedOrUpdated,

  skipped_rows: skippedRows,
  rate_conflicts: rateConflicts.length,

  original_filename:
    req.file?.originalname || null,

  ip_address:
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    null,
});

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
/**
 * GET /api/annual-workplans/:id/lots
 * Shows ARWP grouped by lot/category for RE linking.
 */
router.get("/:id/lots", async (req, res) => {
  try {
    const { id } = req.params;

   const [rows] = await db.query(
  `
    SELECT
      awl.workplan_id,
      awl.lot_no,
      awl.category,

      COUNT(*) AS line_count,
      COUNT(DISTINCT awl.road_id) AS road_count,

      SUM(CASE WHEN awl.is_ignored = 1 THEN 1 ELSE 0 END) AS ignored_line_count,
      SUM(CASE WHEN awl.is_ignored = 0 THEN 1 ELSE 0 END) AS active_line_count,

      COALESCE(
        SUM(
          CASE 
            WHEN awl.is_ignored = 0 THEN awl.planned_amount 
            ELSE 0 
          END
        ),
        0
      ) AS active_planned_amount,

      awpl.project_id AS linked_project_id,
      p.project_number AS linked_project_number,
      p.project_name AS linked_project_name,

      bl.id AS boq_lot_id,
      COALESCE(bl.is_locked, 0) AS boq_locked,
      bl.locked_contract_sum AS boq_locked_contract_sum,
      bl.locked_at AS boq_locked_at,
      bl.locked_by AS boq_locked_by

    FROM annual_workplan_lines awl

    LEFT JOIN annual_workplan_project_lots awpl
      ON awpl.workplan_id = awl.workplan_id
      AND awpl.lot_no = awl.lot_no
      AND awpl.category = awl.category

    LEFT JOIN projects p
      ON p.id = awpl.project_id

    LEFT JOIN boq_lots bl
      ON bl.workplan_id = awl.workplan_id
      AND bl.lot_no = awl.lot_no
      AND bl.category = awl.category
      AND bl.project_id = awpl.project_id

    WHERE awl.workplan_id = ?
      AND awl.status <> 'cancelled'
      AND awl.lot_no IS NOT NULL
      AND awl.category IS NOT NULL

    GROUP BY
      awl.workplan_id,
      awl.lot_no,
      awl.category,
      awpl.project_id,
      p.project_number,
      p.project_name,
      bl.id,
      bl.is_locked,
      bl.locked_contract_sum,
      bl.locked_at,
      bl.locked_by

    ORDER BY
      CAST(awl.lot_no AS UNSIGNED),
      awl.lot_no,
      awl.category
  `,
  [id]
); 

    res.json(rows);
  } catch (error) {
    console.error("Error fetching ARWP lots:", error);
    res.status(500).json({
      message: "Failed to fetch ARWP lots",
      error: error.message,
    });
  }
});

/**
 * POST /api/annual-workplans/seal-boq-copy
 * Copies the currently saved ARWP lot/category lines into BOQ tables.
 * This does NOT change annual_workplan_lines.
 */
router.post("/seal-boq-copy", async (req, res) => {
  let connection;

  try {
    const { workplan_id, project_id, lot_no, category, notes } = req.body;

    if (!workplan_id || !project_id || !lot_no || !category) {
      return res.status(400).json({
        message: "workplan_id, project_id, lot_no, and category are required",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [linkedRows] = await connection.query(
      `
      SELECT
        awpl.workplan_id,
        awpl.project_id,
        awpl.lot_no,
        awpl.category,
        p.project_number,
        p.project_name
      FROM annual_workplan_project_lots awpl
      LEFT JOIN projects p
        ON p.id = awpl.project_id
      WHERE awpl.workplan_id = ?
        AND awpl.project_id = ?
        AND awpl.lot_no = ?
        AND awpl.category = ?
      LIMIT 1
      `,
      [workplan_id, project_id, lot_no, category]
    );

    if (linkedRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "This ARWP lot/category is not linked to this project.",
      });
    }

    const [existingRows] = await connection.query(
      `
      SELECT id, is_locked
      FROM boq_lots
      WHERE workplan_id = ?
        AND project_id = ?
        AND lot_no = ?
        AND category = ?
      LIMIT 1
      FOR UPDATE
      `,
      [workplan_id, project_id, lot_no, category]
    );

    if (
      existingRows.length > 0 &&
      Number(existingRows[0].is_locked || 0) === 1
    ) {
      await connection.rollback();
      return res.status(409).json({
        message: "This ARWP lot/category has already been locked into BOQ.",
        boq_lot_id: existingRows[0].id,
      });
    }

    const [sumRows] = await connection.query(
      `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN awl.is_ignored = 0 THEN awl.planned_amount
              ELSE 0
            END
          ),
          0
        ) AS active_arwp_amount,
        COUNT(*) AS active_line_count
      FROM annual_workplan_lines awl
      WHERE awl.workplan_id = ?
        AND awl.lot_no = ?
        AND awl.category = ?
        AND awl.status <> 'cancelled'
        AND awl.is_ignored = 0
      `,
      [workplan_id, lot_no, category]
    );

    const activeArwpAmount = Number(sumRows[0]?.active_arwp_amount || 0);
    const activeLineCount = Number(sumRows[0]?.active_line_count || 0);

    if (!Number.isFinite(activeArwpAmount) || activeArwpAmount <= 0) {
      await connection.rollback();
      return res.status(400).json({
        message: "Cannot lock BOQ because the active ARWP amount is zero.",
      });
    }

    if (activeLineCount <= 0) {
      await connection.rollback();
      return res.status(400).json({
        message: "Cannot lock BOQ because there are no active ARWP lines.",
      });
    }

    const [createdLot] = await connection.query(
      `
      INSERT INTO boq_lots
        (
          workplan_id,
          project_id,
          lot_no,
          category,
          locked_contract_sum,
          source_arwp_amount,
          is_locked,
          locked_by,
          notes
        )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `,
      [
        workplan_id,
        project_id,
        lot_no,
        category,
        activeArwpAmount,
        activeArwpAmount,
        req.user?.id || null,
        notes || "Locked from adjusted ARWP View/Edit Lines",
      ]
    );

    const boqLotId = createdLot.insertId;

    const [copiedLines] = await connection.query(
      `
      INSERT INTO boq_lines
        (
          boq_lot_id,
          source_arwp_line_id,
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
          quantity,
          rate,
          remarks,
          status,
          line_origin,
          created_by,
          updated_by
        )
      SELECT
        ? AS boq_lot_id,
        awl.id AS source_arwp_line_id,
        awl.workplan_id,
        ? AS project_id,
        awl.road_id,
        awl.activity_id,
        awl.financial_year,
        awl.lot_no,
        awl.category,
        awl.method,
        awl.chainage_start,
        awl.chainage_end,
        awl.planned_quantity AS quantity,
        awl.planned_rate AS rate,
        awl.remarks,
        'active' AS status,
        'SEALED_ARWP_COPY' AS line_origin,
        ? AS created_by,
        ? AS updated_by
      FROM annual_workplan_lines awl
      WHERE awl.workplan_id = ?
        AND awl.lot_no = ?
        AND awl.category = ?
        AND awl.status <> 'cancelled'
        AND awl.is_ignored = 0
      ORDER BY awl.road_id, awl.activity_id, awl.id
      `,
      [
        boqLotId,
        project_id,
        req.user?.id || null,
        req.user?.id || null,
        workplan_id,
        lot_no,
        category,
      ]
    );

    await connection.commit();

    return res.status(201).json({
      message: "ARWP locked and BOQ copy created successfully.",
      boq_lot_id: boqLotId,
      locked_contract_sum: activeArwpAmount,
      copied_lines: copiedLines.affectedRows,
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    console.error("Error sealing ARWP into BOQ:", error);

    return res.status(500).json({
      message: "Failed to lock ARWP into BOQ copy.",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * POST /api/annual-workplans/link-lot-to-project
 * Links one ARWP lot/category to a project managed by the Projects module.
 */
router.post("/link-lot-to-project", async (req, res) => {
  let connection;

  try {
    const { workplan_id, lot_no, category, project_id } = req.body;

    if (!workplan_id || !lot_no || !category || !project_id) {
      return res.status(400).json({
        message: "workplan_id, lot_no, category, and project_id are required",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [projectRows] = await connection.query(
      `
        SELECT id, project_number, project_name, region, financial_year
        FROM projects
        WHERE id = ?
        LIMIT 1
      `,
      [project_id]
    );

    if (projectRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "Project not found",
      });
    }

    const project = projectRows[0];

    const [lineRows] = await connection.query(
      `
        SELECT COUNT(*) AS total_lines
        FROM annual_workplan_lines
        WHERE workplan_id = ?
          AND lot_no = ?
          AND category = ?
          AND status <> 'cancelled'
          AND is_ignored = 0
      `,
      [workplan_id, lot_no, category]
    );

    if (Number(lineRows[0].total_lines) === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "No active ARWP lines found for this lot/category",
      });
    }

    await connection.query(
      `
        INSERT INTO annual_workplan_project_lots (
          workplan_id,
          lot_no,
          category,
          project_id
        )
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          project_id = VALUES(project_id),
          updated_at = CURRENT_TIMESTAMP
      `,
      [workplan_id, lot_no, category, project_id]
    );

    const [updatedLines] = await connection.query(
      `
        UPDATE annual_workplan_lines
        SET project_id = ?
        WHERE workplan_id = ?
          AND lot_no = ?
          AND category = ?
          AND status <> 'cancelled'
          AND is_ignored = 0
      `,
      [project_id, workplan_id, lot_no, category]
    );

    const [insertedRoads] = await connection.query(
      `
        INSERT INTO project_roads (
          project_id,
          road_id,
          project_name,
          chainage_from,
          chainage_to
        )
        SELECT
          ? AS project_id,
          awl.road_id,
          ? AS project_name,
          CAST(MIN(awl.chainage_start) AS CHAR) AS chainage_from,
          CAST(MAX(awl.chainage_end) AS CHAR) AS chainage_to
        FROM annual_workplan_lines awl
        WHERE awl.workplan_id = ?
          AND awl.lot_no = ?
          AND awl.category = ?
          AND awl.status <> 'cancelled'
          AND awl.is_ignored = 0
        GROUP BY awl.road_id
        ON DUPLICATE KEY UPDATE
          project_name = VALUES(project_name),
          chainage_from = VALUES(chainage_from),
          chainage_to = VALUES(chainage_to)
      `,
      [project_id, project.project_name, workplan_id, lot_no, category]
    );
        // Create/fetch contract for this project.
    // This is the proper package container used by contract_roads.
    await connection.query(
      `
        INSERT INTO contracts (
          contract_name,
          project_id,
          financial_year
        )
        SELECT
          ? AS contract_name,
          ? AS project_id,
          ? AS financial_year
        WHERE NOT EXISTS (
          SELECT 1
          FROM contracts
          WHERE project_id = ?
        )
      `,
      [
        project.project_number,
        project_id,
        project.financial_year,
        project_id,
      ]
    );

    const [contractRows] = await connection.query(
      `
        SELECT id
        FROM contracts
        WHERE project_id = ?
        ORDER BY id DESC
        LIMIT 1
      `,
      [project_id]
    );

    if (contractRows.length === 0) {
      await connection.rollback();
      return res.status(500).json({
        message: "Could not create or find contract for this project",
      });
    }

    const contractId = contractRows[0].id;

    // Insert distinct ARWP roads into contract_roads.
    // This feeds Manage Projects → View Roads.
    const [contractRoads] = await connection.query(
      `
        INSERT INTO contract_roads (
          contract_id,
          road_id,
          is_active
        )
        SELECT DISTINCT
          ? AS contract_id,
          awl.road_id,
          1 AS is_active
        FROM annual_workplan_lines awl
        WHERE awl.workplan_id = ?
          AND awl.lot_no = ?
          AND awl.category = ?
          AND awl.status <> 'cancelled'
          AND awl.is_ignored = 0
          AND awl.road_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM contract_roads cr
            WHERE cr.contract_id = ?
              AND cr.road_id = awl.road_id
          )
      `,
      [contractId, workplan_id, lot_no, category, contractId]
    );

    const [rateVariationRows] = await connection.query(
      `
        SELECT 
          awl.activity_id,
          COUNT(DISTINCT awl.planned_rate) AS distinct_rates
        FROM annual_workplan_lines awl
        WHERE awl.workplan_id = ?
          AND awl.lot_no = ?
          AND awl.category = ?
          AND awl.status <> 'cancelled'
          AND awl.is_ignored = 0
        GROUP BY awl.activity_id
        HAVING COUNT(DISTINCT awl.planned_rate) > 1
      `,
      [workplan_id, lot_no, category]
    );

    const [contractRates] = await connection.query(
      `
        INSERT INTO contract_activity_rates (
          project_id,
          activity_id,
          financial_year,
          region,
          contractor_rate,
          krb_rate_at_tender,
          source,
          notes
        )
        SELECT
          ? AS project_id,
          awl.activity_id,
          awl.financial_year,
          aw.region,
          MAX(awl.planned_rate) AS contractor_rate,
          MAX(ar.unit_rate) AS krb_rate_at_tender,
          'Successful Bidder ARWP' AS source,
          CONCAT(
            'Copied from ARWP workplan ',
            awl.workplan_id,
            ', lot ',
            awl.lot_no,
            ', category ',
            awl.category
          ) AS notes
        FROM annual_workplan_lines awl
        INNER JOIN annual_workplans aw
          ON aw.id = awl.workplan_id
        LEFT JOIN activity_rates ar
          ON ar.activity_id = awl.activity_id
          AND ar.financial_year = awl.financial_year
          AND ar.region = aw.region
        WHERE awl.workplan_id = ?
          AND awl.lot_no = ?
          AND awl.category = ?
          AND awl.status <> 'cancelled'
          AND awl.is_ignored = 0
        GROUP BY
          awl.activity_id,
          awl.financial_year,
          aw.region,
          awl.workplan_id,
          awl.lot_no,
          awl.category
        ON DUPLICATE KEY UPDATE
          contractor_rate = VALUES(contractor_rate),
          krb_rate_at_tender = VALUES(krb_rate_at_tender),
          source = VALUES(source),
          notes = VALUES(notes),
          updated_at = CURRENT_TIMESTAMP
      `,
      [project_id, workplan_id, lot_no, category]
    );

    await connection.commit();

    res.json({
      message: "ARWP lot linked to project successfully",
      workplan_id,
      lot_no,
      category,
      project_id,
      project_name: project.project_name,
      summary: {
        lines_updated: updatedLines.affectedRows,
        project_roads_inserted_or_updated: insertedRoads.affectedRows,
        contract_id: contractId,
        contract_roads_inserted: contractRoads.affectedRows,
        contract_rates_inserted_or_updated: contractRates.affectedRows,
        rate_variation_warnings: rateVariationRows.length,
      },
      rate_variations: rateVariationRows,
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    console.error("Error linking ARWP lot to project:", error);

    res.status(500).json({
      message: "Failed to link ARWP lot to project",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/annual-workplans/:id/unassigned-roads
 * Shows roads with ARWP lines that are missing lot/category.
 */
router.get("/:id/unassigned-roads", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
        SELECT
          awl.workplan_id,
          awl.road_id,
          r.road_code,
          r.road_name,
          r.region,
          r.town,

          COUNT(*) AS line_count,
          COALESCE(SUM(awl.planned_amount), 0) AS total_planned_amount,

          SUM(CASE WHEN awl.is_ignored = 1 THEN 1 ELSE 0 END) AS ignored_line_count,
          SUM(CASE WHEN awl.is_ignored = 0 THEN 1 ELSE 0 END) AS active_line_count,

          MIN(awl.id) AS first_line_id,
          MAX(awl.id) AS last_line_id

        FROM annual_workplan_lines awl
        INNER JOIN roads r
          ON r.id = awl.road_id

        WHERE awl.workplan_id = ?
          AND awl.status <> 'cancelled'
          AND (
            awl.lot_no IS NULL
            OR awl.category IS NULL
          )

        GROUP BY
          awl.workplan_id,
          awl.road_id,
          r.road_code,
          r.road_name,
          r.region,
          r.town

        ORDER BY
          r.town,
          r.road_code,
          r.road_name
      `,
      [id]
    );

    res.json(rows);
  } catch (error) {
    console.error("Error fetching unassigned ARWP roads:", error);
    res.status(500).json({
      message: "Failed to fetch unassigned ARWP roads",
      error: error.message,
    });
  }
});

/**
 * POST /api/annual-workplans/ignore-road
 * Marks all ARWP lines for a road as ignored/omitted.
 */
router.post("/ignore-road", async (req, res) => {
  try {
    const { workplan_id, road_id, reason } = req.body;

    if (!workplan_id || !road_id || !reason) {
      return res.status(400).json({
        message: "workplan_id, road_id, and reason are required",
      });
    }

    const ignoredBy = req.user?.id || null;

    const [result] = await db.query(
      `
        UPDATE annual_workplan_lines
        SET
          is_ignored = 1,
          ignored_reason = ?,
          ignored_by = ?,
          ignored_at = CURRENT_TIMESTAMP
        WHERE workplan_id = ?
          AND road_id = ?
          AND status <> 'cancelled'
      `,
      [reason, ignoredBy, workplan_id, road_id]
    );

    res.json({
      message: "ARWP road ignored successfully",
      workplan_id,
      road_id,
      affected_lines: result.affectedRows,
    });
  } catch (error) {
    console.error("Error ignoring ARWP road:", error);
    res.status(500).json({
      message: "Failed to ignore ARWP road",
      error: error.message,
    });
  }
});

/**
 * POST /api/annual-workplans/unignore-road
 * Restores all ignored ARWP lines for a road.
 */
router.post("/unignore-road", async (req, res) => {
  try {
    const { workplan_id, road_id } = req.body;

    if (!workplan_id || !road_id) {
      return res.status(400).json({
        message: "workplan_id and road_id are required",
      });
    }

    const [result] = await db.query(
      `
        UPDATE annual_workplan_lines
        SET
          is_ignored = 0,
          ignored_reason = NULL,
          ignored_by = NULL,
          ignored_at = NULL
        WHERE workplan_id = ?
          AND road_id = ?
          AND status <> 'cancelled'
      `,
      [workplan_id, road_id]
    );

    res.json({
      message: "ARWP road restored successfully",
      workplan_id,
      road_id,
      affected_lines: result.affectedRows,
    });
  } catch (error) {
    console.error("Error restoring ARWP road:", error);
    res.status(500).json({
      message: "Failed to restore ARWP road",
      error: error.message,
    });
  }
});

/**
 * PUT /api/annual-workplans/lines/:lineId/type
 * Classifies a line as ROAD_WORK, PRELIMINARIES, SITE_BUILDING, etc.
 */
router.put("/lines/:lineId/type", async (req, res) => {
  try {
    const { lineId } = req.params;
    const { line_type } = req.body;

    const allowedTypes = [
      "ROAD_WORK",
      "PRELIMINARIES",
      "SITE_BUILDING",
      "GENERAL_ITEM",
      "PROVISIONAL_SUM",
    ];

    if (!allowedTypes.includes(line_type)) {
      return res.status(400).json({
        message: "Invalid line_type",
        allowedTypes,
      });
    }

    const [result] = await db.query(
      `
        UPDATE annual_workplan_lines
        SET line_type = ?
        WHERE id = ?
      `,
      [line_type, lineId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Annual workplan line not found",
      });
    }

    res.json({
      message: "Line type updated successfully",
      line_id: lineId,
      line_type,
    });
  } catch (error) {
    console.error("Error updating line type:", error);
    res.status(500).json({
      message: "Failed to update line type",
      error: error.message,
    });
  }
});

function getARWPSheetName(financialYear) {
  const text = String(financialYear || "").trim();
  const match = text.match(/^(\d{4})\/(\d{2})$/);

  if (match) {
    return `ARWP FY ${match[1]}-20${match[2]}`;
  }

  return "ARWP_LINES";
}
/**
 * GET /api/annual-workplans/templates/arwp-import-template
 *
 * Downloads a blank Barabara-standard ARWP Excel template.
 * Regions should fill this template so ARWP imports remain consistent.
 */
router.get("/templates/arwp-import-template", async (req, res) => {
  try {
    const financialYear = normalizeFinancialYear(
      req.query.financial_year || "2025/26"
    );

    const region = String(req.query.region || "Coast").trim();
    const arwpSheetName = getARWPSheetName(financialYear);

    const requestedWorkplanId = Number(req.query.workplan_id || 0);
const requestedProjectId = Number(req.query.project_id || 0);

let sourceWorkplanId = requestedWorkplanId;

if (!sourceWorkplanId) {
  const [workplanRows] = await db.query(
    `
      SELECT id
      FROM annual_workplans
      WHERE REPLACE(financial_year, '-', '/') = REPLACE(?, '-', '/')
        AND LOWER(TRIM(region)) = LOWER(TRIM(?))
      ORDER BY id DESC
      LIMIT 1
    `,
    [financialYear, region]
  );

  if (workplanRows.length === 0) {
    return res.status(404).json({
      message:
        "No current ARWP was found for this financial year and region.",
    });
  }

  sourceWorkplanId = Number(workplanRows[0].id);
}

let lineSql = `
  SELECT
    awl.id,
    awl.workplan_id,
    awl.project_id,
    awl.financial_year,
    awl.lot_no,
    awl.category,
    awl.method,
    awl.chainage_start,
    awl.chainage_end,
    awl.planned_quantity,
    awl.planned_rate,
    awl.planned_amount,
    awl.remarks,

    r.road_code,
    r.road_name,
    r.region AS road_region,
    r.town,
    r.surface_type,
    r.condition_status,
    r.road_length_km,

    a.code AS activity_code,
    a.name AS activity_name,
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
    AND COALESCE(awl.is_ignored, 0) = 0
`;

const lineParams = [sourceWorkplanId];

if (requestedProjectId > 0) {
  lineSql += ` AND awl.project_id = ?`;
  lineParams.push(requestedProjectId);
}

lineSql += `
  ORDER BY
    CAST(awl.lot_no AS UNSIGNED),
    awl.lot_no,
    awl.category,
    r.road_code,
    a.code,
    awl.id
`;

const [currentLines] = await db.query(lineSql, lineParams);

if (currentLines.length === 0) {
  return res.status(404).json({
    message:
      requestedProjectId > 0
        ? "No current ARWP lines were found for this project."
        : "No current ARWP lines were found for this workplan.",
  });
}

const sourceProjectLabel =
  currentLines[0]?.project_number &&
  currentLines[0]?.project_name
    ? `${currentLines[0].project_number} - ${currentLines[0].project_name}`
    : currentLines[0]?.project_number ||
      currentLines[0]?.project_name ||
      "Regional ARWP";

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Barabara";
    workbook.created = new Date();

    // =========================
    // 1. README sheet
    // =========================
    const readme = workbook.addWorksheet("README");

    readme.columns = [
      { header: "Item", key: "item", width: 28 },
      { header: "Instruction", key: "instruction", width: 100 },
    ];

    readme.addRows([
      {
        item: "Purpose",
        instruction:
          "This workbook is pre-populated from the current Barabara ARWP. The Engineer may adjust retained roads, activities, quantities, rates, chainages and package details before Admin imports it into a new project cycle.",
      },
      {
        item: "Source Workplan ID",
        instruction: String(sourceWorkplanId),
      },
      {
        item: "Source Project",
        instruction: sourceProjectLabel,
      },
      {
        item: "Important",
        instruction:
          "Downloading and editing this workbook does not alter the current ARWP, BOQ, Work Instructions or existing project records.",
      },
      {
        item: "Financial Year",
        instruction: financialYear,
      },
      {
        item: "Region",
        instruction: region,
      },
      {
        item: "ARWP Sheet",
        instruction: `Fill the sheet named '${arwpSheetName}'. Do not rename it unless you also pass the sheet name during import.`,
      },
      {
        item: "PACKAGES Sheet",
        instruction:
          "Fill one row per road/package relationship. Every road in the ARWP sheet should appear in PACKAGES with its lot number and category.",
      },
      {
        item: "Category",
        instruction:
          "Use ROUTINE MAINTENANCE or PERIODIC MAINTENANCE for consistency.",
      },
      {
        item: "Rates",
        instruction:
          "If Rate With VAT is provided, Barabara uses it. If it is blank, Barabara uses Rate Without VAT.",
      },
      {
        item: "Amount Check",
        instruction:
          "Amount Check is for Excel checking only. Barabara calculates planned_amount from quantity × selected rate.",
      },
      {
        item: "Chainage",
        instruction:
          "Chainage may be entered as decimal kilometres such as 1.25 or in road format such as 1+250.",
      },
    ]);

    readme.getRow(1).font = { bold: true };
    readme.views = [{ state: "frozen", ySplit: 1 }];

    // =========================
    // 2. ARWP activity lines sheet
    // These column positions match the existing importer.
    // =========================
    const arwp = workbook.addWorksheet(arwpSheetName);

    arwp.columns = [
      { header: "Road Code", key: "road_code", width: 18 }, // col 1
      { header: "Road Name", key: "road_name", width: 35 }, // col 2
      { header: "Surface Type", key: "surface_type", width: 16 }, // col 3
      { header: "Condition", key: "condition", width: 16 }, // col 4
      { header: "Road Length Km", key: "road_length_km", width: 16 }, // col 5
      { header: "Activity Code", key: "activity_code", width: 18 }, // col 6
      { header: "Activity Name", key: "activity_name", width: 45 }, // col 7
      { header: "Method", key: "method", width: 18 }, // col 8
      { header: "Unit", key: "unit", width: 12 }, // col 9
      { header: "Planned Quantity", key: "planned_quantity", width: 18 }, // col 10
      { header: "Chainage Start", key: "chainage_start", width: 18 }, // col 11
      { header: "Chainage End", key: "chainage_end", width: 18 }, // col 12
      { header: "Amount Check", key: "amount_check", width: 18 }, // col 13
      { header: "Rate Without VAT", key: "rate_without_vat", width: 18 }, // col 14
      { header: "Rate With VAT", key: "rate_with_vat", width: 18 }, // col 15
      { header: "Remarks", key: "remarks", width: 35 }, // col 16
    ];

    arwp.getRow(1).font = { bold: true };
    arwp.views = [{ state: "frozen", ySplit: 1 }];

    currentLines.forEach((line) => {
      const row = arwp.addRow({
        road_code: line.road_code || "",
        road_name: line.road_name || "",
        surface_type: line.surface_type || "",
        condition: line.condition_status || "",
        road_length_km:
          Number(line.road_length_km || 0) || "",
        activity_code: line.activity_code || "",
        activity_name: line.activity_name || "",
        method: line.method || "",
        unit: line.unit || "",
        planned_quantity:
          Number(line.planned_quantity || 0),
        chainage_start: line.chainage_start ?? "",
        chainage_end: line.chainage_end ?? "",
        amount_check: "",
        rate_without_vat: "",
        rate_with_vat:
          Number(line.planned_rate || 0),
        remarks: line.remarks || "",
      });

      row.getCell(13).value = {
        formula:
          `J${row.number}*IF(` +
          `O${row.number}<>"",` +
          `O${row.number},` +
          `N${row.number})`,
      };

      row.getCell(10).numFmt = "#,##0.00";
      row.getCell(13).numFmt = "#,##0.00";
      row.getCell(14).numFmt = "#,##0.00";
      row.getCell(15).numFmt = "#,##0.00";
    });

    arwp.autoFilter = {
      from: "A1",
      to: "P1",
    };

    // =========================
    // 3. PACKAGES sheet
    // These first 9 columns match the existing packageMap importer.
    // Extra columns are for region/admin reference.
    // =========================
    const packages = workbook.addWorksheet("PACKAGES");

    packages.columns = [
      { header: "Town", key: "town", width: 22 }, // col 1
      { header: "Road Code", key: "road_code", width: 18 }, // col 2
      { header: "Road Name", key: "road_name", width: 35 }, // col 3
      { header: "Surface Type", key: "surface_type", width: 16 }, // col 4
      { header: "Condition Status", key: "condition_status", width: 18 }, // col 5
      { header: "Road Length Km", key: "road_length_km", width: 16 }, // col 6
      { header: "Budget", key: "budget", width: 18 }, // col 7
      { header: "Lot No", key: "lot_no", width: 12 }, // col 8
      { header: "Category", key: "category", width: 24 }, // col 9
      { header: "Contract Number", key: "contract_number", width: 32 },
      { header: "Package Description", key: "package_description", width: 45 },
    ];

    packages.getRow(1).font = { bold: true };
    packages.views = [{ state: "frozen", ySplit: 1 }];

    const exportedPackages = new Map();

    currentLines.forEach((line) => {
      const key = [
        line.road_code || "",
        line.lot_no || "",
        line.category || "",
      ].join("__");

      if (!exportedPackages.has(key)) {
        exportedPackages.set(key, {
          town:
            line.town ||
            line.road_region ||
            region,

          road_code: line.road_code || "",
          road_name: line.road_name || "",
          surface_type: line.surface_type || "",
          condition_status:
            line.condition_status || "",

          road_length_km:
            Number(line.road_length_km || 0) || "",

          budget: 0,
          lot_no: line.lot_no || "",
          category: line.category || "",
          contract_number:
            line.project_number || "",
          package_description:
            line.project_name || "",
        });
      }

      const packageRow = exportedPackages.get(key);

      packageRow.budget += Number(
        line.planned_amount || 0
      );
    });

    for (const packageData of exportedPackages.values()) {
      const row = packages.addRow(packageData);

      row.getCell(7).numFmt = "#,##0.00";

      row.getCell(9).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [
          '"ROUTINE MAINTENANCE,PERIODIC MAINTENANCE"',
        ],
      };
    }

    packages.autoFilter = {
      from: "A1",
      to: "K1",
    };

    // Style headers
    [readme, arwp, packages].forEach((sheet) => {
      sheet.getRow(1).eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE6E6E6" },
        };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FF999999" } },
        };
      });
    });

    const safeRegion = region.replace(/[^a-z0-9]+/gi, "_");
    const safeFY = financialYear.replace(/[^a-z0-9]+/gi, "_");

    const safeProject = String(
      currentLines[0]?.project_number ||
        currentLines[0]?.project_name ||
        "Regional"
    )
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "");

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ARWP_Template_${safeProject}_${safeFY}.xlsx"`
    );

    await workbook.xlsx.write(res);

      appendTextLog("admin-utilities", {
        event:
          requestedProjectId > 0
            ? "ARWP_PROJECT_TEMPLATE_DOWNLOADED"
            : "ARWP_REGIONAL_ROLLOVER_DOWNLOADED",

        user_id: req.user?.id || null,
        username:
          req.user?.username ||
          req.user?.email ||
          null,

        role: req.user?.role || null,

        workplan_id: sourceWorkplanId,
        project_id:
          requestedProjectId > 0
            ? requestedProjectId
            : null,

        financial_year: financialYear,
        region,
        exported_lines: currentLines.length,

        ip_address:
          req.headers["x-forwarded-for"] ||
          req.socket?.remoteAddress ||
          null,
      });

      res.end();

  } catch (error) {
    console.error("Error generating ARWP template:", error);

    res.status(500).json({
      message: "Failed to generate ARWP template",
      error: error.message,
    });
  }
});
module.exports = router;