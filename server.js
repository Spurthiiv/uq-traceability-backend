require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./db/init");

const batchRoutes = require("./routes/batches");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const { getBatchByIdentifier } = require("./models/batch");
const { getLedgerForBatch, verifyChain, getAllLedgerEntries } = require("./models/ledger");
const { getProductByName } = require("./models/product");
const { stageInfo } = require("./models/stages");
const qualityRoutes = require("./routes/quality");
const financeRoutes = require("./routes/finance");
const settingsRoutes = require("./routes/settings");
const productRoutes = require("./routes/products");
const reportsRoutes = require("./routes/reports");
const ordersRoutes = require("./routes/orders");
const masterDataRoutes = require("./routes/masterData");
const couponsRoutes = require("./routes/coupons");
const complianceRoutes = require("./routes/compliance");
const refundsRoutes = require("./routes/refunds");
const invoicesRoutes = require("./routes/invoices");
const documentsRoutes = require("./routes/documents");
const pricingRulesRoutes = require("./routes/pricingRules");
const { verifyToken, requireRole } = require("./middleware/auth");
const { auditLogger } = require("./middleware/audit");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes); // stays open, no token needed for login
app.use("/batches", verifyToken, auditLogger, batchRoutes);
app.use("/products", verifyToken, auditLogger, productRoutes);
app.use("/dashboard", verifyToken, dashboardRoutes);
app.use("/finance", verifyToken, requireRole("ADMIN", "OPS"), auditLogger, financeRoutes);
app.use("/quality", verifyToken, requireRole("ADMIN", "OPS"), auditLogger, qualityRoutes);
app.use("/settings", verifyToken, requireRole("ADMIN"), auditLogger, settingsRoutes);
app.use("/reports", verifyToken, requireRole("ADMIN"), reportsRoutes);
app.use("/orders", verifyToken, requireRole("ADMIN", "OPS"), auditLogger, ordersRoutes);
app.use("/master-data", verifyToken, requireRole("ADMIN", "OPS", "QUEEN"), auditLogger, masterDataRoutes);
app.use("/coupons", verifyToken, requireRole("ADMIN", "OPS"), auditLogger, couponsRoutes);
app.use("/compliance", verifyToken, requireRole("ADMIN"), auditLogger, complianceRoutes);
app.use("/refunds", verifyToken, requireRole("ADMIN", "OPS"), auditLogger, refundsRoutes);
app.use("/invoices", verifyToken, requireRole("ADMIN", "OPS"), auditLogger, invoicesRoutes);
// Segregated document vault (FSSAI certificates, lab report images) — files
// are named with a random UUID on disk, and both the listing/upload API and
// the raw file itself require a valid session token, not just the file path.
app.use("/documents", verifyToken, auditLogger, documentsRoutes);
app.use("/uploads", verifyToken, express.static(documentsRoutes.UPLOAD_DIR));
app.use("/pricing-rules", verifyToken, requireRole("ADMIN", "OPS"), auditLogger, pricingRulesRoutes);

app.get("/", (req, res) => {
  res.json({ status: "Udyami Queens Traceability API running" });
});

// Public, unauthenticated trace lookup — accepts either the internal UUID or the
// human-readable batch code (e.g. UQ-BATCH-2026-001) printed under the QR code.
// Only customer-safe fields are returned: no user records, no financial data.
app.get("/trace/:id", (req, res) => {
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  if (!settings.public_traceability_enabled) {
    return res.status(404).json({ error: "Public traceability is currently disabled" });
  }

  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) {
    return res.status(404).json({ error: "Batch not found", batchId: req.params.id });
  }

  const entries = getLedgerForBatch(batch.id);
  const verification = verifyChain(batch.id);
  const showJourney = !!settings.show_processing_journey && !!settings.show_delivery_journey;
  const hubEventTypes = new Set(["RECEIVED_AT_HUB", "WAREHOUSED"]);
  const visibleEntries = settings.show_hub_info ? entries : entries.filter(e => !hubEventTypes.has(e.event_type));
  const journey = showJourney ? visibleEntries.map(e => {
    const detail = JSON.parse(e.event_data || "{}");
    const info = stageInfo(e.event_type);
    return {
      type: e.event_type,
      label: info.label,
      icon: info.icon,
      at: e.timestamp,
      location: detail.location || null,
      actor: detail.actor || null,
      description: detail.description || null,
      hash: settings.show_blockchain_verification ? e.hash : null,
      prevHash: settings.show_blockchain_verification ? e.prev_hash : null
    };
  }) : [];
  const rawProduct = getProductByName(batch.product_name) || null;
  let product = rawProduct;
  if (product && !settings.show_quality_info) {
    product = { ...product, fssai_license: null, shelf_life: null }; // quality/compliance fields hidden per setting
  }
  if (product && !settings.show_seller_info) {
    product = { ...product, seller_name: null, seller_address: null, seller_fssai: null };
  }

  // QC result → Batch → QR → Customer Traceability: surface the batch's most
  // recent real quality check, if any, so a scanning customer can see it.
  const latestQc = settings.show_quality_info
    ? db.prepare("SELECT qc_type, result, checked_by, created_at FROM qc_checks WHERE batch_id = ? ORDER BY created_at DESC LIMIT 1").get(batch.id)
    : null;

  res.json({
    id: batch.id,
    batch_code: batch.batch_code,
    product_name: batch.product_name,
    quantity: batch.quantity,
    initial_quantity: batch.initial_quantity,
    unit: batch.unit,
    farmer_name: settings.show_seller_info ? batch.farmer_name : null,
    origin_location: settings.show_origin ? batch.origin_location : null,
    ingredients: batch.ingredients,
    harvest_date: batch.harvest_date,
    verified: settings.show_blockchain_verification ? verification.valid : null,
    eventsVerified: settings.show_blockchain_verification ? entries.length : null,
    eventsTotal: settings.show_blockchain_verification ? entries.length : null,
    journey,
    product,
    qualityCheck: latestQc ? {
      passed: latestQc.result === "passed",
      type: latestQc.qc_type,
      checkedBy: latestQc.checked_by,
      at: latestQc.created_at,
    } : null
  });
});

app.get("/ledger", verifyToken, (req, res) => {
  res.json(getAllLedgerEntries());
});

app.get("/ledger/verify-all", verifyToken, (req, res) => {
  const batchIds = db.prepare("SELECT DISTINCT id FROM batches").all().map(b => b.id);
  const results = batchIds.map(id => ({ batchId: id, ...verifyChain(id) }));
  const allValid = results.every(r => r.valid);
  res.json({ allValid, results });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});