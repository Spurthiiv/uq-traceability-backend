const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { nextSequence } = require("../models/sequence");

function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const seq = nextSequence(`invoice_number_${year}`);
  return `INV-${year}-${String(seq).padStart(3, "0")}`;
}

function withOrder(row) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(row.order_id);
  return { ...row, order };
}

router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, o.order_ref, o.customer_name, o.product_name
    FROM invoices i JOIN orders o ON o.id = i.order_id
    ORDER BY i.created_at DESC
  `).all();
  res.json(rows);
});

router.get("/:id", (req, res) => {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  res.json(withOrder(invoice));
});

// Idempotent: returns the existing invoice for this order if one was already
// generated, otherwise creates one from the order's real (already-discounted)
// amount and the GST rate currently configured in Settings.
router.post("/generate/:orderId", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });

  const existing = db.prepare("SELECT * FROM invoices WHERE order_id = ?").get(order.id);
  if (existing) return res.json(withOrder(existing));

  const settings = db.prepare("SELECT gst_percent FROM settings WHERE id = 1").get();
  const gstPercent = settings.gst_percent || 0;
  const subtotal = order.amount || 0;
  // The order's own amount is already net of both a bulk pricing rule and a
  // coupon — combine them here so the invoice shows the real total discount
  // rather than just the coupon portion.
  const totalDiscount = (order.discount_amount || 0) + (order.bulk_discount_amount || 0);
  const gstAmount = Math.round(subtotal * (gstPercent / 100) * 100) / 100;
  const totalAmount = Math.round((subtotal + gstAmount) * 100) / 100;

  const id = uuidv4();
  const invoiceNumber = generateInvoiceNumber();
  db.prepare(`
    INSERT INTO invoices (id, invoice_number, order_id, subtotal, discount_amount, gst_percent, gst_amount, total_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, invoiceNumber, order.id, subtotal, totalDiscount, gstPercent, gstAmount, totalAmount);

  res.status(201).json(withOrder(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id)));
});

router.delete("/:id", (req, res) => {
  const invoice = db.prepare("SELECT id FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  db.prepare("DELETE FROM invoices WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
