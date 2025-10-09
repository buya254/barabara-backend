const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const bcrypt = require("bcryptjs");
const db = require("../db");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ✅ Human-friendly Excel headers
const TEMPLATE_HEADERS = [
  "National ID",
  "Username",
  "Password",
  "Full Name",
  "Role",
  "Email",
  "Financial Year",
  "Project Name",
  "Project Number",
  "Phone Number",
  "Signature"
];


// ✅ Route: download template
router.get("/download-template", (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS]);
    XLSX.utils.book_append_sheet(wb, ws, "UsersTemplate");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", "attachment; filename=Import_Users_Template.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);
  } catch (err) {
    console.error("Error generating template:", err);
    res.status(500).json({ message: "Failed to generate template" });
  }
});

// ✅ Route: upload filled Excel file
router.post("/upload-users", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    console.log("✅ File received:", req.file.originalname);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // Parse rows
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    console.log("✅ Raw rows from Excel:", rows);

    // Check headers
    const firstRow = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || [];
    console.log("✅ Headers found:", firstRow);

    const headerOk =
      TEMPLATE_HEADERS.length === firstRow.length &&
      TEMPLATE_HEADERS.every((h, i) => firstRow[i] === h);

    if (!headerOk) {
    console.error("❌ Wrong template uploaded!");
    return res.status(400).json({
    success: false,
    message: "Invalid template. Please download a fresh copy from the system."
    });
    }
    // ✅ Map human headers → DB fields
    const mappedRows = rows.map(r => ({
      id: r["National ID"],
      username: r["Username"],
      password: r["Password"],
      full_name: r["Full Name"],
      role: r["Role"],
      email: r["Email"],
      financial_year: r["Financial Year"],
      project_name: r["Project Name"],
      project_number: r["Project Number"],
      phone: r["Phone Number"],
      signature: r["Signature"]
    }));

    console.log("✅ Mapped rows:", mappedRows);

    let inserted = 0;
    let errors = [];

    for (let i = 0; i < mappedRows.length; i++) {
      const u = mappedRows[i];
      console.log(`▶ Processing row ${i + 2}:`, u);

      // ---- National ID validation ----
      if (!/^[0-6][0-9]{0,7}$/.test(String(u.id))) {
        console.error(`❌ Invalid National ID at row ${i + 2}:`, u.id);
        errors.push({ row: i + 2, reason: "Invalid National ID (must start 0–6 and ≤8 digits)" });
        continue;
      }

      if (!u.username || !u.password || !u.role) {
        console.error(`❌ Missing required fields at row ${i + 2}`);
        errors.push({ row: i + 2, reason: "Missing required fields: username/password/role" });
        continue;
      }

      try {
        const hashed = await bcrypt.hash(u.password, 10);

        const sql = `
          INSERT INTO users 
          (id, username, password, full_name, role, email, financial_year, project_name, project_number, phone, signature) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const [result] = await db.execute(sql, [
          u.id, u.username, hashed, u.full_name, u.role,
          u.email, u.financial_year, u.project_name, u.project_number,
          u.phone, u.signature
        ]);

        if (result.affectedRows === 1) {
          console.log(`✅ Inserted row ${i + 2} (username: ${u.username})`);
          inserted++;
        } else {
          console.error(`❌ Failed to insert row ${i + 2}`);
        }
      } catch (err) {
        console.error(`❌ DB error at row ${i + 2}:`, err.message);
        errors.push({ row: i + 2, reason: err.message });
      }
    }

    if (errors.length > 0) {
      return res.status(207).json({ success: false, inserted, errors });
    }

    res.json({ success: true, inserted, message: "Users imported successfully" });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

module.exports = router;
