const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateJWT = require("../middlewares/auth");

const multer = require("multer");
const path = require("path");
const fs = require("fs");

// uploads/project-media
const uploadDir = path.join(__dirname, "..", "uploads", "project-media");
fs.mkdirSync(uploadDir, { recursive: true });

const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const VIDEO_MAX_BYTES = 20 * 1024 * 1024; // 20MB
const VIDEO_MAX_SECONDS = 10;

const allowedSections = [
  "PLANT_EQUIPMENT",
  "MATERIALS",
  "LABOUR",
  "OPERATIONS",
  "GENERAL",
];

function normalizeRole(role) {
  return String(role || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/_/g, "")
    .replace(/\s+/g, "");
}

function normalizeSection(section) {
  const value = String(section || "").toUpperCase();

  if (allowedSections.includes(value)) return value;

  return "GENERAL";
}

function getFileType(mimeType) {
  if (String(mimeType || "").startsWith("image/")) return "image";
  if (String(mimeType || "").startsWith("video/")) return "video";
  return null;
}

async function getReport(reportId) {
  if (!reportId) return null;

  const [rows] = await db.query(
    "SELECT * FROM daily_work_reports WHERE id = ? LIMIT 1",
    [reportId]
  );

  return rows[0] || null;
}

async function userHasProjectAccess(userId, projectId) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM user_projects
    WHERE user_id = ?
      AND project_id = ?
    LIMIT 1
    `,
    [userId, projectId]
  );

  return rows.length > 0;
}

async function getWorkflowAssignment(projectId) {
  const [rows] = await db.query(
    `
    SELECT *
    FROM project_workflow_assignments
    WHERE project_id = ?
    LIMIT 1
    `,
    [projectId]
  );

  return rows[0] || null;
}

function isWorkflowUser(user, assignment) {
  if (!assignment) return false;

  const uid = String(user?.id || "");

  return (
    String(assignment.siteagent_id || "") === uid ||
    String(assignment.inspector_id || "") === uid ||
    String(assignment.are_id || "") === uid ||
    String(assignment.re_id || "") === uid
  );
}

async function canViewProjectMedia(user, projectId) {
  const role = normalizeRole(user?.role);

  if (role === "admin") return true;

  const hasAccess = await userHasProjectAccess(user.id, projectId);
  if (hasAccess) return true;

  const assignment = await getWorkflowAssignment(projectId);
  return isWorkflowUser(user, assignment);
}

async function canUploadToDailyReport(user, report) {
  const role = normalizeRole(user?.role);

  if (role === "admin") return true;

  if (!report) return false;

  const status = String(report.status || "").toUpperCase();
  const changeRequested = Number(report.change_requested || 0) === 1;

  const isDraft = status === "DRAFT";
  const isSubmitted = status === "SUBMITTED";
  const isChangeRequested = status === "SUBMITTED" && changeRequested;

  const reportAllowsMedia =
    isDraft || isSubmitted || isChangeRequested;

  if (!reportAllowsMedia) return false;

  const assignment = await getWorkflowAssignment(report.project_id);

  const isAssignedSiteAgent =
    String(assignment?.siteagent_id || "") === String(user.id);

  const isCreator = String(report.created_by || "") === String(user.id);

  return role === "siteagent" && (isAssignedSiteAgent || isCreator);
}

async function canEditOrDeleteMedia(user, mediaRow) {
  const role = normalizeRole(user?.role);

  if (role === "admin") return true;

  if (String(mediaRow.uploaded_by || "") !== String(user.id)) {
    return false;
  }

  if (!mediaRow.report_id) return true;

  const report = await getReport(mediaRow.report_id);

  return report && String(report.status) === "DRAFT";
}

async function canSelectForReport(user, mediaRow) {
  const role = normalizeRole(user?.role);

  if (role === "admin") return true;
  if (role !== "re") return false;

  return await canViewProjectMedia(user, mediaRow.project_id);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeBase = path
      .basename(file.originalname || "file", ext)
      .replace(/[^a-z0-9_-]+/gi, "_")
      .slice(0, 50);

    cb(null, `${Date.now()}_${safeBase}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: VIDEO_MAX_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    const type = getFileType(file.mimetype);

    if (!type) {
      cb(new Error("Only image and video files are allowed."));
      return;
    }

    const allowedMime = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
    ];

    if (!allowedMime.includes(file.mimetype)) {
      cb(new Error("Allowed files: JPG, PNG, WEBP, MP4, WEBM."));
      return;
    }

    cb(null, true);
  },
});

