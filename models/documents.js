const path = require("path");
const fs = require("fs");
const db = require("../db/init");

// UPLOAD_DIR lets a host with a persistent disk (e.g. Render) point this at a
// mounted volume, for the same reason as DB_PATH in db/init.js.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Removes every document (DB row + file on disk) attached to an entity —
// called when the entity itself is deleted, so uploads don't pile up orphaned.
function deleteDocumentsForEntity(entityType, entityId) {
  const docs = db.prepare("SELECT * FROM documents WHERE entity_type = ? AND entity_id = ?").all(entityType, entityId);
  for (const doc of docs) {
    fs.unlink(path.join(UPLOAD_DIR, doc.stored_name), () => {});
  }
  db.prepare("DELETE FROM documents WHERE entity_type = ? AND entity_id = ?").run(entityType, entityId);
}

module.exports = { UPLOAD_DIR, deleteDocumentsForEntity };
