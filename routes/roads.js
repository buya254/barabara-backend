const express = require("express");
const ExcelJS = require("exceljs");
const db = require("../db");

const router = express.Router();

/**
 * GET /api/roads/paged?page=1&limit=10&road_code=&road_name=&region=&town=
 */
router.get("/paged", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "10", 10), 1);
    const offset = (page - 1) * limit;

    const road_code = (req.query.road_code || "").toString().trim();
    const road_name = (req.query.road_name || "").toString().trim();
    const road_length_km = (req.query.road_length_km || "").toString().trim();
    const region = (req.query.region || "").toString().trim();
    const town = (req.query.town || "").toString().trim();

    function addLengthFilter(whereObj, valsArr, raw) {
      const v = String(raw || "").trim();
      if (!v) return;

      // Case A: manual range "min-max"
      if (v.includes("-")) {
        const [a, b] = v.split("-").map((x) => x.trim());
        const min = Number(a);
        const max = Number(b);
        if (!Number.isNaN(min) && !Number.isNaN(max)) {
          whereObj.where += " AND road_length_km >= ? AND road_length_km <= ?";
          valsArr.push(min, max);
        }
        return;
      }

      // Case B: bucket/prefix style
      const num = Number(v);
      if (Number.isNaN(num)) return;

      // how many decimals were typed?
      const parts = v.split(".");
      const decimals = parts.length === 2 ? parts[1].length : 0;

      let lower = num;
      let upper;

      if (decimals === 0) {
        // "1" means 1.000 to 1.999
        upper = num + 1;
      } else {
        // "1.6" means 1.600 to 1.699 (step = 0.1)
        const step = Math.pow(10, -decimals);
        upper = num + step;
      }

          whereObj.where += " AND road_length_km >= ? AND road_length_km < ?";
          valsArr.push(lower, upper);
        }

        let where = "WHERE 1=1";
        const vals = [];

        if (road_code) {
          where += " AND road_code LIKE ?";
          vals.push(`%${road_code}%`);
        }
        if (road_name) {
          where += " AND road_name LIKE ?";
          vals.push(`%${road_name}%`);
        }
        if (region) {
          where += " AND region = ?";
          vals.push(region);
        }
        if (town) {
          where += " AND town LIKE ?";
          vals.push(`%${town}%`);
        }
        const whereObj = { where };
          addLengthFilter(whereObj, vals, road_length_km);
          where = whereObj.where;
        const [countRows] = await db.query(
          `SELECT COUNT(*) AS total FROM roads ${where}`,
          vals
        );
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const [rows] = await db.query(
      `
      SELECT id, road_code, road_name, road_length_km, region, town
      FROM roads
      ${where}
      ORDER BY region, town, road_code
      LIMIT ? OFFSET ?
      `,
      [...vals, limit, offset]
    );

    return res.json({
      success: true,
      page,
      limit,
      total,
      totalPages,
      roads: rows,
    });
  } catch (err) {
    console.error("roads/paged error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch roads" });
  }
});

/**
 * POST /api/roads  (manual save: upsert by road_code)
 */
router.post("/", async (req, res) => {
  try {
    const road_code = String(req.body?.road_code || "").trim();
    const road_name = String(req.body?.road_name || "").trim();
    const region = String(req.body?.region || "").trim();
    const town = String(req.body?.town || "").trim();
    const road_length_km_raw = req.body?.road_length_km;
    const road_length_km =
       road_length_km_raw === null || road_length_km_raw === undefined || String(road_length_km_raw).trim() === ""
    ? null
    : Number(Number(String(road_length_km_raw).replace(/,/g, "")).toFixed(3));

    if (!road_code || !road_name) {
      return res.status(400).json({ success: false, message: "road_code and road_name are required" });
    }

    await db.query(
      `
      INSERT INTO roads (road_code, road_name, road_length_km, region, town)
      VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''))
      ON DUPLICATE KEY UPDATE
        road_name = VALUES(road_name),
        road_length_km = COALESCE(VALUES(road_length_km), road_length_km),
        region    = VALUES(region),
        town      = VALUES(town)
      `,
      [road_code, road_name, region, town]
    );

    return res.json({ success: true, message: "Road saved" });
  } catch (err) {
    console.error("roads POST error:", err);
    return res.status(500).json({ success: false, message: "Failed to save road" });
  }
});

/**
 * PUT /api/roads/:id  (manual edit)
 */
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });

    const road_code = req.body?.road_code ? String(req.body.road_code).trim() : null;
    const road_name = req.body?.road_name ? String(req.body.road_name).trim() : null;
    const region = req.body?.region ? String(req.body.region).trim() : null;
    const town = req.body?.town ? String(req.body.town).trim() : null;

    await db.query(
      `
      UPDATE roads
      SET
        road_code = COALESCE(?, road_code),
        road_name = COALESCE(?, road_name),
        region    = COALESCE(?, region),
        town      = COALESCE(?, town)
      WHERE id = ?
      `,
      [road_code, road_name, region, town, id]
    );

    return res.json({ success: true, message: "Road updated" });
  } catch (err) {
    console.error("roads PUT error:", err);
    return res.status(500).json({ success: false, message: "Failed to update road" });
  }
});

/**
 * GET /api/roads/export  (Excel .xlsx)
 */
router.get("/export", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT road_code, road_name, road_length_km, region, town FROM roads ORDER BY region, town, road_code`
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Roads");

    sheet.columns = [
      { header: "road_code", key: "road_code", width: 20 },
      { header: "road_name", key: "road_name", width: 45 },
      { header: "road_length_km", key: "road_length_km", width: 18 },
      { header: "region", key: "region", width: 18 },
      { header: "town", key: "town", width: 18 },
    ];

    const cleanRows = rows.map(r => ({
        road_code: String(r.road_code || "").toUpperCase(),
        road_name: r.road_name,
        road_length_km: r.road_length_km,
        region: r.region,
        town: r.town
      }));

    sheet.addRows(cleanRows);
    
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="Roads_Backup.xlsx"'
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("roads export error:", err);
    res.status(500).json({ success: false, message: "Failed to export roads" });
  }
});

module.exports = router;