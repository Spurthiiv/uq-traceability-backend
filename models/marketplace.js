const db = require("../db/init");

function getBrandApprovals() {
  return db.prepare(`
    SELECT id, name, logo, status, created_at FROM brands
    ORDER BY created_at DESC LIMIT 5
  `).all();
}

function getTopBrand() {
  return db.prepare(`
    SELECT id, name, logo, sales_count FROM brands
    WHERE status = 'approved'
    ORDER BY sales_count DESC LIMIT 5
  `).all();
}

function getTopSellingItems() {
  return db.prepare(`
    SELECT product_name, SUM(quantity) as total_sold
    FROM batches
    WHERE status = 'delivered'
    GROUP BY product_name
    ORDER BY total_sold DESC LIMIT 5
  `).all();
}

function getTopRatedItems() {
  return db.prepare(`
    SELECT product_name, ROUND(AVG(rating), 1) as avg_rating, COUNT(*) as review_count
    FROM ratings
    GROUP BY product_name
    ORDER BY avg_rating DESC, review_count DESC LIMIT 5
  `).all();
}

function getTopSellers() {
  return db.prepare(`
    SELECT farmer_name, COUNT(*) as batch_count, SUM(quantity) as total_quantity
    FROM batches
    WHERE farmer_name IS NOT NULL AND farmer_name != ''
    GROUP BY farmer_name
    ORDER BY total_quantity DESC LIMIT 5
  `).all();
}

function getTopHashtags() {
  return db.prepare(`
    SELECT tag, usage_count FROM hashtags
    ORDER BY usage_count DESC LIMIT 5
  `).all();
}

function getMembershipOverview() {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthStartIso = startOfMonth.toISOString();

  const in30Days = new Date(Date.now() + 30 * 86400000).toISOString();

  const activeMembers = db.prepare(`
    SELECT COUNT(*) as count FROM memberships WHERE status = 'active'
  `).get().count;

  const newMemberships = db.prepare(`
    SELECT COUNT(*) as count FROM memberships
    WHERE is_renewal = 0 AND created_at >= ?
  `).get(monthStartIso).count;

  const renewals = db.prepare(`
    SELECT COUNT(*) as count FROM memberships
    WHERE is_renewal = 1 AND created_at >= ?
  `).get(monthStartIso).count;

  const expiringSoon = db.prepare(`
    SELECT COUNT(*) as count FROM memberships
    WHERE status = 'active' AND end_date <= ? AND end_date >= ?
  `).get(in30Days, new Date().toISOString()).count;

  const membershipRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM memberships
    WHERE created_at >= ?
  `).get(monthStartIso).total;

  return { activeMembers, newMemberships, renewals, expiringSoon, membershipRevenue };
}

module.exports = {
  getBrandApprovals,
  getTopBrand,
  getTopSellingItems,
  getTopRatedItems,
  getTopSellers,
  getTopHashtags,
  getMembershipOverview,
};
