const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");

const DETAIL_FIELDS = [
  "protein_per_100g", "carbs_per_100g", "total_sugar_per_100g", "added_sugar_per_100g",
  "total_fat_per_100g", "saturated_fat_per_100g", "trans_fat_per_100g",
  "cholesterol_per_100g", "sodium_per_100g", "energy_per_100g",
  "key_features", "fssai_license", "shelf_life", "disclaimer",
  "customer_care_email", "country_of_origin", "manufacturer_address",
  "return_policy", "sugar_profile", "seller_name", "seller_address", "seller_fssai"
];

function createProduct(data) {
  const id = uuidv4();
  const columns = ["id", "name", "unit", "category", "description", "price", ...DETAIL_FIELDS];
  const values = [id, data.name, data.unit, data.category, data.description, data.price || null, ...DETAIL_FIELDS.map(f => data[f])];

  db.prepare(`
    INSERT INTO products (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...values);

  return getProductById(id);
}

function getProductById(id) {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id);
}

function updateProduct(id, data) {
  const columns = ["name", "unit", "category", "description", "price", ...DETAIL_FIELDS];
  const setClause = columns.map((c) => `${c} = ?`).join(", ");
  const values = columns.map((c) => data[c]);

  db.prepare(`UPDATE products SET ${setClause} WHERE id = ?`).run(...values, id);
  return getProductById(id);
}

// TRIM both sides so stray whitespace (e.g. from a batch's free-text product
// name) doesn't silently break the Batch <-> Product match.
function getProductByName(name) {
  return db.prepare("SELECT * FROM products WHERE TRIM(name) = TRIM(?)").get(name);
}

function getProductWithBatchCount(id) {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM batches b WHERE b.product_name = p.name) as batch_count
    FROM products p
    WHERE p.id = ?
  `).get(id);
}

function getAllProducts() {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM batches b WHERE b.product_name = p.name) as batch_count
    FROM products p
    ORDER BY p.created_at DESC
  `).all();
}

function deleteProduct(id) {
  db.prepare("DELETE FROM products WHERE id = ?").run(id);
}

module.exports = { createProduct, updateProduct, getProductById, getProductByName, getProductWithBatchCount, getAllProducts, deleteProduct, DETAIL_FIELDS };
