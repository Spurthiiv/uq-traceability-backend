const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { nextSequence } = require("./sequence");

function generateBatchCode() {
  const year = new Date().getFullYear();
  const seq = nextSequence(`batch_code_${year}`);
  return `UQ-BATCH-${year}-${String(seq).padStart(3, "0")}`;
}

function createBatch({ productName, farmerName, originLocation, harvestDate, quantity, unit, ingredients, initialQuantity }) {
  const id = uuidv4();
  const batchCode = generateBatchCode();
  const trimmedProductName = productName ? productName.trim() : productName;

  db.prepare(`
    INSERT INTO batches (id, batch_code, product_name, farmer_name, origin_location, harvest_date, quantity, initial_quantity, unit, ingredients)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, batchCode, trimmedProductName, farmerName ? farmerName.trim() : farmerName, originLocation, harvestDate, quantity, initialQuantity || null, unit, ingredients);

  return getBatchById(id);
}

function getBatchById(id) {
  return db.prepare("SELECT * FROM batches WHERE id = ?").get(id);
}

// Accepts either the internal UUID or the human-readable batch_code
// (e.g. "UQ-BATCH-2026-001") — both work as a public/consumer-facing identifier.
function getBatchByIdentifier(identifier) {
  return db.prepare("SELECT * FROM batches WHERE id = ? OR batch_code = ?").get(identifier, identifier);
}

function getAllBatches() {
  return db.prepare("SELECT * FROM batches ORDER BY created_at DESC").all();
}

function updateBatchStatus(id, status) {
  db.prepare("UPDATE batches SET status = ? WHERE id = ?").run(status, id);
  return getBatchById(id);
}

function deleteBatch(id) {
  db.prepare("DELETE FROM ledger WHERE batch_id = ?").run(id);
  db.prepare("DELETE FROM qc_checks WHERE batch_id = ?").run(id);
  db.prepare("DELETE FROM complaints WHERE batch_id = ?").run(id);
  db.prepare("DELETE FROM batches WHERE id = ?").run(id);
}

module.exports = { createBatch, getBatchById, getBatchByIdentifier, getAllBatches, updateBatchStatus, deleteBatch };
