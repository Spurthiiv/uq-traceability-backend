const express = require("express");
const router = express.Router();
const db = require("../db/init");

// These three endpoints give the actual CONTENT of the BRD's Queen Seller /
// CP-Hub / Rider dashboards (items 8, 5, 9) — but since real per-user login
// was just removed at the user's request, there's no session identity to
// scope these to automatically. Instead the frontend lets you pick which
// seller/hub/rider to view, and these endpoints return ONLY that one
// person's/hub's real data, matching what that person would see if they
// had their own restricted login.

// ---- Queen Seller Dashboard ----
router.get("/sellers", (req, res) => {
  const sellers = db.prepare("SELECT id, name FROM users WHERE role = 'QUEEN' ORDER BY name").all();
  res.json(sellers);
});

router.get("/seller/:name", (req, res) => {
  const sellerName = req.params.name;
  const products = db.prepare("SELECT * FROM products WHERE seller_name = ?").all(sellerName);
  const orders = db.prepare("SELECT * FROM orders WHERE seller_name = ? ORDER BY created_at DESC").all(sellerName);
  const settlements = db.prepare("SELECT * FROM settlements WHERE settlement_type = 'seller' AND seller_name = ? ORDER BY created_at DESC").all(sellerName);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todaysOrders = orders.filter(o => (o.created_at || "").slice(0, 10) === todayStr);
  const pendingOrders = orders.filter(o => o.status === "pending");
  const revenueOrders = orders.filter(o => o.status === "delivered" || o.status === "confirmed");
  const totalSales = revenueOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const pendingSettlements = settlements.filter(s => s.status !== "released");

  res.json({
    sellerName,
    productCount: products.length,
    products,
    todaysOrderCount: todaysOrders.length,
    pendingOrderCount: pendingOrders.length,
    totalOrders: orders.length,
    totalSales: Math.round(totalSales * 100) / 100,
    orders: orders.slice(0, 25),
    settlements,
    pendingSettlementCount: pendingSettlements.length,
  });
});

// ---- CP / Queen Hub Dashboard ----
router.get("/hubs", (req, res) => {
  res.json(db.prepare("SELECT id, name FROM hubs ORDER BY name").all());
});

router.get("/hub/:name", (req, res) => {
  const hubName = req.params.name;
  const orders = db.prepare("SELECT * FROM orders WHERE hub_name = ? ORDER BY created_at DESC").all(hubName);
  const settlements = db.prepare("SELECT * FROM settlements WHERE settlement_type = 'cp_hub' AND hub_name = ? ORDER BY created_at DESC").all(hubName);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todaysOrders = orders.filter(o => (o.created_at || "").slice(0, 10) === todayStr);
  const pendingOrders = orders.filter(o => o.status === "pending");
  const sellers = new Set(orders.filter(o => o.seller_name).map(o => o.seller_name));
  const revenueOrders = orders.filter(o => o.status === "delivered" || o.status === "confirmed");
  const grossValue = revenueOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

  res.json({
    hubName,
    todaysOrderCount: todaysOrders.length,
    pendingOrderCount: pendingOrders.length,
    totalOrders: orders.length,
    sellerCount: sellers.size,
    grossOrderValue: Math.round(grossValue * 100) / 100,
    orders: orders.slice(0, 25),
    settlements,
  });
});

// ---- Queen Rider Dashboard ----
router.get("/riders", (req, res) => {
  res.json(db.prepare("SELECT id, name, is_online FROM users WHERE role = 'LOGISTICS' ORDER BY name").all());
});

router.get("/rider/:name", (req, res) => {
  const riderName = req.params.name;
  const orders = db.prepare("SELECT * FROM orders WHERE rider_name = ? ORDER BY created_at DESC").all(riderName);
  const settlements = db.prepare("SELECT * FROM settlements WHERE settlement_type = 'rider' AND rider_name = ? ORDER BY created_at DESC").all(riderName);
  const settings = db.prepare("SELECT delivery_fee FROM settings WHERE id = 1").get();

  const activeOrders = orders.filter(o => o.status !== "delivered" && o.status !== "cancelled");
  const deliveredOrders = orders.filter(o => o.status === "delivered");
  const estimatedEarnings = Math.round(deliveredOrders.length * (settings.delivery_fee || 0) * 100) / 100;
  const settledEarnings = settlements.reduce((sum, s) => {
    const gross = s.gross_order_value || 0;
    const commission = Math.round(gross * ((s.commission_percent || 0) / 100) * 100) / 100;
    return sum + Math.round((gross - commission - (s.refund_adjustment || 0)) * 100) / 100;
  }, 0);

  const user = db.prepare("SELECT is_online FROM users WHERE role = 'LOGISTICS' AND name = ?").get(riderName);

  res.json({
    riderName,
    isOnline: !!user?.is_online,
    activeOrderCount: activeOrders.length,
    deliveredCount: deliveredOrders.length,
    activeOrders,
    deliveryHistory: deliveredOrders.slice(0, 25),
    deliveryFee: settings.delivery_fee || 0,
    estimatedEarnings,
    settledEarnings,
    settlements,
  });
});

router.patch("/rider/:id/online-status", (req, res) => {
  const { isOnline } = req.body;
  db.prepare("UPDATE users SET is_online = ? WHERE id = ? AND role = 'LOGISTICS'").run(isOnline ? 1 : 0, req.params.id);
  res.json(db.prepare("SELECT id, name, is_online FROM users WHERE id = ?").get(req.params.id));
});

module.exports = router;
