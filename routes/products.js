const express = require("express");
const router = express.Router();
const { createProduct, updateProduct, getAllProducts, getProductById, getProductWithBatchCount, deleteProduct } = require("../models/product");
const { deleteDocumentsForEntity } = require("../models/documents");

router.get("/", (req, res) => {
  res.json(getAllProducts());
});

router.get("/:id", (req, res) => {
  const product = getProductWithBatchCount(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

router.post("/", (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: "name is required" });

  try {
    const product = createProduct(req.body);
    res.status(201).json(product);
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "A product with this name already exists" });
    }
    res.status(400).json({ error: err.message });
  }
});

router.patch("/:id", (req, res) => {
  const product = getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  if (!req.body.name) return res.status(400).json({ error: "name is required" });

  try {
    const updated = updateProduct(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "A product with this name already exists" });
    }
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", (req, res) => {
  const product = getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });

  deleteProduct(req.params.id);
  deleteDocumentsForEntity("product", req.params.id);
  res.status(204).end();
});

module.exports = router;