// POST /api/project-media/upload
router.post("/upload", authenticateJWT, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No file uploaded." });
    }

    const reportId = req.body.report_id ? Number(req.body.report_id) : null;
    const projectId = Number(req.body.project_id);
    const eventId = req.body.event_id ? Number(req.body.event_id) : null;

    const section = normalizeSection(req.body.section);
    const mediaContext = String(req.body.media_context || "DAILY_REPORT").toUpperCase();

    const caption = String(req.body.caption || "").trim() || null;
    const durationSeconds =
      req.body.duration_seconds !== undefined && req.body.duration_seconds !== ""
        ? Number(req.body.duration_seconds)
        : null;

    if (!Number.isInteger(projectId) || projectId <= 0) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ message: "Valid project_id is required." });
    }

    const fileType = getFileType(file.mimetype);

    if (!fileType) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ message: "Unsupported file type." });
    }

    if (fileType === "image" && file.size > IMAGE_MAX_BYTES) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ message: "Photo must not exceed 5MB." });
    }

    if (fileType === "video") {
      if (file.size > VIDEO_MAX_BYTES) {
        fs.unlinkSync(file.path);
        return res.status(400).json({ message: "Video must not exceed 20MB." });
      }

      if (durationSeconds !== null && durationSeconds > VIDEO_MAX_SECONDS) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          message: "Video must not be longer than 10 seconds.",
        });
      }
    }

    let report = null;

    if (mediaContext === "DAILY_REPORT") {
      if (!reportId) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          message: "report_id is required for Daily Report photos/videos.",
        });
      }

      report = await getReport(reportId);

      if (!report) {
        fs.unlinkSync(file.path);
        return res.status(404).json({ message: "Daily report not found." });
      }

      if (Number(report.project_id) !== Number(projectId)) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          message: "project_id does not match this daily report.",
        });
      }

      const allowed = await canUploadToDailyReport(req.user, report);

      if (!allowed) {
        fs.unlinkSync(file.path);
        return res.status(403).json({
          message: "You are not allowed to upload files to this report.",
        });
      }
    } else {
      const canView = await canViewProjectMedia(req.user, projectId);

      if (!canView) {
        fs.unlinkSync(file.path);
        return res.status(403).json({
          message: "You are not allowed to upload files to this project.",
        });
      }
    }

    if (fileType === "image" && reportId) {
      const [photoCountRows] = await db.query(
        `
        SELECT COUNT(*) AS total
        FROM project_media
        WHERE report_id = ?
          AND file_type = 'image'
          AND deleted_at IS NULL
        `,
        [reportId]
      );

      if (Number(photoCountRows[0]?.total || 0) >= 10) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          message: "This daily report already has the maximum 10 photos.",
        });
      }
    }

    if (fileType === "video") {
      const [videoCountRows] = await db.query(
        `
        SELECT COUNT(*) AS total
        FROM project_media
        WHERE project_id = ?
          AND file_type = 'video'
          AND deleted_at IS NULL
        `,
        [projectId]
      );

      if (Number(videoCountRows[0]?.total || 0) >= 10) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          message: "This project already has the maximum 10 videos.",
        });
      }
    }

    const filePath = `/uploads/project-media/${file.filename}`;

    const [result] = await db.query(
      `
      INSERT INTO project_media
        (
          project_id,
          report_id,
          event_id,
          section,
          media_context,
          file_type,
          file_name,
          original_name,
          file_path,
          mime_type,
          file_size_bytes,
          duration_seconds,
          caption,
          uploaded_by
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        projectId,
        reportId,
        eventId,
        section,
        mediaContext,
        fileType,
        file.filename,
        file.originalname || null,
        filePath,
        file.mimetype || null,
        file.size || null,
        durationSeconds,
        caption,
        req.user.id,
      ]
    );

    const [rows] = await db.query(
      `
      SELECT
        pm.*,
        u.username AS uploaded_by_username,
        u.full_name AS uploaded_by_name
      FROM project_media pm
      LEFT JOIN users u ON u.id = pm.uploaded_by
      WHERE pm.id = ?
      `,
      [result.insertId]
    );

    return res.status(201).json({
      success: true,
      message: "File uploaded successfully.",
      media: rows[0],
    });
  } catch (err) {
    console.error("Project media upload error:", err);

    return res.status(500).json({
      message: err.message || "Failed to upload file.",
    });
  }
});

// GET /api/project-media?project_id=&report_id=&section=&media_context=&event_id=
router.get("/", authenticateJWT, async (req, res) => {
  try {
    const projectId = Number(req.query.project_id);
    const reportId = req.query.report_id ? Number(req.query.report_id) : null;
    const eventId = req.query.event_id ? Number(req.query.event_id) : null;
    const section = req.query.section ? normalizeSection(req.query.section) : null;
    const mediaContext = req.query.media_context
      ? String(req.query.media_context).toUpperCase()
      : null;

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Valid project_id is required." });
    }

    const allowed = await canViewProjectMedia(req.user, projectId);

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to view files for this project.",
      });
    }

    let sql = `
      SELECT
        pm.*,
        u.username AS uploaded_by_username,
        u.full_name AS uploaded_by_name
      FROM project_media pm
      LEFT JOIN users u ON u.id = pm.uploaded_by
      WHERE pm.project_id = ?
        AND pm.deleted_at IS NULL
    `;

    const values = [projectId];

    if (reportId) {
      sql += " AND pm.report_id = ?";
      values.push(reportId);
    }

    if (eventId) {
      sql += " AND pm.event_id = ?";
      values.push(eventId);
    }

    if (section) {
      sql += " AND pm.section = ?";
      values.push(section);
    }

    if (mediaContext) {
      sql += " AND pm.media_context = ?";
      values.push(mediaContext);
    }

    sql += " ORDER BY pm.created_at DESC, pm.id DESC";

    const [rows] = await db.query(sql, values);

    return res.json({
      success: true,
      media: rows,
    });
  } catch (err) {
    console.error("Project media list error:", err);

    return res.status(500).json({
      message: "Failed to load photos/videos.",
    });
  }
});

// PUT /api/project-media/:id/caption
router.put("/:id/caption", authenticateJWT, async (req, res) => {
  try {
    const mediaId = Number(req.params.id);
    const caption = String(req.body.caption || "").trim() || null;

    const [rows] = await db.query(
      `
      SELECT *
      FROM project_media
      WHERE id = ?
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [mediaId]
    );

    const media = rows[0];

    if (!media) {
      return res.status(404).json({ message: "File not found." });
    }

    const allowed = await canEditOrDeleteMedia(req.user, media);

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to edit this caption.",
      });
    }

    await db.query(
      `
      UPDATE project_media
      SET caption = ?
      WHERE id = ?
      `,
      [caption, mediaId]
    );

    return res.json({
      success: true,
      message: "Caption updated.",
    });
  } catch (err) {
    console.error("Caption update error:", err);

    return res.status(500).json({
      message: "Failed to update caption.",
    });
  }
});

