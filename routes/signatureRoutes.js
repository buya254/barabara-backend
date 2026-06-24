const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

const router = express.Router();

const SIGNATURE_DIR = path.join(__dirname, "..", "uploads", "signatures");

if (!fs.existsSync(SIGNATURE_DIR)) {
  fs.mkdirSync(SIGNATURE_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, SIGNATURE_DIR);
  },
  filename: (req, file, cb) => {
  const userId = req.signatureUserId || String(req.params.userId || "").trim();
  const ext = path.extname(file.originalname || "").toLowerCase() || ".png";

  cb(null, `signature-user-${userId}-${Date.now()}${ext}`);
},
});

const allowedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
  },
  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(
        new Error("Only PNG, JPG, JPEG, or WEBP signature images are allowed.")
      );
    }

    cb(null, true);
  },
});

function isAdmin(user) {
  return String(user?.role || "").toLowerCase() === "admin";
}

function buildPublicSignaturePath(filename) {
  return `/uploads/signatures/${filename}`;
}

function validateSignatureUserId(req, res, next) {
  const userId = String(req.params.userId || "").trim();

  if (!/^\d{6,10}$/.test(userId)) {
    return res.status(400).json({
      message: "Invalid user ID. National ID must be 6–10 digits.",
    });
  }

  req.signatureUserId = userId;
  next();
}

/**
 * POST /api/signatures/users/:userId
 * FormData field name: signature
 *
 * Stores signature image and updates users.signature.
 */
router.post(
  "/users/:userId",
  authenticateJWT,
  validateSignatureUserId,
  upload.single("signature"),
  async (req, res) => {
    try {
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          message: "Only Admin can upload user signatures.",
        });
      }

      const userId = req.signatureUserId;

      if (!req.file) {
        return res.status(400).json({
          message: "Please upload a signature image using field name 'signature'.",
        });
      }

      const [userRows] = await db.query(
        `
        SELECT id, full_name, signature
        FROM users
        WHERE id = ?
        LIMIT 1
        `,
        [userId]
      );

      if (userRows.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ message: "User not found." });
      }

      const previousSignature = String(userRows[0].signature || "").trim();

      const signaturePath = buildPublicSignaturePath(req.file.filename);

      await db.query(
        `
        UPDATE users
        SET signature = ?
        WHERE id = ?
        `,
        [signaturePath, userId]
      );

      // Optional cleanup: remove old local signature file if it was stored in our bucket.
      if (previousSignature.startsWith("/uploads/signatures/")) {
        const oldFilename = path.basename(previousSignature);
        const oldPath = path.join(SIGNATURE_DIR, oldFilename);

        if (oldPath !== req.file.path) {
          fs.unlink(oldPath, () => {});
        }
      }

      return res.json({
        message: "Signature uploaded successfully.",
        user: {
          id: userRows[0].id,
          full_name: userRows[0].full_name,
          signature: signaturePath,
        },
      });
    } catch (err) {
      console.error("❌ signature upload error:", err);

      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }

      return res.status(500).json({
        message: err.message || "Failed to upload signature.",
      });
    }
  }
);

/**
 * DELETE /api/signatures/users/:userId
 * Clears users.signature and removes local signature file if stored locally.
 */
router.delete("/users/:userId", authenticateJWT, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        message: "Only Admin can remove user signatures.",
      });
    }

    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Invalid user ID." });
    }

    const [userRows] = await db.query(
      `
      SELECT id, full_name, signature
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const previousSignature = String(userRows[0].signature || "").trim();

    await db.query(
      `
      UPDATE users
      SET signature = NULL
      WHERE id = ?
      `,
      [userId]
    );

    if (previousSignature.startsWith("/uploads/signatures/")) {
      const oldFilename = path.basename(previousSignature);
      const oldPath = path.join(SIGNATURE_DIR, oldFilename);
      fs.unlink(oldPath, () => {});
    }

    return res.json({
      message: "Signature removed successfully.",
      user: {
        id: userRows[0].id,
        full_name: userRows[0].full_name,
        signature: null,
      },
    });
  } catch (err) {
    console.error("❌ signature delete error:", err);
    return res.status(500).json({
      message: "Failed to remove signature.",
    });
  }
});

module.exports = router;