const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");

// BRD Section 7.6 ADM-05: promotions. Real coupon records that are actually
// applied to orders (see routes/orders.js), not just a management screen
// with no effect on totals.
router.get("/", (req, res) => {
  res.json(db.prepare("SELECT * FROM coupons ORDER BY created_at DESC").all());
});

router.post("/", (req, res) => {
  const { code, discountType, discountValue, validFrom, validTo, usageLimit } = req.body;
  if (!code || !discountValue) return res.status(400).json({ error: "code and discountValue are required" });
  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO coupons (id, code, discount_type, discount_value, valid_from, valid_to, usage_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, code.trim().toUpperCase(), discountType || "percent", discountValue, validFrom || null, validTo || null, usageLimit || null);
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ error: "A coupon with this code already exists" });
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json(db.prepare("SELECT * FROM coupons WHERE id = ?").get(id));
});

router.patch("/:id/status", (req, res) => {
  const coupon = db.prepare("SELECT id FROM coupons WHERE id = ?").get(req.params.id);
  if (!coupon) return res.status(404).json({ error: "Coupon not found" });
  db.prepare("UPDATE coupons SET status = ? WHERE id = ?").run(req.body.status, req.params.id);
  res.json(db.prepare("SELECT * FROM coupons WHERE id = ?").get(req.params.id));
});

router.delete("/:id", (req, res) => {
  const coupon = db.prepare("SELECT id FROM coupons WHERE id = ?").get(req.params.id);
  if (!coupon) return res.status(404).json({ error: "Coupon not found" });
  db.prepare("DELETE FROM coupons WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Validates a code against status/date/usage-limit and returns the coupon —
// used by the order form to actually compute a discount before creating the order.
router.get("/validate/:code", (req, res) => {
  const coupon = db.prepare("SELECT * FROM coupons WHERE code = ?").get(req.params.code.trim().toUpperCase());
  if (!coupon) return res.status(404).json({ error: "Coupon code not found" });
  if (coupon.status !== "active") return res.status(400).json({ error: "This coupon is not active" });
  const today = new Date().toISOString().slice(0, 10);
  if (coupon.valid_from && today < coupon.valid_from) return res.status(400).json({ error: "This coupon is not yet valid" });
  if (coupon.valid_to && today > coupon.valid_to) return res.status(400).json({ error: "This coupon has expired" });
  if (coupon.usage_limit && coupon.times_used >= coupon.usage_limit) return res.status(400).json({ error: "This coupon has reached its usage limit" });
  res.json(coupon);
});

module.exports = router;
