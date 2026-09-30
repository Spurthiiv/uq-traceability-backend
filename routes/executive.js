const express = require("express");
const router = express.Router();
const db = require("../db/init");

// CEO/district financial detail is ADMIN-only; Operations (mounted with
// ADMIN+OPS at the server level) stays open to both.
function adminOnly(req, res, next) {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Forbidden: insufficient role" });
  next();
}

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
