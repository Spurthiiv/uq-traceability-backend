const express = require("express");
const router = express.Router();
const db = require("../db/init");
const {
  getBrandApprovals, getTopBrand, getTopSellingItems,
  getTopRatedItems, getTopSellers, getTopHashtags, getMembershipOverview
} = require("../models/marketplace");

router.get("/summary", (req, res) => {
  const batches = db.prepare("SELECT status FROM batches").all();
  const totalBatches = batches.length;
  const created = batches.filter(b => b.status === 'created').length;
  const packed = batches.filter(b => b.status === 'packed').length;
  const delivered = batches.filter(b => b.status === 'delivered').length;

  const roleCounts = db.prepare("SELECT role, COUNT(*) as count FROM users GROUP BY role").all();
  const countFor = (role) => (roleCounts.find(r => r.role === role) || {}).count || 0;

  const products = db.prepare("SELECT COUNT(DISTINCT product_name) as count FROM batches").get();

  res.json({
    totalBatches, created, packed, delivered,
    queens: countFor('QUEEN'),
    retailers: countFor('RETAILER'),
    riders: countFor('LOGISTICS'),
    products: products.count
  });
});

router.get("/marketplace-overview", (req, res) => {
  res.json({
    brandApprovals: getBrandApprovals(),
    topBrand: getTopBrand(),
    topSellingItems: getTopSellingItems(),
    topRatedItems: getTopRatedItems(),
    topSellers: getTopSellers(),
    topHashtags: getTopHashtags(),
    membershipOverview: getMembershipOverview(),
  });
});

module.exports = router;