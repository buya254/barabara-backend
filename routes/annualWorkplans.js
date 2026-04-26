const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

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

          a.activity_code,
          a.activity_description,
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
          a.activity_code
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
        a.activity_code,
        a.activity_description,
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
      ORDER BY ar.financial_year DESC, ar.region, a.activity_code
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

module.exports = router;