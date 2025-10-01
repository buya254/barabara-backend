const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");
const db = require("../db"); // adjust path if needed

// --- Multer setup for file uploads ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ===================================================
// 1) DOWNLOAD TEMPLATE
// ===================================================
router.get("/download-template", (req, res) => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["Username", "Full Name", "Email", "Phone", "Role", "Financial Year", "Project Name", "Project Number", "Signature"]
  ]);

  XLSX.utils.book_append_sheet(workbook, worksheet, "Template");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Disposition", 'attachment; filename="Import_Users_Template.xlsx"'); // ✅ enforce filename
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

// ===================================================
// 2) IMPORT USERS FROM EXCEL
// ===================================================
router.post("/upload-users", upload.single("file"), async (req, res) => {
  try {
    if (req.file.originalname !== "Import_Users_Template.xlsx") {
      return res.status(400).json({ success: false, message: "Invalid file. Please use the provided template." });
      }

    // Read Excel file buffer
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const { username, password, fullname, role, email, fy, project, phone, signature } = rows[i];

      if (!username || !password || !role) {
        errors.push({ row: i + 2, reason: "Missing required fields" });
        continue;
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      try {
        await db.query(
          `INSERT INTO users 
          (username, password, fullname, role, email, fy, project, phone, signature) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [username, hashedPassword, fullname || "", role, email || "", fy || "", project || "", phone || "", signature || ""]
        );
      } catch (err) {
        errors.push({ row: i + 2, reason: err.message });
      }
    }

    if (errors.length > 0) {
      return res.status(207).json({ success: false, message: "Some rows failed", errors });
    }

    res.json({ success: true, message: "Users uploaded successfully" });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

module.exports = router;