// DELETE /api/project-media/:id
router.delete("/:id", authenticateJWT, async (req, res) => {
  try {
    const mediaId = Number(req.params.id);

    const [rows] = await db.query(
      `
      SELECT *
      FROM project_media
      WHERE id = ?
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [mediaId]
    );

    const media = rows[0];

    if (!media) {
      return res.status(404).json({ message: "File not found." });
    }

    const allowed = await canEditOrDeleteMedia(req.user, media);

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to delete this file.",
      });
    }

    await db.query(
      `
      UPDATE project_media
      SET deleted_at = NOW()
      WHERE id = ?
      `,
      [mediaId]
    );

    const fullPath = path.join(__dirname, "..", media.file_path);

    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch (fileErr) {
        console.warn("Could not delete physical file:", fileErr.message);
      }
    }

    return res.json({
      success: true,
      message: "File deleted.",
    });
  } catch (err) {
    console.error("Project media delete error:", err);

    return res.status(500).json({
      message: "Failed to delete file.",
    });
  }
});

// PUT /api/project-media/:id/select
router.put("/:id/select", authenticateJWT, async (req, res) => {
  try {
    const mediaId = Number(req.params.id);
    const selected = req.body.is_selected_for_report ? 1 : 0;

    const [rows] = await db.query(
      `
      SELECT *
      FROM project_media
      WHERE id = ?
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [mediaId]
    );

    const media = rows[0];

    if (!media) {
      return res.status(404).json({ message: "File not found." });
    }

    const allowed = await canSelectForReport(req.user, media);

    if (!allowed) {
      return res.status(403).json({
        message: "Only the assigned R.E or Admin can select files for reports.",
      });
    }

    await db.query(
      `
      UPDATE project_media
      SET is_selected_for_report = ?
      WHERE id = ?
      `,
      [selected, mediaId]
    );

    return res.json({
      success: true,
      message: selected
        ? "File selected for report generation."
        : "File removed from report selection.",
    });
  } catch (err) {
    console.error("Project media select error:", err);

    return res.status(500).json({
      message: "Failed to update file selection.",
    });
  }
});

module.exports = router;