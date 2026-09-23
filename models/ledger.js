const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");

function computeHash(batchId, eventType, eventData, prevHash, timestamp) {
  const payload = `${batchId}|${eventType}|${JSON.stringify(eventData)}|${prevHash}|${timestamp}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getLastEntry(batchId) {
  const row = db.prepare(
    "SELECT * FROM ledger WHERE batch_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1"
  ).get(batchId);
  return row || null;
}

function addLedgerEntry(batchId, eventType, eventData) {
  const last = getLastEntry(batchId);
  const prevHash = last ? last.hash : "GENESIS";
  const timestamp = new Date().toISOString();
  const id = uuidv4();

  const hash = computeHash(batchId, eventType, eventData, prevHash, timestamp);

  db.prepare(`
    INSERT INTO ledger (id, batch_id, event_type, event_data, prev_hash, hash, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, batchId, eventType, JSON.stringify(eventData), prevHash, hash, timestamp);

  return { id, batchId, eventType, eventData, prevHash, hash, timestamp };
}
function getAllLedgerEntries() {
  return db.prepare(`
    SELECT ledger.*, batches.product_name
    FROM ledger
    JOIN batches ON batches.id = ledger.batch_id
    ORDER BY ledger.timestamp DESC
  `).all();
}

function getLedgerForBatch(batchId) {
  return db.prepare(
    "SELECT * FROM ledger WHERE batch_id = ? ORDER BY timestamp ASC, rowid ASC"
  ).all(batchId);
}

function verifyChain(batchId) {
  const entries = getLedgerForBatch(batchId);
  let expectedPrevHash = "GENESIS";

  for (const entry of entries) {
    const recomputedHash = computeHash(
      entry.batch_id,
      entry.event_type,
      JSON.parse(entry.event_data),
      entry.prev_hash,
      entry.timestamp
    );

    if (entry.prev_hash !== expectedPrevHash || entry.hash !== recomputedHash) {
      return { valid: false, brokenAt: entry.id };
    }

    expectedPrevHash = entry.hash;
  }

  return { valid: true };
}

module.exports = { addLedgerEntry, getLedgerForBatch, verifyChain, getAllLedgerEntries };