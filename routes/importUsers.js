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

    // Map Excel-friendly role names → DB values
    const ROLE_MAP = {
      "Site Agent": "siteagent",
      "SiteAgent": "siteagent",
      "Site agent": "siteagent",
      "site agent": "siteagent",
      "siteagent": "siteagent",
      "SITE AGENT": "siteagent",
      "Inspector": "inspector",
      "inspector": "inspector",
      "INSPECTOR": "inspector",
      "ARE": "are",
      "A.R.E": "are",
      "are": "are",
      "RE": "re",
      "R.E": "re",
      "re": "re",
      "Admin": "admin",
      "Administrator": "admin",
      "admin":"admin",

};

const ALLOWED_ROLES = ["admin", "inspector", "siteagent", "are", "re"];


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

      
      // ---- National ID validation: allow 6–10 digits, 0–9 any
    const idStr = String(u.id).trim();

    if (!/^\d{6,10}$/.test(idStr)) {
      console.error(`❌ Invalid National ID at row ${i + 2}:`, idStr);
      errors.push({
      row: i + 2,
      reason: "Invalid National ID (must be 6–10 digits, numbers only)",
      });
        continue;
      }
      
      // ---- Role normalisation + validation ----
      const rawRole = String(u.role || "").trim();
      const normalizedRole =
      ROLE_MAP[rawRole] ||
      ROLE_MAP[rawRole.toLowerCase()] ||
      rawRole.toLowerCase();

      if (!ALLOWED_ROLES.includes(normalizedRole)) {
        console.error(`❌ Invalid role at row ${i + 2}:`, rawRole);
        errors.push({
        row: i + 2,
        reason: `Invalid role "${rawRole}". Allowed: ${ALLOWED_ROLES.join(", ")}`,
      });
      continue;
    }

      if (!u.username || !u.password) {
        console.error(`❌ Missing required fields at row ${i + 2}`);
        errors.push({
        row: i + 2,
        reason: "Missing required fields: username/password",
      });
        continue;
      }  
            // ---- Check if this ID already exists ----
      const [existingById] = await db.query(
        "SELECT id, username, phone FROM users WHERE id = ?",
        [idStr]
      );

      if (existingById.length > 0) {
        console.warn(
          `⚠️ User with this National ID already exists at row ${i + 2}: id=${idStr}`
        );
        errors.push({
          row: i + 2,
          reason: "User with this National ID already exists in database",
        });
        continue;
      }

      // ---- Ensure unique username (auto-suffix if same username, different phone) ----
      let finalUsername = u.username.trim();
      const phoneStr = String(u.phone || "").trim();

      while (true) {
        const [rows] = await db.query(
          "SELECT username, phone FROM users WHERE username = ?",
          [finalUsername]
        );

        if (rows.length === 0) {
          // username is free → use it
          break;
        }

        // check if same phone already in DB for this username
        const samePhone = phoneStr &&
          rows.some(
            (row) => String(row.phone || "").trim() === phoneStr
          );

        if (samePhone) {
          // same username + same phone → treat as already existing user
          console.warn(
            `⚠️ User with username ${finalUsername} and same phone already exists (row ${i + 2})`
          );
          errors.push({
            row: i + 2,
            reason: "User with same username and phone already exists in database",
          });
          // don't insert duplicate
          continue; // moves to next Excel row
        }

        // otherwise: same username but different phone → add / increase suffix
        // Extract base + numeric suffix (e.g. domondi2 → base=domondi, suffix=2)
        const match = finalUsername.match(/^(.*?)(\d+)$/);
        if (match) {
          const base = match[1];
          const num = parseInt(match[2], 10) || 0;
          finalUsername = `${base}${num + 1}`;
        } else {
          finalUsername = `${finalUsername}1`;
        }

        console.warn(
          `⚠️ Username collision for "${u.username}", trying "${finalUsername}" instead`
        );
        // loop again to check if this new finalUsername is free
      }
        try {
        const hashed = await bcrypt.hash(u.password, 10);

        const sql = `
          INSERT INTO users 
          (id, username, password, full_name, role, email, financial_year, project_name, project_number, phone, signature) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const [result] = await db.execute(sql, [
          idStr,
          finalUsername,
          hashed,
          u.full_name,
          normalizedRole,       // 👈 use normalizedRole here
          u.email,
          u.financial_year,
          u.project_name,
          u.project_number,
          u.phone,
          u.signature,
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
// ✅ Route: compare Excel users with DB (no insert, just report)
router.post("/compare-users", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    console.log("🔍 Compare file received:", req.file.originalname);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // Raw rows
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    console.log("🔍 Raw rows for compare:", rows);

    // Header row
    const firstRow = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || [];
    console.log("🔍 Headers found (compare):", firstRow);

    const headerOk =
      TEMPLATE_HEADERS.length === firstRow.length &&
      TEMPLATE_HEADERS.every((h, i) => firstRow[i] === h);

    if (!headerOk) {
      console.error("❌ Wrong template uploaded for comparison!");
      return res.status(400).json({
        success: false,
        message: "Invalid template. Please download a fresh copy from the system.",
      });
    }
    // Map human headers → fields (same as upload-users)
    const mappedRows = rows.map((r) => ({
      id: String(r["National ID"] || "").trim(),
      username: r["Username"] || "",
      full_name: r["Full Name"] || "",
      role: r["Role"] || "",
      email: r["Email"] || "",
      financial_year: r["Financial Year"] || "",
      project_name: r["Project Name"] || "",
      project_number: r["Project Number"] || "",
      phone: r["Phone Number"] || "",
      signature: r["Signature"] || "",
    }));

    // Build set of IDs from Excel
    const excelIds = new Set(
      mappedRows
        .map((u) => u.id)
        .filter((id) => id && /^\d+$/.test(id)) // only numeric IDs
    );

    if (excelIds.size === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid National IDs found in the Excel file.",
      });
    }

    // Get ALL users from DB (or you can restrict by FY later if you want)
    const [dbUsers] = await db.query(
      "SELECT id, username, full_name, role, financial_year, project_name FROM users"
    );

    const dbIdSet = new Set(dbUsers.map((u) => String(u.id)));

    // In Excel BUT NOT in DB
    const missingInDb = mappedRows.filter(
      (u) => u.id && !dbIdSet.has(String(u.id))
    );

    // In DB BUT NOT in Excel (optional but nice to see)
    const missingInExcel = dbUsers.filter(
      (u) => !excelIds.has(String(u.id))
    );

    const summary = {
      totalExcel: mappedRows.length,
      totalDb: dbUsers.length,
      missingInDbCount: missingInDb.length,
      missingInExcelCount: missingInExcel.length,
    };

    console.log("🔍 Compare summary:", summary);

    return res.json({
      success: true,
      summary,
      missingInDb,    // Excel → not in DB
      missingInExcel, // DB → not in Excel
    });
  } catch (err) {
    console.error("❌ Compare-users error:", err);
    return res.status(500).json({
      success: false,
      message: "Comparison failed.",
    });
  }
});

module.exports = router;
