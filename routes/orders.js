const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { nextSequence } = require("../models/sequence");
const { resolveBulkDiscountPercent } = require("./pricingRules");
const { haversineKm } = require("../models/geo");

function generateOrderRef() {
  const year = new Date().getFullYear();
  const seq = nextSequence(`order_ref_${year}`);
  return `ORD-${year}-${String(seq).padStart(4, "0")}`;
}

// The closest hub (by straight-line distance) to a delivery point, among
// hubs that have actually been placed on the Geofencing Map — used to
// auto-suggest a hub for an order when a delivery location is given.
function resolveNearestHub(lat, lng) {
  if (lat == null || lng == null) return null;
  const hubs = db.prepare("SELECT name, latitude, longitude FROM hubs WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND status = 'active'").all();
  if (hubs.length === 0) return null;
  let best = null;
  for (const h of hubs) {
    const distanceKm = haversineKm(lat, lng, h.latitude, h.longitude);
    if (!best || distanceKm < best.distanceKm) best = { name: h.name, distanceKm: Math.round(distanceKm * 100) / 100 };
  }
  return best;
}

// ---- Customers ----
router.get("/customers", (req, res) => {
  res.json(db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all());
});

router.post("/customers", (req, res) => {
  const { name, phone, email, address } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = uuidv4();
  db.prepare("INSERT INTO customers (id, name, phone, email, address) VALUES (?, ?, ?, ?, ?)").run(id, name, phone, email, address);
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
});

// ---- Orders (each order can have one transaction recorded against it) ----
router.get("/", (req, res) => {
  const orders = db.prepare(`
    SELECT o.*,
      (SELECT t.payment_method FROM transactions t WHERE t.order_id = o.id ORDER BY t.created_at DESC LIMIT 1) as payment_method,
      (SELECT t.status FROM transactions t WHERE t.order_id = o.id ORDER BY t.created_at DESC LIMIT 1) as transaction_status,
      (SELECT t.id FROM transactions t WHERE t.order_id = o.id ORDER BY t.created_at DESC LIMIT 1) as transaction_id
    FROM orders o
    ORDER BY o.created_at DESC
  `).all();
  res.json(orders);
});

