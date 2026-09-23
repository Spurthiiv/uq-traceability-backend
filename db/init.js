const Database = require("better-sqlite3");
const path = require("path");

// DB_PATH lets a host with a persistent disk (e.g. Render) point this at a
// mounted volume — otherwise every redeploy would start from an empty
// database, since the app directory itself isn't durable storage there.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "traceability.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    farmer_name TEXT,
    origin_location TEXT,
    harvest_date TEXT,
    quantity REAL,
    unit TEXT,
    status TEXT DEFAULT 'created',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT,
    prev_hash TEXT,
    hash TEXT NOT NULL,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES batches(id)
  );

  CREATE TABLE IF NOT EXISTS qc_checks (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    checked_by TEXT,
    result TEXT DEFAULT 'passed',
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES batches(id)
  );

  CREATE TABLE IF NOT EXISTS complaints (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    complainant_name TEXT,
    description TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    organization TEXT DEFAULT 'FCMCSL',
    role TEXT DEFAULT 'QUEEN',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    cp_id TEXT NOT NULL,
    hub_name TEXT,
    order_ref TEXT,
    amount REAL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    organization_name TEXT DEFAULT 'FCMCSL',
    app_name TEXT DEFAULT 'Udyami Queens',
    tagline TEXT DEFAULT 'Blockchain Powered Supply Chain',
    notifications_enabled INTEGER DEFAULT 1
  );

  INSERT OR IGNORE INTO settings (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS brands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    queen_id TEXT,
    logo TEXT DEFAULT '🏷️',
    status TEXT DEFAULT 'pending',
    sales_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (queen_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS hashtags (
    id TEXT PRIMARY KEY,
    tag TEXT UNIQUE NOT NULL,
    usage_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    unit TEXT,
    category TEXT,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    queen_id TEXT,
    plan_name TEXT DEFAULT 'Standard',
    status TEXT DEFAULT 'active',
    amount REAL DEFAULT 0,
    is_renewal INTEGER DEFAULT 0,
    start_date TEXT DEFAULT CURRENT_TIMESTAMP,
    end_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (queen_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_ref TEXT UNIQUE,
    customer_id TEXT,
    customer_name TEXT,
    product_name TEXT,
    batch_id TEXT,
    seller_name TEXT,
    quantity REAL,
    amount REAL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (batch_id) REFERENCES batches(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    amount REAL,
    payment_method TEXT DEFAULT 'UPI',
    status TEXT DEFAULT 'success',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  -- Real invoices per order — a genuine invoice number, computed from the
  -- order's actual (already-discounted) amount plus the real GST rate
  -- configured in Settings, not a static mock document.
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT UNIQUE,
    order_id TEXT NOT NULL,
    subtotal REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0,
    gst_percent REAL DEFAULT 0,
    gst_amount REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS login_activity (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sequences (
    name TEXT PRIMARY KEY,
    value INTEGER DEFAULT 0
  );

  -- Admin Console master data (BRD Section 7.6, ADM-01 / ADM-03): zones/hubs
  -- as a real geofenced hierarchy, categories as a managed catalog list,
  -- coupons for real promotions.
  CREATE TABLE IF NOT EXISTS zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone_level TEXT DEFAULT 'ward',
    parent_zone_id TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_zone_id) REFERENCES zones(id)
  );

  CREATE TABLE IF NOT EXISTS hubs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone_id TEXT,
    address TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (zone_id) REFERENCES zones(id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS coupons (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT DEFAULT 'percent',
    discount_value REAL DEFAULT 0,
    valid_from TEXT,
    valid_to TEXT,
    usage_limit INTEGER,
    times_used INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- ADM-05: commission/payout rules engine. A rule overrides the settings-wide
  -- default commission % for one specific hub or one specific Queen seller —
  -- looked up when a settlement is created for that hub/seller. Matched by
  -- name (like CP/Hub settlements already are) rather than a hub_id FK, since
  -- a settlement's hub/CP fields are themselves free text, not a real link.
  CREATE TABLE IF NOT EXISTS commission_rules (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    hub_name TEXT,
    seller_name TEXT,
    commission_percent REAL NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- ADM-05: bulk/tiered pricing — an automatic discount applied at order
  -- creation once the ordered quantity meets a threshold, for one product or
  -- an entire category. Distinct from a coupon: no code, always-on, stacks
  -- with a coupon if both apply.
  CREATE TABLE IF NOT EXISTS bulk_pricing_rules (
    id TEXT PRIMARY KEY,
    product_name TEXT,
    category TEXT,
    min_quantity REAL NOT NULL,
    discount_percent REAL NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- ADM-08: a real, comprehensive audit trail across every admin mutation,
  -- plus DPDP data-subject request tracking and a consent registry.
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    user_name TEXT,
    method TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS data_requests (
    id TEXT PRIMARY KEY,
    requester_name TEXT NOT NULL,
    requester_contact TEXT,
    request_type TEXT DEFAULT 'access',
    status TEXT DEFAULT 'open',
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS consent_records (
    id TEXT PRIMARY KEY,
    subject_name TEXT NOT NULL,
    subject_contact TEXT,
    consent_type TEXT NOT NULL,
    granted INTEGER DEFAULT 1,
    recorded_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Refunds as a real two-level approval workflow (BRD Section 19.2): OPS
  -- (Local Admin) initiates, ADMIN (District Head) approves with recorded
  -- seller consent before it can be disbursed.
  CREATE TABLE IF NOT EXISTS refund_requests (
    id TEXT PRIMARY KEY,
    refund_code TEXT,
    order_id TEXT,
    complaint_id TEXT,
    customer_name TEXT,
    reason TEXT,
    refund_type TEXT DEFAULT 'refund',
    requested_amount REAL DEFAULT 0,
    status TEXT DEFAULT 'initiated',
    initiated_by TEXT,
    seller_consent INTEGER DEFAULT 0,
    approved_by TEXT,
    approval_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (complaint_id) REFERENCES complaints(id)
  );

  -- Generic document vault (BRD: "segregated document vault" for KYC/compliance
  -- documents) — attaches an uploaded file (FSSAI certificate, lab report
  -- image, etc.) to any entity via entity_type + entity_id, rather than a
  -- one-off column per document kind.
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER DEFAULT 0,
    uploaded_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Coupon support on orders — a real discount that was actually applied,
// not just a promised feature with no effect on totals.
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
const ORDER_COLUMNS = {
  coupon_code: "TEXT", discount_amount: "REAL DEFAULT 0", rider_name: "TEXT", bulk_discount_amount: "REAL DEFAULT 0",
  delivery_latitude: "REAL", delivery_longitude: "REAL", hub_name: "TEXT",
};
for (const [col, def] of Object.entries(ORDER_COLUMNS)) {
  if (!orderColumns.includes(col)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${def}`);
  }
}

// Geofencing coordinates (BRD ADM-03) — a hub is a point on the map; a zone
// is represented as a circular geofence (center + radius) rather than a full
// boundary polygon, which is a reasonable approximation without a
// polygon-drawing tool and is enough to render both on a real map.
const zoneColumns = db.prepare("PRAGMA table_info(zones)").all().map(c => c.name);
const ZONE_COLUMNS = { latitude: "REAL", longitude: "REAL", radius_km: "REAL DEFAULT 2" };
for (const [col, def] of Object.entries(ZONE_COLUMNS)) {
  if (!zoneColumns.includes(col)) {
    db.exec(`ALTER TABLE zones ADD COLUMN ${col} ${def}`);
  }
}

const hubColumns = db.prepare("PRAGMA table_info(hubs)").all().map(c => c.name);
const HUB_COLUMNS = { latitude: "REAL", longitude: "REAL" };
for (const [col, def] of Object.entries(HUB_COLUMNS)) {
  if (!hubColumns.includes(col)) {
    db.exec(`ALTER TABLE hubs ADD COLUMN ${col} ${def}`);
  }
}

const batchColumns = db.prepare("PRAGMA table_info(batches)").all().map(c => c.name);
if (!batchColumns.includes("ingredients")) {
  db.exec("ALTER TABLE batches ADD COLUMN ingredients TEXT");
}
if (!batchColumns.includes("batch_code")) {
  db.exec("ALTER TABLE batches ADD COLUMN batch_code TEXT");
}
if (!batchColumns.includes("initial_quantity")) {
  db.exec("ALTER TABLE batches ADD COLUMN initial_quantity REAL");
}

// Backfill batch_code for any pre-existing batches created before this column existed
const uncoded = db.prepare("SELECT id, created_at FROM batches WHERE batch_code IS NULL ORDER BY created_at ASC").all();
if (uncoded.length > 0) {
  const countThisYear = (year) => db.prepare(
    "SELECT COUNT(*) c FROM batches WHERE batch_code LIKE ?"
  ).get(`UQ-BATCH-${year}-%`).c;
  const setCode = db.prepare("UPDATE batches SET batch_code = ? WHERE id = ?");
  for (const b of uncoded) {
    const year = new Date(b.created_at).getFullYear();
    const seq = countThisYear(year) + 1;
    setCode.run(`UQ-BATCH-${year}-${String(seq).padStart(3, "0")}`, b.id);
  }
}

const PRODUCT_DETAIL_COLUMNS = [
  "protein_per_100g", "carbs_per_100g", "total_sugar_per_100g", "added_sugar_per_100g",
  "total_fat_per_100g", "saturated_fat_per_100g", "trans_fat_per_100g",
  "cholesterol_per_100g", "sodium_per_100g", "energy_per_100g",
  "key_features", "fssai_license", "shelf_life", "disclaimer",
  "customer_care_email", "country_of_origin", "manufacturer_address",
  "return_policy", "sugar_profile", "seller_name", "seller_address", "seller_fssai"
];
const productColumns = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
for (const col of PRODUCT_DETAIL_COLUMNS) {
  if (!productColumns.includes(col)) {
    db.exec(`ALTER TABLE products ADD COLUMN ${col} TEXT`);
  }
}
// Price per unit — the base figure Orders needs to compute a real total
// instead of requiring the amount to be typed in from memory every time.
if (!productColumns.includes("price")) {
  db.exec("ALTER TABLE products ADD COLUMN price REAL");
}

const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userColumns.includes("status")) {
  db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'");
}
if (!userColumns.includes("phone")) {
  db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
}

const SETTINGS_COLUMNS = {
  // General
  default_language: "TEXT DEFAULT 'en'",
  timezone: "TEXT DEFAULT 'Asia/Kolkata'",
  currency: "TEXT DEFAULT 'INR'",
  // Notifications (notifications_enabled already exists as the master switch)
  email_notifications: "INTEGER DEFAULT 1",
  order_notifications: "INTEGER DEFAULT 1",
  quality_alerts: "INTEGER DEFAULT 1",
  finance_alerts: "INTEGER DEFAULT 1",
  complaint_alerts: "INTEGER DEFAULT 1",
  supply_chain_alerts: "INTEGER DEFAULT 1",
  // Supply chain
  default_batch_status: "TEXT DEFAULT 'created'",
  qr_verification_enabled: "INTEGER DEFAULT 1",
  customer_traceability_enabled: "INTEGER DEFAULT 1",
  blockchain_ledger_enabled: "INTEGER DEFAULT 1",
  qc_required_before_packaging: "INTEGER DEFAULT 0",
  qc_required_before_dispatch: "INTEGER DEFAULT 0",
  // Finance
  default_cp_commission_percent: "REAL DEFAULT 10",
  settlement_cycle: "TEXT DEFAULT 'weekly'",
  minimum_settlement_amount: "REAL DEFAULT 0",
  // Taxes & fees (ADM-01/ADM-05 master data)
  gst_percent: "REAL DEFAULT 5",
  platform_fee_percent: "REAL DEFAULT 0",
  delivery_fee: "REAL DEFAULT 0",
  // Traceability / public trace page
  public_traceability_enabled: "INTEGER DEFAULT 1",
  qr_base_url: "TEXT",
  show_origin: "INTEGER DEFAULT 1",
  show_processing_journey: "INTEGER DEFAULT 1",
  show_quality_info: "INTEGER DEFAULT 1",
  show_seller_info: "INTEGER DEFAULT 1",
  show_hub_info: "INTEGER DEFAULT 1",
  show_delivery_journey: "INTEGER DEFAULT 1",
  show_blockchain_verification: "INTEGER DEFAULT 1",
};
const SECURITY_SETTINGS_COLUMNS = {
  session_timeout_minutes: "INTEGER DEFAULT 10080",
  password_min_length: "INTEGER DEFAULT 8",
  password_require_number: "INTEGER DEFAULT 1",
  two_factor_enabled: "INTEGER DEFAULT 0",
};
Object.assign(SETTINGS_COLUMNS, SECURITY_SETTINGS_COLUMNS);

const settingsColumns = db.prepare("PRAGMA table_info(settings)").all().map(c => c.name);
for (const [col, def] of Object.entries(SETTINGS_COLUMNS)) {
  if (!settingsColumns.includes(col)) {
    db.exec(`ALTER TABLE settings ADD COLUMN ${col} ${def}`);
  }
}

const settlementColumns = db.prepare("PRAGMA table_info(settlements)").all().map(c => c.name);
const SETTLEMENT_COLUMNS = {
  period: "TEXT",
  gross_order_value: "REAL DEFAULT 0",
  commission_percent: "REAL",
  orders_count: "INTEGER DEFAULT 0",
  settlement_code: "TEXT",
  settlement_type: "TEXT DEFAULT 'cp_hub'",
  seller_name: "TEXT",
  rider_name: "TEXT",
  refund_adjustment: "REAL DEFAULT 0",
  payment_method: "TEXT",
  transaction_reference: "TEXT",
  settlement_date: "TEXT",
};
for (const [col, def] of Object.entries(SETTLEMENT_COLUMNS)) {
  if (!settlementColumns.includes(col)) {
    db.exec(`ALTER TABLE settlements ADD COLUMN ${col} ${def}`);
  }
}

const qcColumns = db.prepare("PRAGMA table_info(qc_checks)").all().map(c => c.name);
if (!qcColumns.includes("qc_type")) {
  db.exec("ALTER TABLE qc_checks ADD COLUMN qc_type TEXT DEFAULT 'Overall Quality'");
}

const complaintColumns = db.prepare("PRAGMA table_info(complaints)").all().map(c => c.name);
const COMPLAINT_COLUMNS = { category: "TEXT", priority: "TEXT DEFAULT 'Medium'", order_id: "TEXT" };
for (const [col, def] of Object.entries(COMPLAINT_COLUMNS)) {
  if (!complaintColumns.includes(col)) {
    db.exec(`ALTER TABLE complaints ADD COLUMN ${col} ${def}`);
  }
}

// Self-heal the batch code / order ref sequences on every startup: never let
// a sequence sit below the highest number already issued this year, so it
// can never hand out a code that collides with one already in use (this is
// what let a deleted batch's code get silently reused by a new batch before).
function ensureSequenceAtLeast(name, minValue) {
  db.prepare("INSERT OR IGNORE INTO sequences (name, value) VALUES (?, 0)").run(name);
  db.prepare("UPDATE sequences SET value = MAX(value, ?) WHERE name = ?").run(minValue, name);
}
const currentYear = new Date().getFullYear();
const maxBatchSeq = db.prepare("SELECT batch_code FROM batches WHERE batch_code LIKE ?").all(`UQ-BATCH-${currentYear}-%`)
  .reduce((max, b) => Math.max(max, parseInt(b.batch_code.split("-").pop(), 10) || 0), 0);
ensureSequenceAtLeast(`batch_code_${currentYear}`, maxBatchSeq);
const maxOrderSeq = db.prepare("SELECT order_ref FROM orders WHERE order_ref LIKE ?").all(`ORD-${currentYear}-%`)
  .reduce((max, o) => Math.max(max, parseInt(o.order_ref.split("-").pop(), 10) || 0), 0);
ensureSequenceAtLeast(`order_ref_${currentYear}`, maxOrderSeq);
const maxSettlementSeq = db.prepare("SELECT settlement_code FROM settlements WHERE settlement_code LIKE ?").all(`SET-${currentYear}-%`)
  .reduce((max, s) => Math.max(max, parseInt(s.settlement_code.split("-").pop(), 10) || 0), 0);
ensureSequenceAtLeast(`settlement_code_${currentYear}`, maxSettlementSeq);
const maxRefundSeq = db.prepare("SELECT refund_code FROM refund_requests WHERE refund_code LIKE ?").all(`REF-${currentYear}-%`)
  .reduce((max, r) => Math.max(max, parseInt(r.refund_code.split("-").pop(), 10) || 0), 0);
ensureSequenceAtLeast(`refund_code_${currentYear}`, maxRefundSeq);
const maxInvoiceSeq = db.prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?").all(`INV-${currentYear}-%`)
  .reduce((max, i) => Math.max(max, parseInt(i.invoice_number.split("-").pop(), 10) || 0), 0);
ensureSequenceAtLeast(`invoice_number_${currentYear}`, maxInvoiceSeq);

// First-run bootstrap: a fresh database (e.g. a brand new hosted deploy) has
// no way to log in at all otherwise, and hosts without shell access (Render's
// free tier) can't run db/seed-users.js manually to fix that.
const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
if (userCount === 0) {
  const bcrypt = require("bcryptjs");
  const { v4: uuidv4 } = require("uuid");
  const DEFAULT_USERS = [
    { name: "Spoorthi V", email: "spurthi@fcbizz.com", role: "ADMIN" },
    { name: "Divya Rao", email: "divya.ops@fcbizz.com", role: "OPS" },
    { name: "Lakshmi Devi", email: "lakshmi.queen@fcbizz.com", role: "QUEEN" },
    { name: "Fatima Bee", email: "fatima.queen@fcbizz.com", role: "QUEEN" },
    { name: "Priya Sharma", email: "priya.retail@fcbizz.com", role: "RETAILER" },
    { name: "Kavya Nair", email: "kavya.logistics@fcbizz.com", role: "LOGISTICS" },
  ];
  const seedPasswordHash = bcrypt.hashSync("Password123!", 10);
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, password_hash, organization, role)
    VALUES (?, ?, ?, ?, 'FCMCSL', ?)
  `);
  for (const u of DEFAULT_USERS) {
    insertUser.run(uuidv4(), u.name, u.email, seedPasswordHash, u.role);
  }
  console.log(`Seeded ${DEFAULT_USERS.length} default users (password: Password123!) — first run on an empty database.`);
}

module.exports = db;