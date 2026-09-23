// Canonical supply-chain journey stages, in order.
// Each batch's ledger events use these event_type values as it moves through
// the chain. This list is the single source of truth for the stage order,
// display labels, and default actor/location text used when logging events.
const STAGES = [
  { key: "INGREDIENT_REGISTERED", label: "Farm", icon: "🌱", defaultActor: "Farm Supplier", defaultDescription: "Ingredient registered for production" },
  { key: "RECEIVED", label: "Received", icon: "🏭", defaultActor: "UQ Processing Center", defaultDescription: "Received & processed" },
  { key: "BATCH_STARTED", label: "Batch Started", icon: "🧾", defaultActor: "UQ Processing Center", defaultDescription: "Production batch started" },
  { key: "TRANSFORMED", label: "Transformed", icon: "⚙️", defaultActor: "UQ Processing Center", defaultDescription: "Raw material transformed into product" },
  { key: "QUALITY_CHECKED", label: "Quality Check", icon: "✔️", defaultActor: "QC Team", defaultDescription: "Quality verified" },
  { key: "PACKAGED", label: "Packaging", icon: "📦", defaultActor: "UQ Packaging Unit", defaultDescription: "Batch packaged" },
  { key: "QR_BOUND", label: "QR Bound", icon: "🔗", defaultActor: "UQ Packaging Unit", defaultDescription: "QR code bound to batch" },
  { key: "TRANSFERRED_TO_SELLER", label: "Queen Seller", icon: "👩", defaultActor: "Queen Seller", defaultDescription: "Received by Queen Seller" },
  { key: "RECEIVED_AT_HUB", label: "Queen Hub", icon: "🏪", defaultActor: "UQ Queen Hub", defaultDescription: "Received at Queen Hub" },
  { key: "WAREHOUSED", label: "Warehouse", icon: "🏬", defaultActor: "Warehouse", defaultDescription: "Stored in warehouse" },
  { key: "DISPATCHED", label: "Rider", icon: "🚚", defaultActor: "Rider", defaultDescription: "Order dispatched" },
  { key: "DELIVERED", label: "Customer", icon: "👤", defaultActor: "Customer", defaultDescription: "Product delivered" },
];

const STAGE_INDEX = new Map(STAGES.map((s, i) => [s.key, i]));

function stageInfo(eventType) {
  return STAGES.find(s => s.key === eventType) || { key: eventType, label: eventType, icon: "•" };
}

function nextStage(currentEventType) {
  const idx = currentEventType ? STAGE_INDEX.get(currentEventType) : -1;
  if (idx === undefined) return STAGES[0];
  return STAGES[idx + 1] || null;
}

module.exports = { STAGES, stageInfo, nextStage };
