// Local server for the ESP32-CAM inference upload.
// No npm install needed. Run with:  node server.js
// (ES module version, works when package.json has "type": "module")
//
// ESP32 sends:  POST /api/inference
//   { "node_id": "NODE_01", "label": "person", "confidence": 0.87, "image": "<base64 JPEG>" }
//
// Pi GUI reads: GET /api/latest/NODE_01   -> latest JPEG of that node
//               (response header X-Image-Time = upload time in ms)
//
// Optional: set API_KEY env var to require the x-api-key header, e.g.
//   API_KEY=same-string-as-esp32 node server.js

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const UPLOAD_DIR = path.join(__dirname, "uploads");
const LOG_FILE = path.join(__dirname, "detections.jsonl");
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB is plenty for a QVGA JPEG in Base64

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// node_id -> { jpeg: Buffer, time: ms }
const latest = {};

// ---------- helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readDetections(limit = 50) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => JSON.parse(l))
    .reverse(); // newest first
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const NODE_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Latest image for a node: memory first, then fall back to the log
// (so the Pi still gets an image after a server restart).
function getLatest(nodeId) {
  if (latest[nodeId]) return latest[nodeId];

  if (!fs.existsSync(LOG_FILE)) return null;
  const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (rec.node_id !== nodeId) continue;

    const filePath = path.join(UPLOAD_DIR, path.basename(rec.file));
    if (!fs.existsSync(filePath)) return null;

    latest[nodeId] = { jpeg: fs.readFileSync(filePath), time: new Date(rec.time).getTime() };
    return latest[nodeId];
  }
  return null;
}

// ---------- route handlers ----------

async function handleInference(req, res) {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return sendJson(res, 401, { ok: false, error: "bad api key" });
  }

  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch (err) {
    console.log("Bad request:", err.message);
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  const nodeId = String(data.node_id ?? data.node ?? "");
  const label = typeof data.label === "string" ? data.label : "unknown";
  const confidence = Number(data.confidence);

  if (!NODE_RE.test(nodeId)) {
    return sendJson(res, 400, { ok: false, error: "need valid node_id (letters, digits, _ or -)" });
  }

  if (!data.image || typeof data.image !== "string" || Number.isNaN(confidence)) {
    return sendJson(res, 400, { ok: false, error: "need label, confidence, image" });
  }

  const jpeg = Buffer.from(data.image, "base64");

  // Every JPEG starts with FF D8
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return sendJson(res, 400, { ok: false, error: "image is not a valid JPEG" });
  }

  const now = new Date();
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const fileName = `${nodeId}_${now.toISOString().replace(/[:.]/g, "-")}_${safeLabel}_${confidence.toFixed(2)}.jpg`;

  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), jpeg);

  latest[nodeId] = { jpeg, time: now.getTime() };

  const record = {
    time: now.toISOString(),
    node_id: nodeId,
    label,
    confidence,
    file: fileName,
    bytes: jpeg.length,
    from: req.socket.remoteAddress,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");

  console.log(`[${record.time}] ${nodeId} ${label} ${confidence.toFixed(2)}  ${(jpeg.length / 1024).toFixed(1)} KB  from ${record.from}`);

  sendJson(res, 200, { ok: true, file: fileName });
}

function handleLatest(req, res, url) {
  const nodeId = decodeURIComponent(url.replace("/api/latest/", ""));

  if (!NODE_RE.test(nodeId)) {
    return sendJson(res, 400, { ok: false, error: "bad node id" });
  }

  const entry = getLatest(nodeId);

  if (!entry) {
    res.writeHead(404);
    return res.end("no image for this node");
  }

  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": entry.jpeg.length,
    "X-Image-Time": String(entry.time),
    "Cache-Control": "no-store",
  });
  res.end(entry.jpeg);
}

function handleDashboard(res) {
  const rows = readDetections()
    .map(
      (d) => `
      <div class="card">
        <a href="/uploads/${encodeURIComponent(d.file)}"><img src="/uploads/${encodeURIComponent(d.file)}" loading="lazy"></a>
        <div><b>${escapeHtml(d.node_id || "?")}</b> ${escapeHtml(d.label)} ${(d.confidence * 100).toFixed(0)}%</div>
        <small>${escapeHtml(d.time)}</small>
      </div>`
    )
    .join("");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>ESP32-CAM detections</title>
<style>
  body{font-family:system-ui,sans-serif;margin:16px;background:#111;color:#eee}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .card{background:#1c1c1c;border-radius:8px;padding:8px}
  img{width:100%;border-radius:6px;display:block;margin-bottom:6px}
  small{color:#999}
</style></head>
<body><h2>ESP32-CAM detections</h2>
<div class="grid">${rows || "<p>No detections yet.</p>"}</div>
</body></html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function handleUploadFile(req, res) {
  const name = path.basename(decodeURIComponent(req.url.replace("/uploads/", "")));
  const filePath = path.join(UPLOAD_DIR, name);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end("not found");
  }

  res.writeHead(200, { "Content-Type": "image/jpeg" });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  try {
    if (req.method === "POST" && url === "/api/inference") return await handleInference(req, res);
    if (req.method === "GET" && url === "/api/inference") return sendJson(res, 200, readDetections());
    if (req.method === "GET" && url.startsWith("/api/latest/")) return handleLatest(req, res, url);
    if (req.method === "GET" && url === "/") return handleDashboard(res);
    if (req.method === "GET" && url.startsWith("/uploads/")) return handleUploadFile(req, res);

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    console.error("Server error:", err);
    sendJson(res, 500, { ok: false, error: "server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}\n`);
  console.log("Put one of these in SERVER_URL on the ESP32:");
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`  http://${iface.address}:${PORT}/api/inference`);
      }
    }
  }
  console.log(`\nPi GUI SERVER value: http://<this-machine-ip>:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
});