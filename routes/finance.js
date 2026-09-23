const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { nextSequence } = require("../models/sequence");
const { resolveCommissionPercent } = require("./pricingRules");

// A cleared number input sends '' (not null/undefined), which `??` would not
// catch — treat both as "no override" so a blank Commission % field actually
// falls through to the resolved default instead of silently becoming 0%.
function numberOrDefault(value, fallback) {
  return value === "" || value === undefined || value === null ? fallback : Number(value);
}

function generateSettlementCode() {
  const year = new Date().getFullYear();
  const seq = nextSequence(`settlement_code_${year}`);
  return `SET-${year}-${String(seq).padStart(3, "0")}`;
}

// Adds the derived fields every settlement response needs: commission amount
// (gross * pct) and net payable (gross - commission - refund/adjustment).
function withComputedFields(row) {
  const gross = row.gross_order_value || 0;
  const pct = row.commission_percent || 0;
  const commissionAmount = Math.round(gross * (pct / 100) * 100) / 100;
  const refund = row.refund_adjustment || 0;
  const netPayable = Math.round((gross - commissionAmount - refund) * 100) / 100;
  return { ...row, commissionAmount, netPayable };
}

router.get("/settlements", (req, res) => {
  const { type } = req.query;
  const rows = type
    ? db.prepare("SELECT * FROM settlements WHERE settlement_type = ? ORDER BY created_at DESC").all(type)
    : db.prepare("SELECT * FROM settlements ORDER BY created_at DESC").all();
  res.json(rows.map(withComputedFields));
});

router.get("/settlements/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM settlements WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Settlement not found" });
  res.json(withComputedFields(row));
});

