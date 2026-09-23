const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { verifyToken, requireRole } = require("../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET || "uq-dev-secret-change-in-production";
const DEFAULT_TEMP_PASSWORD = "Welcome@123";

const USER_SELECT = "id, name, email, organization, role, status, phone, created_at";

// List all users (for the Users & Roles page) — ADMIN only
router.get("/users", verifyToken, requireRole("ADMIN"), (req, res) => {
  const users = db.prepare(`SELECT ${USER_SELECT} FROM users ORDER BY name`).all();
  res.json(users);
});

// Lightweight rider list (name only) for order/settlement dropdowns — ADMIN
// and OPS both work Finance & Settlements, but only real LOGISTICS users
// should ever appear as an assignable rider.
router.get("/riders", verifyToken, requireRole("ADMIN", "OPS"), (req, res) => {
  const riders = db.prepare(`SELECT id, name FROM users WHERE role = 'LOGISTICS' AND status = 'active' ORDER BY name`).all();
  res.json(riders);
});

// Get one user's detail — ADMIN only
router.get("/users/:id", verifyToken, requireRole("ADMIN"), (req, res) => {
  const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

// Create a user — ADMIN only. No invite/email system exists yet, so a fixed
// temporary password is assigned and returned once so the admin can share it.
router.post("/users", verifyToken, requireRole("ADMIN"), (req, res) => {
  const { name, email, organization, role, phone, status } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email are required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });

  const ALLOWED_ROLES = ["ADMIN", "OPS", "QUEEN", "RETAILER", "LOGISTICS"];
  if (role && !ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "A user with this email already exists" });

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(DEFAULT_TEMP_PASSWORD, 10);

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, organization, role, phone, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, passwordHash, organization || "FCMCSL", role || "QUEEN", phone || null, status || "active");

  const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(id);
  res.status(201).json({ ...user, temporaryPassword: DEFAULT_TEMP_PASSWORD });
});

// Update a user's profile fields — ADMIN only. Deliberately excludes email
// and password; use Activate/Deactivate (status) instead of deleting users.
router.patch("/users/:id", verifyToken, requireRole("ADMIN"), (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { name, organization, role, phone, status } = req.body;
  const ALLOWED_ROLES = ["ADMIN", "OPS", "QUEEN", "RETAILER", "LOGISTICS"];
  if (role && !ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (status && !["active", "inactive"].includes(status)) return res.status(400).json({ error: "Invalid status" });

  db.prepare(`
    UPDATE users SET
      name = COALESCE(?, name),
      organization = COALESCE(?, organization),
      role = COALESCE(?, role),
      phone = COALESCE(?, phone),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(name, organization, role, phone, status, req.params.id);

  res.json(db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(req.params.id));
});

// Change a user's role — ADMIN only (kept for backward compatibility)
router.patch("/users/:id/role", verifyToken, requireRole("ADMIN"), (req, res) => {
  const { role } = req.body;
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  res.json({ id: req.params.id, role });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });

  if (user.status === "inactive") {
    return res.status(403).json({ error: "This account has been deactivated" });
  }

  const settings = db.prepare("SELECT session_timeout_minutes FROM settings WHERE id = 1").get();
  const timeoutMinutes = settings?.session_timeout_minutes || 10080;

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: `${timeoutMinutes}m` }
  );

  db.prepare("INSERT INTO login_activity (id, user_id, email) VALUES (?, ?, ?)").run(uuidv4(), user.id, user.email);

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, organization: user.organization }
  });
});

// Recent login activity — ADMIN only, for the Settings > Security tab
router.get("/login-activity", verifyToken, requireRole("ADMIN"), (req, res) => {
  const rows = db.prepare(`
    SELECT la.timestamp, la.email, u.name, u.role
    FROM login_activity la LEFT JOIN users u ON u.id = la.user_id
    ORDER BY la.timestamp DESC LIMIT 25
  `).all();
  res.json(rows);
});

module.exports = router;
