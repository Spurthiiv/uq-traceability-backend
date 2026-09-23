const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");

// ---- Audit log (BRD ADM-08) — read-only view of the real trail written by middleware/audit.js ----
router.get("/audit-log", (req, res) => {
  const { entity, action, search } = req.query;
  let query = "SELECT * FROM audit_log WHERE 1=1";
  const params = [];
  if (entity) { query += " AND entity = ?"; params.push(entity); }
  if (action) { query += " AND action = ?"; params.push(action); }
  if (search) { query += " AND (user_name LIKE ? OR entity_id LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  query += " ORDER BY created_at DESC LIMIT 200";
  res.json(db.prepare(query).all(...params));
});

// ---- DPDP data-subject requests (access / erasure / correction) ----
router.get("/data-requests", (req, res) => {
  res.json(db.prepare("SELECT * FROM data_requests ORDER BY created_at DESC").all());
});

router.post("/data-requests", (req, res) => {
  const { requesterName, requesterContact, requestType, notes } = req.body;
  if (!requesterName) return res.status(400).json({ error: "requesterName is required" });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO data_requests (id, requester_name, requester_contact, request_type, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, requesterName, requesterContact || null, requestType || "access", notes || null);
  res.status(201).json(db.prepare("SELECT * FROM data_requests WHERE id = ?").get(id));
});

router.patch("/data-requests/:id/status", (req, res) => {
  const request = db.prepare("SELECT id FROM data_requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "Data request not found" });
  const { status } = req.body;
  const resolvedAt = (status === "completed" || status === "rejected") ? new Date().toISOString() : null;
  db.prepare("UPDATE data_requests SET status = ?, resolved_at = ? WHERE id = ?").run(status, resolvedAt, req.params.id);
  res.json(db.prepare("SELECT * FROM data_requests WHERE id = ?").get(req.params.id));
});

router.delete("/data-requests/:id", (req, res) => {
  const request = db.prepare("SELECT id FROM data_requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "Data request not found" });
  db.prepare("DELETE FROM data_requests WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- Consent registry ----
router.get("/consent-records", (req, res) => {
  res.json(db.prepare("SELECT * FROM consent_records ORDER BY created_at DESC").all());
});

router.post("/consent-records", (req, res) => {
  const { subjectName, subjectContact, consentType, granted, recordedBy } = req.body;
  if (!subjectName || !consentType) return res.status(400).json({ error: "subjectName and consentType are required" });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO consent_records (id, subject_name, subject_contact, consent_type, granted, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, subjectName, subjectContact || null, consentType, granted === false ? 0 : 1, recordedBy || null);
  res.status(201).json(db.prepare("SELECT * FROM consent_records WHERE id = ?").get(id));
});

router.delete("/consent-records/:id", (req, res) => {
  const record = db.prepare("SELECT id FROM consent_records WHERE id = ?").get(req.params.id);
  if (!record) return res.status(404).json({ error: "Consent record not found" });
  db.prepare("DELETE FROM consent_records WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
