const express = require("express");
const ExcelJS = require("exceljs");
const multer = require("multer");
const db = require("../db");            // ← this is your MySQL connection

const router = express.Router();

// we use memory storage because we only read the file, not save it to disk
const upload = multer({ storage: multer.memoryStorage() });

/**
 * GET /api/import-projects/download-template
 * Generates an empty Excel file with the correct header row.
 */
router.get("/download-template", async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("ProjectsTemplate");

    // These headers MUST match what you expect on upload
    sheet.columns = [
      { header: "region",           key: "region",           width: 20 },
      { header: "project_number",   key: "project_number",   width: 30 }, // contract no.
      { header: "project_name",     key: "project_name",     width: 40 }, // road name
      { header: "chainage",         key: "chainage",         width: 25 },
      { header: "contractor",       key: "contractor",       width: 30 },
      { header: "project_duration", key: "project_duration", width: 20 },
      { header: "financial_year",   key: "financial_year",   width: 15 }, // e.g. 2025/26
    ];

    // No rows – just header
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="Import_Projects_Template.xlsx"'
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating projects template:", err);
    res.status(500).json({ message: "Failed to generate projects template" });
  }
});

/**
 * POST /api/import-projects/upload-projects
 * Reads Excel from the upload and INSERTs / UPDATEs rows in the `projects` table.
 */
router.post(
  "/upload-projects",
  upload.single("file"),                        // ← multer gives us req.file
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];

      const rowsToProcess = [];

      // read rows (skip header row 1)
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const region           = row.getCell(1).value?.toString().trim() || "";
        const project_number   = row.getCell(2).value?.toString().trim() || "";
        const project_name     = row.getCell(3).value?.toString().trim() || "";
        const chainage         = row.getCell(4).value?.toString().trim() || "";
        const contractor       = row.getCell(5).value?.toString().trim() || "";
        const project_duration = row.getCell(6).value?.toString().trim() || "";
        const financial_year   = row.getCell(7).value?.toString().trim() || "";

        // require at least these three to consider it a real row
        if (!region && !project_number && !project_name) return;

        rowsToProcess.push({
          region,
          project_number,
          project_name,
          chainage,
          contractor,
          project_duration,
          financial_year,
        });
      });

      // 👉 HERE is where we USE db INSIDE THE ROUTE:
      //    for each Excel row, either UPDATE existing row or INSERT a new one

      for (const p of rowsToProcess) {
        // 1. check if project already exists
        const [existing] = await db.query(
          `SELECT id
             FROM projects
            WHERE project_number = ?
              AND project_name = ?
              AND financial_year = ?
            LIMIT 1`,
          [p.project_number, p.project_name, p.financial_year]
        );

        if (existing.length > 0) {
          // 2a. UPDATE existing
          await db.query(
            `UPDATE projects
                SET region = ?,
                    chainage = ?,
                    contractor = ?,
                    project_duration = ?
              WHERE id = ?`,
            [
              p.region,
              p.chainage,
              p.contractor,
              p.project_duration,
              existing[0].id,
            ]
          );
        } else {
          // 2b. INSERT new
          await db.query(
            `INSERT INTO projects
               (region, project_number, project_name,
                chainage, contractor, project_duration, financial_year)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              p.region,
              p.project_number,
              p.project_name,
              p.chainage,
              p.contractor,
              p.project_duration,
              p.financial_year,
            ]
          );
        }
      }

      res.json({
        success: true,
        message: `Processed ${rowsToProcess.length} projects from Excel.`,
      });
    } catch (err) {
      console.error("Error uploading projects:", err);
      res.status(500).json({ message: "Failed to import projects" });
    }
  }
);

/**
 * POST /api/import-projects/compare-projects
 * Compare Excel file vs DB and return what's missing in DB.
 */
router.post(
  "/compare-projects",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];

      const excelProjects = [];

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const region           = row.getCell(1).value?.toString().trim() || "";
        const project_number   = row.getCell(2).value?.toString().trim() || "";
        const project_name     = row.getCell(3).value?.toString().trim() || "";
        const chainage         = row.getCell(4).value?.toString().trim() || "";
        const contractor       = row.getCell(5).value?.toString().trim() || "";
        const project_duration = row.getCell(6).value?.toString().trim() || "";
        const financial_year   = row.getCell(7).value?.toString().trim() || "";

        if (!region && !project_number && !project_name) return;

        excelProjects.push({
          region,
          project_number,
          project_name,
          chainage,
          contractor,
          project_duration,
          financial_year,
        });
      });

      // 👉 HERE we USE db INSIDE compare route:
      //    read from projects table and compare with Excel

      const [dbRows] = await db.query(
        `SELECT region, project_number, project_name,
                chainage, contractor, project_duration, financial_year
           FROM projects`
      );

      const makeKey = (p) =>
        `${p.project_number}||${p.project_name}||${p.financial_year}`;

      const dbMap = new Map();
      dbRows.forEach((row) => dbMap.set(makeKey(row), row));

      const excelMap = new Map();
      excelProjects.forEach((row) => excelMap.set(makeKey(row), row));

      const missingInDb = excelProjects.filter(
        (p) => !dbMap.has(makeKey(p))
      );

      const missingInExcel = dbRows.filter(
        (p) => !excelMap.has(makeKey(p))
      );

      res.json({
        success: true,
        summary: {
          totalExcel: excelProjects.length,
          totalDb: dbRows.length,
          missingInDbCount: missingInDb.length,
          missingInExcelCount: missingInExcel.length,
        },
        missingInDb,     // you can show these in the popup and export to CSV
        missingInExcel,  // if you ever want them
      });
    } catch (err) {
      console.error("Error comparing projects:", err);
      res.status(500).json({ message: "Failed to compare projects" });
    }
  }
);

module.exports = router;
