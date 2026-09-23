const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { nextSequence } = require("../models/sequence");

function generateRefundCode() {
  const year = new Date().getFullYear();
  const seq = nextSequence(`refund_code_${year}`);
  return `REF-${year}-${String(seq).padStart(3, "0")}`;
}

router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, o.order_ref, o.product_name, o.seller_name, o.amount as order_amount
    FROM refund_requests r LEFT JOIN orders o ON o.id = r.order_id
    ORDER BY r.created_at DESC
  `).all();
  res.json(rows);
});

// Step 1 (BRD 19.2): Local Admin (OPS) verifies the claim on the ground and
// initiates the refund request with a recommendation — no refund exists
// without this step, and nothing is approved yet.
router.post("/", (req, res) => {
  const { orderId, complaintId, customerName, reason, refundType, requestedAmount } = req.body;
  if (!customerName || !reason) return res.status(400).json({ error: "customerName and reason are required" });

  const id = uuidv4();
  const refundCode = generateRefundCode();
  db.prepare(`
    INSERT INTO refund_requests (id, refund_code, order_id, complaint_id, customer_name, reason, refund_type, requested_amount, initiated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, refundCode, orderId || null, complaintId || null, customerName, reason, refundType || "refund", requestedAmount || 0, req.user?.name || req.user?.email || "Unknown");

  res.status(201).json(db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(id));
});

// Step 2 (BRD 19.2): District Head (ADMIN) reviews, records the seller's
// consent, and approves — a refund cannot be approved without consent logged.
router.patch("/:id/approve", (req, res) => {
  const refund = db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(req.params.id);
  if (!refund) return res.status(404).json({ error: "Refund request not found" });
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Only an Admin (District Head) can approve a refund" });

  const { sellerConsent, approvalNotes } = req.body;
  if (!sellerConsent) return res.status(400).json({ error: "Seller consent must be recorded before a refund can be approved" });

  db.prepare(`
    UPDATE refund_requests SET status = 'approved', seller_consent = 1, approved_by = ?, approval_notes = ?
    WHERE id = ?
  `).run(req.user.name || req.user.email, approvalNotes || null, req.params.id);

  res.json(db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(req.params.id));
});

router.patch("/:id/reject", (req, res) => {
  const refund = db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(req.params.id);
  if (!refund) return res.status(404).json({ error: "Refund request not found" });
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Only an Admin (District Head) can reject a refund" });

  db.prepare(`
    UPDATE refund_requests SET status = 'rejected', approved_by = ?, approval_notes = ?, resolved_at = ?
    WHERE id = ?
  `).run(req.user.name || req.user.email, req.body.approvalNotes || null, new Date().toISOString(), req.params.id);

  res.json(db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(req.params.id));
});

// Step 3: disbursed from the nodal account (BRD 19.2) — has a real financial
// effect, logging an actual refund transaction against the order rather than
// just flipping a status label.
router.patch("/:id/disburse", (req, res) => {
  const refund = db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(req.params.id);
  if (!refund) return res.status(404).json({ error: "Refund request not found" });
  if (refund.status !== "approved") return res.status(400).json({ error: "Only an approved refund can be disbursed" });

  const now = new Date().toISOString();
  db.prepare("UPDATE refund_requests SET status = 'disbursed', resolved_at = ? WHERE id = ?").run(now, req.params.id);

  if (refund.order_id) {
    const txId = uuidv4();
    db.prepare(`
      INSERT INTO transactions (id, order_id, amount, payment_method, status)
      VALUES (?, ?, ?, 'Refund', 'refunded')
    `).run(txId, refund.order_id, -Math.abs(refund.requested_amount || 0));
    db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(refund.order_id);
  }

  res.json(db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(req.params.id));
});

router.delete("/:id", (req, res) => {
  const refund = db.prepare("SELECT id FROM refund_requests WHERE id = ?").get(req.params.id);
  if (!refund) return res.status(404).json({ error: "Refund request not found" });
  db.prepare("DELETE FROM refund_requests WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
