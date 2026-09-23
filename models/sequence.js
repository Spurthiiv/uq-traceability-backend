const db = require("../db/init");

// A monotonically increasing counter that never goes backward, even if the
// records it numbers get deleted later. Used for human-readable identifiers
// (batch codes, order refs) that must never be reused once issued — a public
// code that gets reassigned to a different item after the original is deleted
// would silently point old QR codes/links at the wrong product.
function nextSequence(name) {
  db.prepare("INSERT OR IGNORE INTO sequences (name, value) VALUES (?, 0)").run(name);
  db.prepare("UPDATE sequences SET value = value + 1 WHERE name = ?").run(name);
  return db.prepare("SELECT value FROM sequences WHERE name = ?").get(name).value;
}

module.exports = { nextSequence };
