import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import bcrypt from "bcryptjs";
import db from "../db"; // adjust to your DB config

const router = express.Router();

// Setup multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post("/upload-users", upload.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const { username, email, password, role } = row;

      if (!username || !email || !password || !role) {
        errors.push({ row: i + 2, reason: "Missing required fields" });
        continue;
      }

      if (!["Admin", "Inspector", "Site Agent", "A.R.E", "R.E"].includes(role)) {
        errors.push({ row: i + 2, reason: `Invalid role: ${role}` });
        continue;
      }

      try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db("users").insert({
          username,
          email,
          password: hashedPassword,
          role,
        });
      } catch (err) {
        errors.push({ row: i + 2, reason: err.message });
      }
    }

    if (errors.length > 0) {
      return res.status(207).json({ success: false, errors });
    }

    res.json({ success: true, message: "Users uploaded successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

export default router;
