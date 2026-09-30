const express = require("express");
const router = express.Router();
const db = require("../db/init");

// CEO / Investor Dashboard (BRD Section 34.4) — every figure here is derived
// from real orders/hubs/users/zones data already in the system. No fabricated
// metrics: where a concept (e.g. "funding book") has no real backing data
// anywhere in this app, it's simply left out rather than faked.
router.get("/ceo-summary", (req, res) => {
  const orders = db.prepare("SELECT * FROM orders").all();
  const revenueOrders = orders.filter(o => o.status === "delivered" || o.status === "confirmed");
  const gmv = revenueOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const totalOrders = orders.length;
  const aov = revenueOrders.length ? Math.round((gmv / revenueOrders.length) * 100) / 100 : 0;

  const activeHubs = db.prepare("SELECT COUNT(*) c FROM hubs WHERE status = 'active'").get().c;
  const totalHubs = db.prepare("SELECT COUNT(*) c FROM hubs").get().c;
  const activeQueens = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'QUEEN' AND (status IS NULL OR status = 'active')").get().c;
  const activeRiders = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'LOGISTICS' AND (status IS NULL OR status = 'active')").get().c;

  const settlements = db.prepare("SELECT amount, commission_percent, gross_order_value, refund_adjustment FROM settlements").all();
  const platformCommission = settlements.reduce((sum, s) => {
    const gross = s.gross_order_value || 0;
    return sum + Math.round(gross * ((s.commission_percent || 0) / 100) * 100) / 100;
  }, 0);

  // Month-over-month GMV and order-count trend, computed from real order
  // timestamps — however many months of real history exist, no padding.
  const monthKey = (iso) => (iso || "").slice(0, 7); // "YYYY-MM"
  const monthly = new Map();
  orders.forEach(o => {
    const key = monthKey(o.created_at);
    if (!key) return;
    if (!monthly.has(key)) monthly.set(key, { month: key, orders: 0, gmv: 0, customers: new Set() });
    const row = monthly.get(key);
    row.orders += 1;
    if (o.status === "delivered" || o.status === "confirmed") row.gmv += o.amount || 0;
    if (o.customer_name) row.customers.add(o.customer_name);
  });
  const growthTrend = [...monthly.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(r => ({ month: r.month, orders: r.orders, gmv: Math.round(r.gmv * 100) / 100, newCustomers: r.customers.size }));

  // Repeat-customer rate — a real loyalty signal from actual order counts per customer.
  const customerOrderCounts = new Map();
  orders.forEach(o => {
    if (!o.customer_name) return;
    customerOrderCounts.set(o.customer_name, (customerOrderCounts.get(o.customer_name) || 0) + 1);
  });
  const totalCustomers = customerOrderCounts.size;
  const repeatCustomers = [...customerOrderCounts.values()].filter(c => c > 1).length;
  const repeatRate = totalCustomers ? Math.round((repeatCustomers / totalCustomers) * 1000) / 10 : 0;

  // Ward/district growth — new zones and hubs actually created over time.
  const zones = db.prepare("SELECT zone_level, created_at FROM zones").all();
  const zoneGrowth = new Map();
  zones.forEach(z => {
    const key = monthKey(z.created_at);
    if (!key) return;
    if (!zoneGrowth.has(key)) zoneGrowth.set(key, { month: key, wards: 0, districts: 0 });
    const row = zoneGrowth.get(key);
    if (z.zone_level === "district") row.districts += 1;
    else row.wards += 1;
  });
  const zoneGrowthTrend = [...zoneGrowth.values()].sort((a, b) => a.month.localeCompare(b.month));

  res.json({
    gmv, totalOrders, aov, activeHubs, totalHubs, activeQueens, activeRiders,
    platformCommission, totalCustomers, repeatCustomers, repeatRate,
    growthTrend, zoneGrowthTrend,
  });
});

module.exports = router;
