const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { deleteDocumentsForEntity } = require("../models/documents");

const QC_TYPES = ["Appearance", "Weight", "Packaging", "Lab Test", "Food Safety", "Overall Quality"];
const COMPLAINT_CATEGORIES = ["Damaged", "Wrong Product", "Missing", "Quality Issue", "Expired", "Packaging", "Quantity Mismatch", "Delivery"];

router.get("/qc-checks", (req, res) => {
  const rows = db.prepare(`
    SELECT qc.*, b.product_name, b.batch_code
    FROM qc_checks qc JOIN batches b ON b.id = qc.batch_id
    ORDER BY qc.created_at DESC
  `).all();
  res.json(rows);
});

router.post("/qc-checks", (req, res) => {
  const { batchId, checkedBy, result, notes, qcType } = req.body;
  if (!batchId) return res.status(400).json({ error: "batchId is required" });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO qc_checks (id, batch_id, checked_by, result, notes, qc_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, batchId, checkedBy || "Admin", result || "passed", notes || "", qcType || "Overall Quality");
  res.status(201).json(db.prepare("SELECT * FROM qc_checks WHERE id = ?").get(id));
});

router.delete("/qc-checks/:id", (req, res) => {
  const check = db.prepare("SELECT id FROM qc_checks WHERE id = ?").get(req.params.id);
  if (!check) return res.status(404).json({ error: "QC check not found" });
  db.prepare("DELETE FROM qc_checks WHERE id = ?").run(req.params.id);
  deleteDocumentsForEntity("qc_check", req.params.id);
  res.status(204).end();
});

router.get("/complaints", (req, res) => {
  res.json(db.prepare("SELECT * FROM complaints ORDER BY created_at DESC").all());
});

router.post("/complaints", (req, res) => {
  const { batchId, orderId, complainantName, description, category, priority } = req.body;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO complaints (id, batch_id, order_id, complainant_name, description, category, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, batchId || null, orderId || null, complainantName, description, category || "Quality Issue", priority || "Medium");
  res.status(201).json(db.prepare("SELECT * FROM complaints WHERE id = ?").get(id));
});

router.patch("/complaints/:id/resolve", (req, res) => {
  db.prepare("UPDATE complaints SET status = 'resolved' WHERE id = ?").run(req.params.id);
  res.json(db.prepare("SELECT * FROM complaints WHERE id = ?").get(req.params.id));
});

router.patch("/complaints/:id/status", (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE complaints SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json(db.prepare("SELECT * FROM complaints WHERE id = ?").get(req.params.id));
});

router.delete("/complaints/:id", (req, res) => {
  const complaint = db.prepare("SELECT id FROM complaints WHERE id = ?").get(req.params.id);
  if (!complaint) return res.status(404).json({ error: "Complaint not found" });
  db.prepare("DELETE FROM complaints WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Options for the QC/complaint creation forms
router.get("/options", (req, res) => {
  res.json({ qcTypes: QC_TYPES, complaintCategories: COMPLAINT_CATEGORIES, priorities: ["Low", "Medium", "High"] });
});

router.get("/summary", (req, res) => {
  const checks = db.prepare("SELECT * FROM qc_checks").all();
  const complaints = db.prepare("SELECT * FROM complaints").all();

  const passed = checks.filter(c => c.result === "passed").length;
  const failed = checks.length - passed;

  const byType = QC_TYPES.map(type => ({
    type,
    total: checks.filter(c => c.qc_type === type).length,
    passed: checks.filter(c => c.qc_type === type && c.result === "passed").length,
  }));

  const byCategory = COMPLAINT_CATEGORIES.map(category => ({
    category, count: complaints.filter(c => c.category === category).length,
  }));

  res.json({
    totalChecks: checks.length, passed, failed,
    passRate: checks.length ? Math.round((passed / checks.length) * 1000) / 10 : 0,
    openComplaints: complaints.filter(c => c.status === "pending").length,
    byType, byCategory,
  });
});

module.exports = router;
