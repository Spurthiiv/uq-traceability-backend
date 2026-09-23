// Seeds the exact demo batch requested for testing the QR traceability flow:
// product "Natural Turmeric Powder", batch UQ-BATCH-2026-001, with all 12
// canonical journey stages logged as real hash-chained ledger events.
const db = require("./init");
const { createProduct, getProductByName } = require("../models/product");
const { createBatch, getBatchByIdentifier, updateBatchStatus } = require("../models/batch");
const { addLedgerEntry } = require("../models/ledger");
const { STAGES } = require("../models/stages");

const PRODUCT_NAME = "Natural Turmeric Powder";
const BATCH_CODE = "UQ-BATCH-2026-001";

if (!getProductByName(PRODUCT_NAME)) {
  createProduct({
    name: PRODUCT_NAME,
    unit: "kg",
    category: "Spices",
    description: "Stone-ground turmeric powder made from hand-selected turmeric roots, sun-dried and milled the traditional way.",
    key_features: "100% natural, no additives\nStone-ground for maximum aroma\nHigh curcumin content\nSourced directly from farmers in Chikkaballapur",
    protein_per_100g: "8 g",
    carbs_per_100g: "65 g",
    total_fat_per_100g: "10 g",
    energy_per_100g: "390 kcal",
    fssai_license: "10019022001987",
    shelf_life: "18 months",
    country_of_origin: "India",
    customer_care_email: "care@udyamiqueens.com",
    manufacturer_address: "Udyami Queens Collective, Chikkaballapur, Karnataka",
  });
  console.log(`Created product: ${PRODUCT_NAME}`);
} else {
  console.log(`Product already exists: ${PRODUCT_NAME}`);
}

let batch = getBatchByIdentifier(BATCH_CODE);
if (!batch) {
  batch = createBatch({
    productName: PRODUCT_NAME,
    farmerName: "Chikkaballapur Turmeric Growers",
    originLocation: "Chikkaballapur, Karnataka",
    harvestDate: "2026-09-15",
    quantity: 500,
    initialQuantity: 520,
    unit: "kg",
    ingredients: "Turmeric",
  });
  // Force the friendly batch code to match the exact one requested (createBatch
  // auto-generates one; overwrite it here so this seed is reproducible).
  db.prepare("UPDATE batches SET batch_code = ? WHERE id = ?").run(BATCH_CODE, batch.id);
  // Remove the generic "created" event createBatch's caller normally logs via
  // the API route — this script logs the full 12-stage journey itself below.
  db.prepare("DELETE FROM ledger WHERE batch_id = ?").run(batch.id);

  // Note: each entry's hash is computed from its own timestamp at insert time
  // (see models/ledger.js), so timestamps are left as real insert-time values
  // rather than backdated — backdating them afterwards would invalidate the
  // hash chain and make "Verify Chain" incorrectly report it as broken.
  STAGES.forEach((stage, i) => {
    const eventData = {
      location: stage.key === "INGREDIENT_REGISTERED" ? "Chikkaballapur, Karnataka"
        : stage.key === "TRANSFERRED_TO_SELLER" ? "Queen Seller Network"
        : stage.key === "RECEIVED_AT_HUB" ? "UQ Queen Hub, Mysuru"
        : stage.key === "WAREHOUSED" ? "UQ Central Warehouse"
        : stage.key === "DISPATCHED" ? "In Transit"
        : stage.key === "DELIVERED" ? "Customer Address"
        : "UQ Processing Center, Chikkaballapur",
      actor: stage.defaultActor,
      quantity: i === 0 ? 520 : 500,
      description: stage.defaultDescription,
    };
    addLedgerEntry(batch.id, stage.key, eventData);
  });

  updateBatchStatus(batch.id, STAGES[STAGES.length - 1].key);
  console.log(`Created batch ${BATCH_CODE} with ${STAGES.length} journey events`);
} else {
  console.log(`Batch already exists: ${BATCH_CODE}`);
}
