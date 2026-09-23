const express = require("express");
const router = express.Router();
const db = require("../db/init");
const { generateQRForBatch } = require("../models/qr");
const { generateBarcodeForBatch } = require("../models/barcode");
const { nextStage } = require("../models/stages");

const { createBatch, getBatchByIdentifier, getAllBatches, updateBatchStatus, deleteBatch } = require("../models/batch");
const { addLedgerEntry, getLedgerForBatch, verifyChain } = require("../models/ledger");
const { createProduct, getProductByName } = require("../models/product");

// Create a new batch
// (No ledger event is logged here — the batch's journey starts once the first
// canonical stage is logged via POST /:id/events, so a fresh batch has 0/12
// events rather than an extra "created" block ahead of the real 12-stage journey.)
router.post("/", (req, res) => {
  try {
    const batch = createBatch(req.body);

    // A batch's product name is free text, so if this is the first batch ever
    // made under that name, create a matching (initially empty) catalog entry
    // for it too — otherwise the product silently never appears under
    // Products & Batches > Products until someone remembers to add it there
    // separately, and the public trace page has no nutrition/FSSAI info to show.
    if (batch.product_name && !getProductByName(batch.product_name)) {
      createProduct({ name: batch.product_name, unit: batch.unit });
    }

    res.status(201).json(batch);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get all batches
router.get("/", (req, res) => {
  res.json(getAllBatches());
});

// Get one batch + its full ledger history (accepts UUID or batch_code, e.g. UQ-BATCH-2026-001)
router.get("/:id", (req, res) => {
  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  const ledger = getLedgerForBatch(batch.id);
  const orders = db.prepare(`
    SELECT o.*,
      (SELECT t.status FROM transactions t WHERE t.order_id = o.id ORDER BY t.created_at DESC LIMIT 1) as transaction_status
    FROM orders o WHERE o.batch_id = ? ORDER BY o.created_at DESC
  `).all(batch.id);
  res.json({ ...batch, ledger, orders });
});

// Delete a batch and its ledger/QC/complaint history
router.delete("/:id", (req, res) => {
  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  deleteBatch(batch.id);
  res.status(204).end();
});

// List the ledger events for a batch, plus what the next journey stage would be
router.get("/:id/events", (req, res) => {
  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  const events = getLedgerForBatch(batch.id);
  const last = events[events.length - 1];
  res.json({ events, next: nextStage(last?.event_type) });
});

// Add an event to a batch's ledger (e.g. packed, shipped, delivered, quality_checked,
// or one of the canonical journey stages in models/stages.js)
router.post("/:id/events", (req, res) => {
  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  const { eventType, eventData, newStatus } = req.body;
  if (!eventType) return res.status(400).json({ error: "eventType is required" });

  const entry = addLedgerEntry(batch.id, eventType, eventData || {});
  updateBatchStatus(batch.id, newStatus || eventType);

  res.status(201).json(entry);
});

// Get a QR code (as a base64 image) for a batch's public trace page
router.get("/:id/qr", async (req, res) => {
  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  try {
    const { traceUrl, qrDataUrl } = await generateQRForBatch(req.hostname, batch);
    res.json({ traceUrl, qrDataUrl, batchCode: batch.batch_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Get a Code128 barcode (as a base64 image) for warehouse/inventory scanning —
// separate from the customer-facing QR code above.
router.get("/:id/barcode", async (req, res) => {
  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  try {
    const barcodeDataUrl = await generateBarcodeForBatch(batch);
    res.json({ barcodeDataUrl, batchCode: batch.batch_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify the integrity of a batch's hash chain
router.get("/:id/verify", (req, res) => {
  const batch = getBatchByIdentifier(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  res.json(verifyChain(batch.id));
});

module.exports = router;
