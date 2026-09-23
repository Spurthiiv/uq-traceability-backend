const db = require("./db/init");
const { v4: uuidv4 } = require("uuid");
const { addLedgerEntry, getLedgerForBatch, verifyChain } = require("./models/ledger");

// First, create a real batch so the foreign key constraint is satisfied
const batchId = "test-batch-1";

db.prepare(`
  INSERT OR IGNORE INTO batches (id, product_name, farmer_name, origin_location, harvest_date, quantity, unit)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(batchId, "Tomatoes", "Ramesh", "Kolar farm", "2026-09-19", 50, "kg");

// Now add ledger events for that batch
addLedgerEntry(batchId, "harvested", { location: "Kolar farm" });
addLedgerEntry(batchId, "packed", { packer: "Hub A" });

console.log(getLedgerForBatch(batchId));
console.log(verifyChain(batchId));