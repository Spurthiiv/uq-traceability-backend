const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const db = require("../db/init");
const { haversineKm } = require("../models/geo");

// ---- Zones (BRD Section 6.3/6.4 — geofenced hierarchy + lifecycle) ----
router.get("/zones", (req, res) => {
  res.json(db.prepare(`
    SELECT z.*, (SELECT COUNT(*) FROM hubs h WHERE h.zone_id = z.id) as hub_count
    FROM zones z ORDER BY z.created_at DESC
  `).all());
});

router.post("/zones", (req, res) => {
  const { name, zoneLevel, parentZoneId, status } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO zones (id, name, zone_level, parent_zone_id, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, zoneLevel || "ward", parentZoneId || null, status || "draft");
  res.status(201).json(db.prepare("SELECT * FROM zones WHERE id = ?").get(id));
});

router.patch("/zones/:id/status", (req, res) => {
  const zone = db.prepare("SELECT id FROM zones WHERE id = ?").get(req.params.id);
  if (!zone) return res.status(404).json({ error: "Zone not found" });
  db.prepare("UPDATE zones SET status = ? WHERE id = ?").run(req.body.status, req.params.id);
  res.json(db.prepare("SELECT * FROM zones WHERE id = ?").get(req.params.id));
});

// Edit a zone's own fields (name, level, and — critically — which zone it
// nests under), not just its lifecycle status. Needed because a zone can't
// always just be deleted and recreated (e.g. once it already has hubs
// assigned, delete is blocked).
router.patch("/zones/:id", (req, res) => {
  const zone = db.prepare("SELECT * FROM zones WHERE id = ?").get(req.params.id);
  if (!zone) return res.status(404).json({ error: "Zone not found" });
  const { name, zoneLevel, parentZoneId } = req.body;

  if (parentZoneId === req.params.id) {
    return res.status(400).json({ error: "A zone cannot be its own parent" });
  }

  db.prepare("UPDATE zones SET name = ?, zone_level = ?, parent_zone_id = ? WHERE id = ?")
    .run(name ?? zone.name, zoneLevel ?? zone.zone_level, parentZoneId === "" ? null : (parentZoneId ?? zone.parent_zone_id), req.params.id);
  res.json(db.prepare("SELECT * FROM zones WHERE id = ?").get(req.params.id));
});

// Set a zone's geofence — a center point + radius (km), used to render it on
// the Geofencing Map. Kept separate from the general edit endpoint so the
// map's "click to place" action doesn't need to resend every other field.
router.patch("/zones/:id/location", (req, res) => {
  const zone = db.prepare("SELECT id FROM zones WHERE id = ?").get(req.params.id);
  if (!zone) return res.status(404).json({ error: "Zone not found" });
  const { latitude, longitude, radiusKm } = req.body;
  if (latitude === undefined || longitude === undefined) return res.status(400).json({ error: "latitude and longitude are required" });
  db.prepare("UPDATE zones SET latitude = ?, longitude = ?, radius_km = ? WHERE id = ?")
    .run(latitude, longitude, radiusKm || 2, req.params.id);
  res.json(db.prepare("SELECT * FROM zones WHERE id = ?").get(req.params.id));
});

