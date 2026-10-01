const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;      // Render injects PORT
const API_KEY = process.env.API_KEY || "";  // set in Render dashboard
const MAX_EVENTS = 50;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- in-memory state (Render disk is ephemeral) ----------
const nodes = new Map();   // nodeId -> { node, label, confidence, source, rssi, updatedAt, image(Buffer|null) }
const events = [];         // recent events, newest first
const clients = new Set(); // SSE clients

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.get("x-api-key") === API_KEY) return next();
  return res.status(401).json({ error: "invalid api key" });
}

function publicNode(n) {
  return {
    node: n.node,
    label: n.label,
    confidence: n.confidence,
    source: n.source,
    rssi: n.rssi ?? null,
    updatedAt: n.updatedAt,
    hasImage: !!n.image,
  };
}

function broadcast(n) {
  const payload = `data: ${JSON.stringify(publicNode(n))}\n\n`;
  for (const c of clients) c.write(payload);
}

function upsert(nodeId, patch) {
  const prev = nodes.get(nodeId) || { node: nodeId, image: null };
  const next = { ...prev, ...patch, node: nodeId, updatedAt: Date.now() };
  nodes.set(nodeId, next);
  events.unshift(publicNode(next));
  if (events.length > MAX_EVENTS) events.pop();
  broadcast(next);
  return next;
}

// ---------- ESP32-CAM upload (Wi-Fi) ----------
app.post("/api/inference", requireKey, (req, res) => {
  const { node = "esp32-cam-1", label = "unknown", confidence = 0, image } = req.body || {};
  let buf = null;
  if (image) {
    try { buf = Buffer.from(image, "base64"); } catch { return res.status(400).json({ error: "bad base64" }); }
  }
  upsert(node, { label, confidence: Number(confidence), source: "wifi", image: buf });
  console.log(`[wifi] ${node} ${label} ${confidence} ${buf ? (buf.length / 1024).toFixed(1) + "KB" : "no image"}`);
  res.json({ ok: true });
});

// ---------- LoRa result (no image) — posted by the Pi receiver ----------
app.post("/api/lora", requireKey, (req, res) => {
  const { node = "esp32-cam-1", label = "unknown", confidence = 0, rssi = null } = req.body || {};
  upsert(node, { label, confidence: Number(confidence), source: "lora", rssi });
  res.json({ ok: true });
});

// ---------- dashboard / Pi GUI reads ----------
app.get("/api/nodes", (_req, res) => res.json([...nodes.values()].map(publicNode)));
app.get("/api/events", (_req, res) => res.json(events));

app.get("/api/image/:node", (req, res) => {
  const n = nodes.get(req.params.node);
  if (!n || !n.image) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
  res.send(n.image);
});

app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000); // keep proxy from closing idle stream
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

app.get("/health", (_req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));