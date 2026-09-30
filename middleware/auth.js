// Authentication removed at the user's explicit request — every request is
// treated as this fixed ADMIN identity, no credentials checked at all.
// Anyone who can reach this API has full access.
function verifyToken(req, res, next) {
  req.user = { id: "no-auth-admin", email: "admin@local", role: "ADMIN", name: "Admin" };
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

module.exports = { verifyToken, requireRole };