router.post("/settlements", (req, res) => {
  const {
    settlementType, cpId, hubName, sellerName, riderName, orderRef, period,
    grossOrderValue, commissionPercent, ordersCount, refundAdjustment,
  } = req.body;

  const type = ["seller", "rider"].includes(settlementType) ? settlementType : "cp_hub";
  if (type === "seller" && !sellerName) return res.status(400).json({ error: "sellerName is required for a seller settlement" });
  if (type === "rider" && !riderName) return res.status(400).json({ error: "riderName is required for a rider settlement" });
  if (type === "cp_hub" && !cpId) return res.status(400).json({ error: "cpId is required for a CP/Hub settlement" });

  const id = uuidv4();
  const settlementCode = generateSettlementCode();
  const settings = db.prepare("SELECT default_cp_commission_percent FROM settings WHERE id = 1").get();
  // Riders are paid a flat delivery fee, not a commission cut — default their
  // rate to 0%. A seller or hub with an active commission rule gets that rate
  // instead of the settings-wide default, unless the admin overrides it here.
  const defaultPct = type === "rider" ? 0
    : type === "seller" ? resolveCommissionPercent({ scope: "seller", sellerName }, settings.default_cp_commission_percent)
    : resolveCommissionPercent({ scope: "hub", hubName }, settings.default_cp_commission_percent);
  const pct = numberOrDefault(commissionPercent, defaultPct);
  const gross = grossOrderValue || 0;
  const commissionAmount = Math.round(gross * (pct / 100) * 100) / 100;

  db.prepare(`
    INSERT INTO settlements (
      id, settlement_code, settlement_type, cp_id, hub_name, seller_name, rider_name, order_ref,
      amount, period, gross_order_value, commission_percent, orders_count, refund_adjustment
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    // cp_id is NOT NULL in the original schema (from before seller settlements
    // existed) — use '' rather than null for seller-type rows so the insert
    // doesn't violate that constraint.
    id, settlementCode, type, cpId || "", hubName || null, sellerName || null, riderName || null, orderRef || null,
    commissionAmount, period || null, gross, pct, ordersCount || 0, refundAdjustment || 0
  );

  res.status(201).json(withComputedFields(db.prepare("SELECT * FROM settlements WHERE id = ?").get(id)));
});

// Edit a settlement's own figures (not just its status) — e.g. correcting the
// gross value, commission %, refund/adjustment, orders count or period after
// creation, including after it's already been marked Paid.
router.patch("/settlements/:id", (req, res) => {
  const settlement = db.prepare("SELECT * FROM settlements WHERE id = ?").get(req.params.id);
  if (!settlement) return res.status(404).json({ error: "Settlement not found" });

  const {
    cpId, hubName, sellerName, riderName, period,
    grossOrderValue, commissionPercent, ordersCount, refundAdjustment,
  } = req.body;

  const gross = grossOrderValue ?? settlement.gross_order_value;
  const resolvedHubName = hubName ?? settlement.hub_name;
  const resolvedSellerName = settlement.settlement_type === "seller" ? (sellerName ?? settlement.seller_name) : null;
  const settings = db.prepare("SELECT default_cp_commission_percent FROM settings WHERE id = 1").get();
  const defaultPct = settlement.settlement_type === "rider" ? 0
    : settlement.settlement_type === "seller" ? resolveCommissionPercent({ scope: "seller", sellerName: resolvedSellerName }, settings.default_cp_commission_percent)
    : resolveCommissionPercent({ scope: "hub", hubName: resolvedHubName }, settings.default_cp_commission_percent);
  const pct = numberOrDefault(commissionPercent, numberOrDefault(settlement.commission_percent, defaultPct));
  const commissionAmount = Math.round(gross * (pct / 100) * 100) / 100;

  db.prepare(`
    UPDATE settlements SET
      cp_id = ?, hub_name = ?, seller_name = ?, rider_name = ?, period = ?,
      gross_order_value = ?, commission_percent = ?, orders_count = ?, refund_adjustment = ?,
      amount = ?
    WHERE id = ?
  `).run(
    settlement.settlement_type === "cp_hub" ? (cpId ?? settlement.cp_id) : settlement.cp_id,
    hubName ?? settlement.hub_name,
    settlement.settlement_type === "seller" ? (sellerName ?? settlement.seller_name) : settlement.seller_name,
    settlement.settlement_type === "rider" ? (riderName ?? settlement.rider_name) : settlement.rider_name,
    period ?? settlement.period,
    gross, pct, ordersCount ?? settlement.orders_count, refundAdjustment ?? settlement.refund_adjustment,
    commissionAmount,
    req.params.id
  );

  res.json(withComputedFields(db.prepare("SELECT * FROM settlements WHERE id = ?").get(req.params.id)));
});

// Generalized status update — covers Pending -> Processing -> Paid, and records
// payment method / transaction reference / settlement date when marked Paid.
router.patch("/settlements/:id/status", (req, res) => {
  const settlement = db.prepare("SELECT * FROM settlements WHERE id = ?").get(req.params.id);
  if (!settlement) return res.status(404).json({ error: "Settlement not found" });

  const { status, paymentMethod, transactionReference } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });

  const settlementDate = status === "released" ? new Date().toISOString() : settlement.settlement_date;
  db.prepare(`
    UPDATE settlements SET status = ?, payment_method = ?, transaction_reference = ?, settlement_date = ?
    WHERE id = ?
  `).run(status, paymentMethod || settlement.payment_method, transactionReference || settlement.transaction_reference, settlementDate, req.params.id);

  res.json(withComputedFields(db.prepare("SELECT * FROM settlements WHERE id = ?").get(req.params.id)));
});

// Kept for backward compatibility with the old "release" action.
router.patch("/settlements/:id/release", (req, res) => {
  db.prepare("UPDATE settlements SET status = 'released', settlement_date = ? WHERE id = ?")
    .run(new Date().toISOString(), req.params.id);
  res.json(withComputedFields(db.prepare("SELECT * FROM settlements WHERE id = ?").get(req.params.id)));
});

router.delete("/settlements/:id", (req, res) => {
  const settlement = db.prepare("SELECT id FROM settlements WHERE id = ?").get(req.params.id);
  if (!settlement) return res.status(404).json({ error: "Settlement not found" });
  db.prepare("DELETE FROM settlements WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- Finance summary for the top cards + seller payouts ----
router.get("/summary", (req, res) => {
  const orders = db.prepare("SELECT * FROM orders").all();
  const settlements = db.prepare("SELECT * FROM settlements").all().map(withComputedFields);
  const transactions = db.prepare("SELECT * FROM transactions").all();

  const totalRevenue = orders
    .filter(o => o.status === "delivered" || o.status === "confirmed")
    .reduce((sum, o) => sum + (o.amount || 0), 0);

  const released = settlements.filter(s => s.status === "released");
  const pending = settlements.filter(s => s.status !== "released");
  const cpHubSettlements = settlements.filter(s => s.settlement_type === "cp_hub");
  const sellerSettlements = settlements.filter(s => s.settlement_type === "seller");

  // Seller and rider settlements pay out netPayable (gross minus commission
  // and refund adjustments); a CP/Hub settlement's "amount" IS its payout
  // (their commission cut), so that one alone uses amount directly.
  const payoutFigure = (s) => (s.settlement_type === "cp_hub" ? s.amount : s.netPayable);
  const totalReleased = released.reduce((sum, s) => sum + payoutFigure(s), 0);
  const pendingSettlements = pending.reduce((sum, s) => sum + payoutFigure(s), 0);
  const platformCommission = settlements.reduce((sum, s) => sum + s.commissionAmount, 0);
  const cpCommission = cpHubSettlements.reduce((sum, s) => sum + s.amount, 0);
  const sellerNetPayable = sellerSettlements.reduce((sum, s) => sum + s.netPayable, 0);
  const failedTransactions = transactions.filter(t => t.status === "failed").length;

  // Seller payouts broken down by seller_name (from delivered/confirmed orders) —
  // a live estimate for sellers who don't have a persisted settlement record yet.
  const sellerGroups = new Map();
  orders.filter(o => o.status === "delivered" || o.status === "confirmed").forEach(o => {
    const key = o.seller_name || "Unassigned";
    sellerGroups.set(key, (sellerGroups.get(key) || 0) + (o.amount || 0));
  });
  const settings = db.prepare("SELECT default_cp_commission_percent, delivery_fee FROM settings WHERE id = 1").get();
  const pct = settings.default_cp_commission_percent;
  const sellerPayoutRows = [...sellerGroups.entries()].map(([seller, gross]) => ({
    seller, grossOrderValue: gross,
    commission: Math.round(gross * (pct / 100) * 100) / 100,
    payout: Math.round((gross - gross * (pct / 100)) * 100) / 100,
  }));

  // Rider payouts broken down by rider_name — a flat fee per delivered order
  // (Settings > Finance > Delivery Fee), for riders who don't have a
  // persisted rider settlement record yet.
  const riderSettlements = settlements.filter(s => s.settlement_type === "rider");
  const riderNetPayable = riderSettlements.reduce((sum, s) => sum + s.netPayable, 0);
  const deliveryFee = settings.delivery_fee || 0;
  const riderGroups = new Map();
  orders.filter(o => o.status === "delivered" && o.rider_name).forEach(o => {
    riderGroups.set(o.rider_name, (riderGroups.get(o.rider_name) || 0) + 1);
  });
  const riderPayoutRows = [...riderGroups.entries()].map(([rider, deliveries]) => ({
    rider, deliveries, payout: Math.round(deliveries * deliveryFee * 100) / 100,
  }));

  res.json({
    totalRevenue, totalReleased, pendingSettlements, cpCommission, platformCommission,
    sellerPayouts: sellerNetPayable, riderPayouts: riderNetPayable, failedTransactions,
    completedSettlementsCount: released.length,
    pendingSettlementsCount: pending.length,
    sellerPayoutRows, riderPayoutRows, deliveryFee,
    totalOrders: orders.length,
    totalTransactions: transactions.length,
    defaultCpCommissionPercent: pct,
  });
});

module.exports = router;