router.post("/", (req, res) => {
  const {
    customerName, customerId, productName, batchId, sellerName, riderName, quantity, amount, status, paymentMethod, couponCode,
    deliveryLatitude, deliveryLongitude, hubName,
  } = req.body;
  if (!customerName || !productName || !amount) {
    return res.status(400).json({ error: "customerName, productName and amount are required" });
  }

  // If a delivery location was given but no hub was explicitly chosen,
  // auto-assign the nearest hub — a real routing decision, not just a label.
  const resolvedHubName = hubName || (deliveryLatitude != null && deliveryLongitude != null
    ? resolveNearestHub(deliveryLatitude, deliveryLongitude)?.name || null
    : null);

  // Bulk/tiered pricing (always-on, no code needed) is applied first, then a
  // coupon (if any) discounts what's left — both are real amounts that
  // actually reduce what's charged, not just labels on the order.
  const bulkPct = resolveBulkDiscountPercent(productName, quantity);
  const bulkDiscountAmount = bulkPct ? Math.round(amount * (bulkPct / 100) * 100) / 100 : 0;
  const amountAfterBulk = Math.round((amount - bulkDiscountAmount) * 100) / 100;

  let finalAmount = amountAfterBulk;
  let discountAmount = 0;
  let coupon = null;
  if (couponCode) {
    coupon = db.prepare("SELECT * FROM coupons WHERE code = ?").get(couponCode.trim().toUpperCase());
    if (!coupon) return res.status(400).json({ error: "Coupon code not found" });
    if (coupon.status !== "active") return res.status(400).json({ error: "This coupon is not active" });
    const today = new Date().toISOString().slice(0, 10);
    if (coupon.valid_from && today < coupon.valid_from) return res.status(400).json({ error: "This coupon is not yet valid" });
    if (coupon.valid_to && today > coupon.valid_to) return res.status(400).json({ error: "This coupon has expired" });
    if (coupon.usage_limit && coupon.times_used >= coupon.usage_limit) return res.status(400).json({ error: "This coupon has reached its usage limit" });

    discountAmount = coupon.discount_type === "percent"
      ? Math.round(amountAfterBulk * (coupon.discount_value / 100) * 100) / 100
      : Math.min(coupon.discount_value, amountAfterBulk);
    finalAmount = Math.round((amountAfterBulk - discountAmount) * 100) / 100;
  }

  const id = uuidv4();
  const orderRef = generateOrderRef();
  db.prepare(`
    INSERT INTO orders (
      id, order_ref, customer_id, customer_name, product_name, batch_id, seller_name, rider_name, quantity, amount,
      status, coupon_code, discount_amount, bulk_discount_amount, delivery_latitude, delivery_longitude, hub_name
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, orderRef, customerId || null, customerName, productName, batchId || null, sellerName || null, riderName || null, quantity || null, finalAmount,
    status || "pending", coupon ? coupon.code : null, discountAmount, bulkDiscountAmount, deliveryLatitude ?? null, deliveryLongitude ?? null, resolvedHubName
  );

  if (coupon) {
    db.prepare("UPDATE coupons SET times_used = times_used + 1 WHERE id = ?").run(coupon.id);
  }

  // Recording an order as paid immediately logs a matching transaction
  if (status === "delivered" || status === "confirmed") {
    const txId = uuidv4();
    db.prepare(`
      INSERT INTO transactions (id, order_id, amount, payment_method, status)
      VALUES (?, ?, ?, ?, 'success')
    `).run(txId, id, finalAmount, paymentMethod || "UPI");
  }

  res.status(201).json(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
});

router.patch("/:id/status", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });

  const { status } = req.body;
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json(db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id));
});

// Assign (or reassign) which rider is delivering this order — the real
// dispatch event that later drives rider payout calculations.
router.patch("/:id/rider", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });

  db.prepare("UPDATE orders SET rider_name = ? WHERE id = ?").run(req.body.riderName || null, req.params.id);
  res.json(db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id));
});

// Assign (or reassign) which hub is fulfilling this order — manual override
// of whatever the nearest-hub routing picked (or a first assignment if the
// order was placed without a delivery location).
router.patch("/:id/hub", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });

  db.prepare("UPDATE orders SET hub_name = ? WHERE id = ?").run(req.body.hubName || null, req.params.id);
  res.json(db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id));
});

// Live preview for the New Order form — given a delivery point, which hub
// would be auto-assigned, before the order is actually created.
router.get("/nearest-hub", (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: "lat and lng are required" });
  res.json(resolveNearestHub(lat, lng));
});

router.delete("/:id", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  db.prepare("DELETE FROM transactions WHERE order_id = ?").run(req.params.id);
  db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- Exceptions (BRD ADM-04 dispatch/exception monitoring) ----
// Orders that have sat in "pending" past a threshold — a real SLA breach
// signal computed from actual order ages, not a placeholder metric.
router.get("/exceptions", (req, res) => {
  const hours = Number(req.query.hours) || 24;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM orders WHERE status = 'pending' AND created_at <= ? ORDER BY created_at ASC
  `).all(cutoff);
  res.json(rows.map(o => ({ ...o, hoursPending: Math.round((Date.now() - new Date(o.created_at).getTime()) / 36000) / 100 })));
});

// ---- Transactions ----
router.get("/transactions", (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, o.order_ref, o.customer_name, o.product_name
    FROM transactions t JOIN orders o ON o.id = t.order_id
    ORDER BY t.created_at DESC
  `).all();
  res.json(rows);
});

router.post("/:id/transactions", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });

  const { amount, paymentMethod, status } = req.body;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO transactions (id, order_id, amount, payment_method, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.params.id, amount ?? order.amount, paymentMethod || "UPI", status || "success");

  res.status(201).json(db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
});

module.exports = router;
