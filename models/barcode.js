const bwipjs = require("bwip-js");

// Code128 encodes arbitrary alphanumeric text (no fixed digit-count format
// like EAN/GTIN requires), which fits our human-readable batch codes exactly.
// This is a separate, warehouse/inventory-facing barcode — distinct from the
// customer-facing QR code, which encodes the public trace URL.
async function generateBarcodeForBatch(batch) {
  const text = batch.batch_code || batch.id;
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale: 3,
    height: 12,
    includetext: true,
    textxalign: "center",
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}

module.exports = { generateBarcodeForBatch };
