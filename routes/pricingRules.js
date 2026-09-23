const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");

// ---- Commission rules (BRD ADM-05 — per-hub or per-seller commission override) ----
router.get("/commission-rules", (req, res) => {
  res.json(db.prepare("SELECT * FROM commission_rules ORDER BY created_at DESC").all());
});

router.post("/commission-rules", (req, res) => {
  const { scope, hubName, sellerName, commissionPercent } = req.body;
  if (scope !== "hub" && scope !== "seller") return res.status(400).json({ error: "scope must be 'hub' or 'seller'" });
  if (scope === "hub" && !hubName) return res.status(400).json({ error: "hubName is required for a hub-scoped rule" });
  if (scope === "seller" && !sellerName) return res.status(400).json({ error: "sellerName is required for a seller-scoped rule" });
  if (commissionPercent === undefined || commissionPercent === "") return res.status(400).json({ error: "commissionPercent is required" });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO commission_rules (id, scope, hub_name, seller_name, commission_percent)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, scope, scope === "hub" ? hubName : null, scope === "seller" ? sellerName : null, commissionPercent);
  res.status(201).json(db.prepare("SELECT * FROM commission_rules WHERE id = ?").get(id));
});

router.patch("/commission-rules/:id/status", (req, res) => {
  const rule = db.prepare("SELECT id FROM commission_rules WHERE id = ?").get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Commission rule not found" });
  db.prepare("UPDATE commission_rules SET status = ? WHERE id = ?").run(req.body.status, req.params.id);
  res.json(db.prepare("SELECT * FROM commission_rules WHERE id = ?").get(req.params.id));
});

router.delete("/commission-rules/:id", (req, res) => {
  const rule = db.prepare("SELECT id FROM commission_rules WHERE id = ?").get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Commission rule not found" });
  db.prepare("DELETE FROM commission_rules WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Looks up the active commission % override for a hub or seller — used by
// Finance when creating a settlement, and falls back to the caller's default.
function resolveCommissionPercent({ scope, hubName, sellerName }, fallbackPercent) {
  let rule;
  if (scope === "hub" && hubName) {
    rule = db.prepare("SELECT * FROM commission_rules WHERE scope = 'hub' AND hub_name = ? AND status = 'active'").get(hubName);
  } else if (scope === "seller" && sellerName) {
    rule = db.prepare("SELECT * FROM commission_rules WHERE scope = 'seller' AND seller_name = ? AND status = 'active'").get(sellerName);
  }
  return rule ? rule.commission_percent : fallbackPercent;
}

// ---- Bulk/tiered pricing rules (BRD ADM-05 — always-on quantity discounts) ----
router.get("/bulk-pricing-rules", (req, res) => {
  res.json(db.prepare("SELECT * FROM bulk_pricing_rules ORDER BY created_at DESC").all());
});

router.post("/bulk-pricing-rules", (req, res) => {
  const { productName, category, minQuantity, discountPercent } = req.body;
  if (!productName && !category) return res.status(400).json({ error: "Either productName or category is required" });
  if (productName && category) return res.status(400).json({ error: "Target either a product or a category, not both" });
  if (!minQuantity || !discountPercent) return res.status(400).json({ error: "minQuantity and discountPercent are required" });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO bulk_pricing_rules (id, product_name, category, min_quantity, discount_percent)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, productName || null, category || null, minQuantity, discountPercent);
  res.status(201).json(db.prepare("SELECT * FROM bulk_pricing_rules WHERE id = ?").get(id));
});

router.patch("/bulk-pricing-rules/:id/status", (req, res) => {
  const rule = db.prepare("SELECT id FROM bulk_pricing_rules WHERE id = ?").get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Bulk pricing rule not found" });
  db.prepare("UPDATE bulk_pricing_rules SET status = ? WHERE id = ?").run(req.body.status, req.params.id);
  res.json(db.prepare("SELECT * FROM bulk_pricing_rules WHERE id = ?").get(req.params.id));
});

router.delete("/bulk-pricing-rules/:id", (req, res) => {
  const rule = db.prepare("SELECT id FROM bulk_pricing_rules WHERE id = ?").get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Bulk pricing rule not found" });
  db.prepare("DELETE FROM bulk_pricing_rules WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Finds the best-matching active bulk rule for a product+quantity (the
// product's own rule takes priority over a category-wide one; the highest
// discount wins if several thresholds are met) — used by Orders on creation.
function resolveBulkDiscountPercent(productName, quantity) {
  if (!quantity) return 0;
  const product = db.prepare("SELECT category FROM products WHERE name = ?").get(productName);
  const candidates = db.prepare(`
    SELECT * FROM bulk_pricing_rules
    WHERE status = 'active' AND min_quantity <= ?
      AND (product_name = ? OR (category IS NOT NULL AND category = ?))
  `).all(quantity, productName, product ? product.category : null);
  if (candidates.length === 0) return 0;
  const productMatch = candidates.filter(r => r.product_name === productName);
  const pool = productMatch.length > 0 ? productMatch : candidates;
  return Math.max(...pool.map(r => r.discount_percent));
}

module.exports = router;
module.exports.resolveCommissionPercent = resolveCommissionPercent;
module.exports.resolveBulkDiscountPercent = resolveBulkDiscountPercent;
