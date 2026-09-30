const express = require("express");
const router = express.Router();
const db = require("../db/init");

// CEO/district financial detail is ADMIN-only; Operations (mounted with
// ADMIN+OPS at the server level) stays open to both.
function adminOnly(req, res, next) {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Forbidden: insufficient role" });
  next();
}

// CEO / Investor Dashboard (BRD Section 34.4) — every figure here is derived
// from real orders/hubs/users/zones data already in the system. No fabricated
// metrics: where a concept (e.g. "funding book") has no real backing data
// anywhere in this app, it's simply left out rather than faked.
router.get("/ceo-summary", adminOnly, (req, res) => {
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

// District / State Dashboard (BRD Section 34.4) — a roll-up of every hub and
// ward beneath each district-level zone, computed by walking the real zone
// parent/child tree rather than assuming a fixed depth.
router.get("/district-summary", adminOnly, (req, res) => {
  const zones = db.prepare("SELECT * FROM zones").all();
  const hubs = db.prepare("SELECT * FROM hubs").all();
  const orders = db.prepare("SELECT * FROM orders").all();
  const complaints = db.prepare("SELECT * FROM complaints").all();
  const refunds = db.prepare("SELECT * FROM refund_requests").all();

  const childrenOf = new Map();
  zones.forEach(z => {
    const key = z.parent_zone_id || "__root__";
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(z);
  });

  // Every zone (of any level) reachable under a district, including itself.
  function collectDescendants(zoneId) {
    const result = [zoneId];
    const queue = [...(childrenOf.get(zoneId) || [])];
    while (queue.length) {
      const z = queue.shift();
      result.push(z.id);
      queue.push(...(childrenOf.get(z.id) || []));
    }
    return result;
  }

  const districts = zones.filter(z => z.zone_level === "district");
  const summary = districts.map(district => {
    const descendantZoneIds = new Set(collectDescendants(district.id));
    const wardZones = zones.filter(z => descendantZoneIds.has(z.id) && z.id !== district.id);
    const districtHubs = hubs.filter(h => h.zone_id && descendantZoneIds.has(h.zone_id));
    const hubNames = new Set(districtHubs.map(h => h.name));

    const districtOrders = orders.filter(o => o.hub_name && hubNames.has(o.hub_name));
    const revenue = districtOrders.filter(o => o.status === "delivered" || o.status === "confirmed").reduce((s, o) => s + (o.amount || 0), 0);
    const sellers = new Set(districtOrders.filter(o => o.seller_name).map(o => o.seller_name));
    const stalePending = districtOrders.filter(o => o.status === "pending").length;

    const districtOrderIds = new Set(districtOrders.map(o => o.id));
    const districtComplaints = complaints.filter(c => c.order_id && districtOrderIds.has(c.order_id));
    const districtRefunds = refunds.filter(r => r.order_id && districtOrderIds.has(r.order_id));

    return {
      districtId: district.id,
      districtName: district.name,
      wardCount: wardZones.length,
      activeHubCount: districtHubs.filter(h => h.status === "active").length,
      totalHubCount: districtHubs.length,
      sellerCount: sellers.size,
      orderCount: districtOrders.length,
      revenue: Math.round(revenue * 100) / 100,
      stalePendingOrders: stalePending,
      complaintCount: districtComplaints.length,
      refundCount: districtRefunds.length,
    };
  });

  res.json(summary);
});

// Operations Dashboard (BRD Section 34.4) — real dispatch/SLA/escalation
// signals only. "Hub audit status" from the BRD has no real data behind it
// anywhere in this app (no audit-scheduling feature exists yet), so it's
// deliberately left out here rather than faked — the frontend says so.
router.get("/operations-summary", (req, res) => {
  const orders = db.prepare("SELECT * FROM orders").all();
  const complaints = db.prepare("SELECT * FROM complaints").all();

  const statusCounts = {};
  orders.forEach(o => { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; });

  const slaHours = 24;
  const cutoff = new Date(Date.now() - slaHours * 60 * 60 * 1000).toISOString();
  const slaBreaches = orders.filter(o => o.status === "pending" && o.created_at <= cutoff);

  const escalations = complaints.filter(c => c.priority === "High" && c.status !== "resolved");

  const riderLoad = new Map();
  orders.filter(o => o.rider_name && o.status !== "delivered" && o.status !== "cancelled").forEach(o => {
    riderLoad.set(o.rider_name, (riderLoad.get(o.rider_name) || 0) + 1);
  });

  const hubLoad = new Map();
  orders.filter(o => o.hub_name && o.status !== "delivered" && o.status !== "cancelled").forEach(o => {
    hubLoad.set(o.hub_name, (hubLoad.get(o.hub_name) || 0) + 1);
  });

  res.json({
    statusCounts,
    slaHours,
    slaBreachCount: slaBreaches.length,
    escalationCount: escalations.length,
    escalations: escalations.map(c => ({ id: c.id, complainantName: c.complainant_name, description: c.description, category: c.category, createdAt: c.created_at })),
    riderLoad: [...riderLoad.entries()].map(([rider, activeOrders]) => ({ rider, activeOrders })),
    hubLoad: [...hubLoad.entries()].map(([hub, activeOrders]) => ({ hub, activeOrders })),
  });
});

module.exports = router;
