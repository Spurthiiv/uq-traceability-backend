const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");

const METHOD_ACTION = { POST: "CREATE", PATCH: "UPDATE", PUT: "UPDATE", DELETE: "DELETE" };

// A generic audit trail (BRD ADM-08) driven by the actual request/response
// cycle rather than manually instrumented per route — every successful
// mutating call across every admin-authenticated route gets one real row,
// with who did it, what entity, and the payload that caused it.
function auditLogger(req, res, next) {
  if (!METHOD_ACTION[req.method]) return next();

  res.on("finish", () => {
    if (res.statusCode >= 400) return;

    // Prefer the route-relative path segment (e.g. "zones" for POST /master-data/zones)
    // over the mount point, so sub-resources show up distinctly in the log.
    const entity = req.path.split("/").filter(Boolean)[0] || req.baseUrl.split("/").filter(Boolean)[0] || "unknown";
    const entityId = req.params?.id || null;
    const user = req.user || {};

    try {
      db.prepare(`
        INSERT INTO audit_log (id, user_id, user_name, method, action, entity, entity_id, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), user.id || null, user.name || user.email || "unknown",
        req.method, METHOD_ACTION[req.method], entity, entityId,
        JSON.stringify(req.body || {}).slice(0, 1000)
      );
    } catch (err) {
      console.error("Audit log write failed:", err.message);
    }
  });

  next();
}

module.exports = { auditLogger };
