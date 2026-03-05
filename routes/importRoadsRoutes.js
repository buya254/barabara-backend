const express = require("express");
const ExcelJS = require("exceljs");
const multer = require("multer");
const db = require("../db");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const TEMPLATE_FILENAME = "Import_Roads_Template.xlsx";

function normalizeRoadCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * GET /api/import-roads/download-template
 */
router.get("/download-template", async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("RoadsTemplate");

    // Must match DB fields: road_code, road_name, region, town
    sheet.columns = [
        { header: "road_code", key: "road_code", width: 20 },
        { header: "road_name", key: "road_name", width: 45 },
        { header: "road_length_km", key: "road_length_km", width: 18 },
        { header: "region", key: "region", width: 18 },
        { header: "town", key: "town", width: 18 },
      ];

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${TEMPLATE_FILENAME}"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating roads template:", err);
    res.status(500).json({ message: "Failed to generate roads template" });
  }
});

/**
 * POST /api/import-roads/upload-roads
 */
router.post("/upload-roads", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
   console.log("✅ import-roads file:", req.file?.originalname, req.file?.mimetype, req.file?.size);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];

    const rowsToProcess = [];

    sheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;

          const road_code_raw = row.getCell(1).value?.toString() || "";
          const road_name = row.getCell(2).value?.toString().trim() || "";

          const lengthRaw = row.getCell(3).value;
          const road_length_km =
            lengthRaw === null || lengthRaw === undefined || String(lengthRaw).trim() === ""
              ? null
              : Number(Number(String(lengthRaw).replace(/,/g, "")).toFixed(3));

          const region = row.getCell(4).value?.toString().trim() || "";
          const town = row.getCell(5).value?.toString().trim() || "";

          const road_code = normalizeRoadCode(road_code_raw);

          if (!road_code && !road_name && !region && !town && road_length_km == null) return;
          if (!road_code || !road_name) return;

          rowsToProcess.push({ road_code, road_name, road_length_km, region, town });
        });
    
         for (const r of rowsToProcess) {
          try {
            // normal upsert attempt
            await db.query(
              `
              INSERT INTO roads (road_code, road_name, road_length_km, region, town)
              VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''))
              ON DUPLICATE KEY UPDATE
                road_name = IF(VALUES(road_name) IS NULL OR VALUES(road_name) = '', road_name, VALUES(road_name)),
                road_length_km = COALESCE(VALUES(road_length_km), road_length_km),
                region    = COALESCE(VALUES(region), region),
                town      = COALESCE(VALUES(town), town)
              `,
              [r.road_code, r.road_name, r.road_length_km, r.region, r.town]
            );
          } catch (err) {
            // ✅ If duplicate is from UNIQUE(town, road_name), update missing info instead of failing
            if (
              err?.code === "ER_DUP_ENTRY" &&
              String(err?.message || "").includes("uq_town_roadname")
            ) {
              await db.query(
                `
                UPDATE roads
                SET
                  -- only fill if missing
                  road_length_km = COALESCE(road_length_km, ?),
                  region = CASE WHEN region IS NULL OR region = '' THEN ? ELSE region END,
                  town   = CASE WHEN town IS NULL OR town = '' THEN ? ELSE town END
                WHERE town = ? AND road_name = ?
                LIMIT 1
                `,
                [r.road_length_km, r.region, r.town, r.town, r.road_name]
              );
              continue;
            }

            // anything else should still fail loud
            throw err;
          }
        }

    return res.json({
      success: true,
      message: `Processed ${rowsToProcess.length} roads from Excel.`,
    });
  } catch (err) {
    console.error("Error uploading roads:", err);
    res.status(500).json({
      message: "Failed to import roads",
      error: err.message || null,
      code: err.code || null,
    });
  }
});

/**
 * POST /api/import-roads/compare-roads
 */
router.post("/compare-roads", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    console.log("✅ import-roads file:", req.file?.originalname, req.file?.mimetype, req.file?.size);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];

    const excelRoads = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      // ✅ DEBUG (first 5 data rows only)
      if (rowNumber <= 6) {
            console.log("ROW", rowNumber, {
            c1: row.getCell(1).value,
            c2: row.getCell(2).value,
            c3: row.getCell(3).value,
            c4: row.getCell(4).value,
            c5: row.getCell(5).value,
            });
    }

      const road_code_raw = row.getCell(1).value?.toString() || "";
      const road_name = row.getCell(2).value?.toString().trim() || "";
      const lengthRaw = row.getCell(3).value;
      const road_length_km =
      lengthRaw === null || lengthRaw === undefined || String(lengthRaw).trim() === ""
      ? null
      : Number(Number(String(lengthRaw).replace(/,/g, "")).toFixed(3));
      const region = row.getCell(4).value?.toString().trim() || "";
      const town = row.getCell(5).value?.toString().trim() || "";

      const road_code = normalizeRoadCode(road_code_raw);

      if (!road_code && !road_name) return;
      if (!road_code || !road_name) return;

      excelRoads.push({ road_code, road_name, road_length_km, region, town });
    });

    const [dbRows] = await db.query(
      `SELECT road_code, road_name, road_length_km, region, town FROM roads`
    );

    const dbSet = new Set(dbRows.map((r) => String(r.road_code).toUpperCase()));
    const excelSet = new Set(
      excelRoads.map((r) => String(r.road_code).toUpperCase())
    );

    const missingInDb = excelRoads.filter(
      (r) => !dbSet.has(String(r.road_code).toUpperCase())
    );

    const missingInExcel = dbRows.filter(
      (r) => !excelSet.has(String(r.road_code).toUpperCase())
    );

    return res.json({
      success: true,
      summary: {
        totalExcel: excelRoads.length,
        totalDb: dbRows.length,
        missingInDbCount: missingInDb.length,
        missingInExcelCount: missingInExcel.length,
      },
      missingInDb,
      missingInExcel,
    });
  } catch (err) {
    console.error("Error comparing roads:", err);
    res.status(500).json({ message: "Failed to compare roads" });
  }
});

module.exports = router;