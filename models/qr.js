const os = require("os");
const QRCode = require("qrcode");

// A QR code is scanned by a phone, not by the PC running the admin dashboard —
// so "localhost" (which is how the admin's own browser usually reaches the
// API) is useless baked into a QR: on the phone, "localhost" means the phone
// itself, giving "can't be reached". Always resolve this machine's real LAN
// IP (e.g. 192.168.x.x) instead, so the same QR works for the admin AND for a
// phone on the same Wi-Fi. Only falls back to the request's own host if no
// LAN interface can be found (e.g. no network connection at all).
// Dev machines often also carry virtual adapters (VirtualBox host-only,
// VMware, Hyper-V) that show up as "external" IPv4 interfaces but are only
// reachable from other VMs on the same host — never from a phone. Skip those
// by name so a real Wi-Fi/Ethernet adapter is preferred.
const VIRTUAL_ADAPTER_PATTERN = /virtualbox|vmware|hyper-v|vethernet|virtual/i;

function getLanIp(fallback) {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue;
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }

  if (candidates.length === 0) return fallback;
  // Prefer Wi-Fi, since that's what a phone is most likely sharing with this machine.
  const wifi = candidates.find((c) => /wi-?fi|wlan/i.test(c.name));
  return (wifi || candidates[0]).address;
}

// Builds the public trace URL for a batch, using the frontend's dev port (5173)
// on this machine's LAN IP — so it works from localhost AND from another
// device on the same network (e.g. a phone scanning the QR).
function buildTraceUrl(host, batch) {
  const identifier = batch.batch_code || batch.id;
  return `http://${getLanIp(host)}:5173/trace/${identifier}`;
}

async function generateQRForBatch(host, batch) {
  const traceUrl = buildTraceUrl(host, batch);
  // Returns a base64 data URL (e.g. "data:image/png;base64,...") using the `qrcode` library
  const qrDataUrl = await QRCode.toDataURL(traceUrl, { width: 320, margin: 1 });
  return { traceUrl, qrDataUrl };
}

module.exports = { generateQRForBatch, buildTraceUrl };
