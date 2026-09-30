const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");

// ---- Modules ----
router.get("/modules", (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, (SELECT COUNT(*) FROM training_completions c WHERE c.module_id = m.id) as assignment_count
    FROM training_modules m ORDER BY m.created_at DESC
  `).all());
});

router.post("/modules", (req, res) => {
  const { name, role, description } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = uuidv4();
  db.prepare("INSERT INTO training_modules (id, name, role, description) VALUES (?, ?, ?, ?)")
    .run(id, name, role || "ALL", description || null);
  res.status(201).json(db.prepare("SELECT * FROM training_modules WHERE id = ?").get(id));
});

router.delete("/modules/:id", (req, res) => {
  const mod = db.prepare("SELECT id FROM training_modules WHERE id = ?").get(req.params.id);
  if (!mod) return res.status(404).json({ error: "Module not found" });
  db.prepare("DELETE FROM training_completions WHERE module_id = ?").run(req.params.id);
  db.prepare("DELETE FROM training_modules WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- Completions (assignments) ----
router.get("/completions", (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, m.name as module_name, m.role as module_role, u.name as user_name, u.role as user_role
    FROM training_completions c
    JOIN training_modules m ON m.id = c.module_id
    JOIN users u ON u.id = c.user_id
    ORDER BY c.created_at DESC
  `).all());
});

router.post("/completions", (req, res) => {
  const { moduleId, userId } = req.body;
  if (!moduleId || !userId) return res.status(400).json({ error: "moduleId and userId are required" });
  const mod = db.prepare("SELECT id FROM training_modules WHERE id = ?").get(moduleId);
  if (!mod) return res.status(400).json({ error: "Module not found" });
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(400).json({ error: "User not found" });

  const existing = db.prepare("SELECT id FROM training_completions WHERE module_id = ? AND user_id = ?").get(moduleId, userId);
  if (existing) return res.status(409).json({ error: "This user is already assigned this module" });

  const id = uuidv4();
  db.prepare("INSERT INTO training_completions (id, module_id, user_id) VALUES (?, ?, ?)").run(id, moduleId, userId);
  res.status(201).json(db.prepare("SELECT * FROM training_completions WHERE id = ?").get(id));
});

router.patch("/completions/:id/complete", (req, res) => {
  const row = db.prepare("SELECT id FROM training_completions WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Assignment not found" });
  db.prepare("UPDATE training_completions SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), req.params.id);
  res.json(db.prepare("SELECT * FROM training_completions WHERE id = ?").get(req.params.id));
});

router.delete("/completions/:id", (req, res) => {
  const row = db.prepare("SELECT id FROM training_completions WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Assignment not found" });
  db.prepare("DELETE FROM training_completions WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- Summary ----
router.get("/summary", (req, res) => {
  const completions = db.prepare(`
    SELECT c.*, u.role as user_role FROM training_completions c JOIN users u ON u.id = c.user_id
  `).all();
  const total = completions.length;
  const completed = completions.filter(c => c.status === "completed").length;
  const pending = total - completed;

  const byRole = new Map();
  completions.forEach(c => {
    if (!byRole.has(c.user_role)) byRole.set(c.user_role, { role: c.user_role, total: 0, completed: 0 });
    const row = byRole.get(c.user_role);
    row.total += 1;
    if (c.status === "completed") row.completed += 1;
  });

  res.json({
    totalModules: db.prepare("SELECT COUNT(*) c FROM training_modules").get().c,
    totalAssignments: total,
    completed, pending,
    completionRate: total ? Math.round((completed / total) * 1000) / 10 : 0,
    byRole: [...byRole.values()],
  });
});

module.exports = router;