router.delete("/zones/:id", (req, res) => {
  const zone = db.prepare("SELECT id FROM zones WHERE id = ?").get(req.params.id);
  if (!zone) return res.status(404).json({ error: "Zone not found" });
  const hubCount = db.prepare("SELECT COUNT(*) c FROM hubs WHERE zone_id = ?").get(req.params.id).c;
  if (hubCount > 0) return res.status(400).json({ error: "Cannot delete a zone that still has hubs assigned to it" });
  db.prepare("DELETE FROM zones WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- Hubs (BRD Section 7.6 ADM-03 — hub/ward mapping) ----
router.get("/hubs", (req, res) => {
  const rows = db.prepare(`
    SELECT h.*, z.name as zone_name, z.latitude as zone_latitude, z.longitude as zone_longitude, z.radius_km as zone_radius_km
    FROM hubs h LEFT JOIN zones z ON z.id = h.zone_id
    ORDER BY h.created_at DESC
  `).all();
  // withinZone is null when there isn't enough placed data to check (hub or
  // its assigned zone hasn't been located on the map yet) — not the same as
  // "outside", so the UI can tell "unknown" apart from "flagged".
  res.json(rows.map(h => {
    const { zone_latitude, zone_longitude, zone_radius_km, ...hub } = h;
    let withinZone = null;
    let distanceFromZoneKm = null;
    if (hub.latitude != null && hub.longitude != null && zone_latitude != null && zone_longitude != null) {
      distanceFromZoneKm = Math.round(haversineKm(hub.latitude, hub.longitude, zone_latitude, zone_longitude) * 100) / 100;
      withinZone = distanceFromZoneKm <= zone_radius_km;
    }
    return { ...hub, withinZone, distanceFromZoneKm };
  }));
});

router.post("/hubs", (req, res) => {
  const { name, zoneId, address, status } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO hubs (id, name, zone_id, address, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, zoneId || null, address || null, status || "active");
  res.status(201).json(db.prepare("SELECT * FROM hubs WHERE id = ?").get(id));
});

router.patch("/hubs/:id/status", (req, res) => {
  const hub = db.prepare("SELECT id FROM hubs WHERE id = ?").get(req.params.id);
  if (!hub) return res.status(404).json({ error: "Hub not found" });
  db.prepare("UPDATE hubs SET status = ? WHERE id = ?").run(req.body.status, req.params.id);
  res.json(db.prepare("SELECT * FROM hubs WHERE id = ?").get(req.params.id));
});

// Edit a hub's own fields (name, ward/zone assignment, address) — not just
// its active/inactive status. A hub's serviceability area can genuinely
// change (BRD ADM-03), so this can't be delete-and-recreate: a hub with
// existing batches/orders referencing it would orphan that history.
router.patch("/hubs/:id", (req, res) => {
  const hub = db.prepare("SELECT * FROM hubs WHERE id = ?").get(req.params.id);
  if (!hub) return res.status(404).json({ error: "Hub not found" });
  const { name, zoneId, address } = req.body;

  db.prepare("UPDATE hubs SET name = ?, zone_id = ?, address = ? WHERE id = ?")
    .run(name ?? hub.name, zoneId === "" ? null : (zoneId ?? hub.zone_id), address ?? hub.address, req.params.id);
  res.json(db.prepare("SELECT * FROM hubs WHERE id = ?").get(req.params.id));
});

// Set a hub's map location (a single point) — same rationale as the zone
// location endpoint above.
router.patch("/hubs/:id/location", (req, res) => {
  const hub = db.prepare("SELECT id FROM hubs WHERE id = ?").get(req.params.id);
  if (!hub) return res.status(404).json({ error: "Hub not found" });
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) return res.status(400).json({ error: "latitude and longitude are required" });
  db.prepare("UPDATE hubs SET latitude = ?, longitude = ? WHERE id = ?").run(latitude, longitude, req.params.id);
  res.json(db.prepare("SELECT * FROM hubs WHERE id = ?").get(req.params.id));
});

router.delete("/hubs/:id", (req, res) => {
  const hub = db.prepare("SELECT id FROM hubs WHERE id = ?").get(req.params.id);
  if (!hub) return res.status(404).json({ error: "Hub not found" });
  db.prepare("DELETE FROM hubs WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- Categories (BRD Section 7.6 ADM-01 — catalog master data) ----
router.get("/categories", (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category = c.name) as product_count
    FROM categories c ORDER BY c.name ASC
  `).all());
});

router.post("/categories", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = uuidv4();
  try {
    db.prepare("INSERT INTO categories (id, name) VALUES (?, ?)").run(id, name.trim());
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ error: "A category with this name already exists" });
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json(db.prepare("SELECT * FROM categories WHERE id = ?").get(id));
});

router.delete("/categories/:id", (req, res) => {
  const category = db.prepare("SELECT id FROM categories WHERE id = ?").get(req.params.id);
  if (!category) return res.status(404).json({ error: "Category not found" });
  db.prepare("DELETE FROM categories WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
