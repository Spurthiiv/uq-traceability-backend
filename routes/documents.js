const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { UPLOAD_DIR } = require("../models/documents");

// Real KYC/compliance documents (FSSAI certificates, lab report images) —
// only image and PDF files are accepted, capped at 5MB, and stored under a
// generated name so the original filename can never be used as a path.
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(new Error("Only JPG, PNG, WEBP or PDF files are allowed"));
    cb(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File must be 5MB or smaller" : err.message });
    next();
  });
}

router.get("/", (req, res) => {
  const { entityType, entityId } = req.query;
  if (!entityType || !entityId) return res.status(400).json({ error: "entityType and entityId are required" });
  res.json(
    db.prepare("SELECT * FROM documents WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC")
      .all(entityType, entityId)
  );
});

router.post("/", handleUpload, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "A file (image or PDF, max 5MB) is required" });
  const { entityType, entityId, docType } = req.body;
  if (!entityType || !entityId || !docType) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "entityType, entityId and docType are required" });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO documents (id, entity_type, entity_id, doc_type, original_name, stored_name, mime_type, size_bytes, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, entityType, entityId, docType, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user?.name || null);

  res.status(201).json(db.prepare("SELECT * FROM documents WHERE id = ?").get(id));
});

router.delete("/:id", (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  fs.unlink(path.join(UPLOAD_DIR, doc.stored_name), () => {});
  db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
