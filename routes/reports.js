const express = require("express");
const router = express.Router();
const db = require("../db/init");
const { verifyChain } = require("../models/ledger");
const { STAGES } = require("../models/stages");

function applyBatchFilters(rows, { product, status, dateFrom, dateTo }) {
  return rows.filter(b => {
    if (product && b.product_name !== product) return false;
    if (status && (b.status || "").toUpperCase() !== status.toUpperCase()) return false;
    if (dateFrom && b.created_at < dateFrom) return false;
    if (dateTo && b.created_at > dateTo + "T23:59:59.999Z") return false;
    return true;
  });
}

router.get("/summary", (req, res) => {
  const { product, status, dateFrom, dateTo, complaintStatus, seller, hub } = req.query;

  const allBatches = db.prepare("SELECT * FROM batches").all();
  const filteredBatches = applyBatchFilters(allBatches, { product, status, dateFrom, dateTo });

  const isDelivered = (b) => (b.status || "").toUpperCase() === "DELIVERED";

  // ---- Summary cards (always global, not affected by filters) ----
  const totalProducts = db.prepare("SELECT COUNT(*) c FROM products").get().c;
  const totalBatches = allBatches.length;
  const deliveredBatches = allBatches.filter(isDelivered).length;
  const pendingBatches = totalBatches - deliveredBatches;
  const qualityPassed = db.prepare("SELECT COUNT(*) c FROM qc_checks WHERE result = 'passed'").get().c;
  const openComplaints = db.prepare("SELECT COUNT(*) c FROM complaints WHERE status = 'pending'").get().c;
  const totalReleased = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM settlements WHERE status = 'released'").get().t;
  const allOrders = db.prepare("SELECT * FROM orders").all();
  const totalOrders = allOrders.length;
  const totalRevenue = allOrders.filter(o => o.status === "delivered" || o.status === "confirmed").reduce((sum, o) => sum + (o.amount || 0), 0);

  // ---- Section 1: Batches by status (filtered) ----
  const statusGroups = new Map();
  filteredBatches.forEach(b => {
    const s = (b.status || "unknown").toUpperCase();
    statusGroups.set(s, (statusGroups.get(s) || 0) + 1);
  });
  const batchesByStatus = [...statusGroups.entries()].map(([s, count]) => ({
    status: s, count, percentage: filteredBatches.length ? Math.round((count / filteredBatches.length) * 1000) / 10 : 0
  })).sort((a, b) => b.count - a.count);

  // ---- Section 2: Top products (filtered) ----
  const productGroups = new Map();
  filteredBatches.forEach(b => {
    if (!productGroups.has(b.product_name)) productGroups.set(b.product_name, []);
    productGroups.get(b.product_name).push(b);
  });
  const topProducts = [...productGroups.entries()].map(([name, batches]) => {
    const delivered = batches.filter(isDelivered).length;
    return {
      product_name: name,
      batches: batches.length,
      totalQuantity: batches.reduce((sum, b) => sum + (b.quantity || 0), 0),
      delivered,
      status: delivered === batches.length ? "Delivered" : delivered > 0 ? "Partially Delivered" : "In Progress",
    };
  }).sort((a, b) => b.batches - a.batches);

  // ---- Section 3: Quality analytics ----
  const totalChecks = db.prepare("SELECT COUNT(*) c FROM qc_checks").get().c;
  const passedChecks = qualityPassed;
  const failedChecks = totalChecks - passedChecks;
  let complaintQuery = "SELECT * FROM complaints";
  const complaintParams = [];
  if (complaintStatus) { complaintQuery += " WHERE status = ?"; complaintParams.push(complaintStatus); }
  const complaintRows = db.prepare(complaintQuery).all(...complaintParams);
  const quality = {
    totalChecks, passed: passedChecks, failed: failedChecks,
    pending: 0, // this schema has no "queued/unresolved" QC state — every check is created already resolved
    passRate: totalChecks ? Math.round((passedChecks / totalChecks) * 1000) / 10 : 0,
    complaints: {
      open: complaintRows.filter(c => c.status === "pending").length,
      investigating: 0, // not tracked in the current complaints schema
      resolved: complaintRows.filter(c => c.status === "resolved").length,
      rejected: 0, // not tracked in the current complaints schema
    },
  };

  // ---- Section 4: Finance analytics ----
  let settlementRows = db.prepare("SELECT * FROM settlements").all();
  if (hub) settlementRows = settlementRows.filter(s => s.hub_name === hub);
  if (seller) settlementRows = settlementRows.filter(s => s.cp_id === seller);
  const settings = db.prepare("SELECT default_cp_commission_percent, settlement_cycle, minimum_settlement_amount FROM settings WHERE id = 1").get();
  const finance = {
    totalReleased,
    pendingSettlements: settlementRows.filter(s => s.status === "pending").reduce((sum, s) => sum + (s.amount || 0), 0),
    totalSettlements: settlementRows.length,
    cpCommissionPercent: settings.default_cp_commission_percent,
    settlementCycle: settings.settlement_cycle,
  };

  // ---- Section 5: Users & operations ----
  const roleCounts = db.prepare("SELECT role, COUNT(*) c FROM users GROUP BY role").all();
  const countFor = (role) => (roleCounts.find(r => r.role === role) || {}).c || 0;
  const totalUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE status IS NULL OR status = 'active'").get().c;
  const operations = {
    totalUsers, admins: countFor("ADMIN"), ops: countFor("OPS"), queens: countFor("QUEEN"),
    retailers: countFor("RETAILER"), logistics: countFor("LOGISTICS"),
    active: activeUsers, inactive: totalUsers - activeUsers,
  };

  // ---- Section 6: Traceability analytics ----
  const qrBound = db.prepare("SELECT COUNT(DISTINCT batch_id) c FROM ledger WHERE event_type = 'QR_BOUND'").get().c;
  const ledgerRecords = db.prepare("SELECT COUNT(*) c FROM ledger").get().c;
  const verifiedCount = allBatches.filter(b => verifyChain(b.id).valid).length;
  const traceability = {
    totalBatches, qrBound, verified: verifiedCount, unverified: totalBatches - verifiedCount,
    ledgerRecords, totalEvents: ledgerRecords,
  };

  // ---- Section 7: Recent activity (unified feed, filtered batches only where applicable) ----
  const filteredIds = new Set(filteredBatches.map(b => b.id));
  const ledgerActivity = db.prepare(`
    SELECT l.timestamp as time, l.event_type, b.product_name, b.batch_code, b.id as batch_id
    FROM ledger l JOIN batches b ON b.id = l.batch_id
    ORDER BY l.timestamp DESC LIMIT 50
  `).all().filter(r => filteredIds.has(r.batch_id)).map(r => ({
    time: r.time, activity: `Batch Event: ${r.event_type}`,
    entity: `${r.product_name} (${r.batch_code || r.batch_id.slice(0, 8)})`, status: "Completed"
  }));
  const qcActivity = db.prepare(`
    SELECT qc.created_at as time, qc.result, qc.batch_id, b.product_name
    FROM qc_checks qc JOIN batches b ON b.id = qc.batch_id
    ORDER BY qc.created_at DESC LIMIT 20
  `).all().filter(r => filteredIds.has(r.batch_id)).map(r => ({
    time: r.time, activity: "Quality Check", entity: r.product_name,
    status: r.result === "passed" ? "Passed" : "Failed"
  }));
  // A complaint's batch is optional, so one with no batch_id can't be matched
  // against the product/status/date filters — keep it visible either way
  // rather than silently dropping it.
  const complaintActivity = complaintRows
    .filter(c => !c.batch_id || filteredIds.has(c.batch_id))
    .slice(0, 20).map(c => ({
      time: c.created_at, activity: "Complaint", entity: c.complainant_name || "Unknown",
      status: c.status === "resolved" ? "Resolved" : "Open"
    }));
  const recentActivity = [...ledgerActivity, ...qcActivity, ...complaintActivity]
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 25);

  // ---- Supply chain funnel: how many batches currently sit at each stage ----
  const stageCounts = new Map(STAGES.map(s => [s.key, 0]));
  filteredBatches.forEach(b => {
    const key = (b.status || "").toUpperCase();
    if (stageCounts.has(key)) stageCounts.set(key, stageCounts.get(key) + 1);
  });
  const supplyChainFunnel = STAGES.map(s => ({ stage: s.key, label: s.label, icon: s.icon, count: stageCounts.get(s.key) || 0 }));

  // ---- Orders over time / revenue over time (grouped by day) ----
  const byDay = new Map();
  allOrders.forEach(o => {
    const day = (o.created_at || "").slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { date: day, orders: 0, revenue: 0 });
    const row = byDay.get(day);
    row.orders += 1;
    if (o.status === "delivered" || o.status === "confirmed") row.revenue += o.amount || 0;
  });
  const ordersOverTime = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ---- CP performance (settlements grouped by CP) ----
  const allSettlements = db.prepare("SELECT * FROM settlements").all();
  const cpGroups = new Map();
  allSettlements.forEach(s => {
    if (!cpGroups.has(s.cp_id)) cpGroups.set(s.cp_id, { cpId: s.cp_id, settlements: 0, totalCommission: 0, released: 0, pending: 0 });
    const row = cpGroups.get(s.cp_id);
    row.settlements += 1;
    row.totalCommission += s.amount || 0;
    if (s.status === "released") row.released += s.amount || 0;
    else row.pending += s.amount || 0;
  });
  const cpPerformance = [...cpGroups.values()];

  // ---- Seller performance (orders grouped by seller) ----
  const sellerGroups = new Map();
  allOrders.forEach(o => {
    const key = o.seller_name || "Unassigned";
    if (!sellerGroups.has(key)) sellerGroups.set(key, { seller: key, orders: 0, revenue: 0, delivered: 0 });
    const row = sellerGroups.get(key);
    row.orders += 1;
    if (o.status === "delivered" || o.status === "confirmed") row.revenue += o.amount || 0;
    if (o.status === "delivered") row.delivered += 1;
  });
  const sellerPerformance = [...sellerGroups.values()];

  res.json({
    summary: {
      totalProducts, totalBatches, deliveredBatches, pendingBatches,
      qualityPassed, openComplaints, totalOrders, totalRevenue,
    },
    batchesByStatus, topProducts, quality, finance, operations, traceability, recentActivity,
    supplyChainFunnel, ordersOverTime, cpPerformance, sellerPerformance,
    filteredBatchCount: filteredBatches.length,
  });
});

module.exports = router;
