// 公開用の中継サーバー。API キーはこのサーバーだけが持ち、ブラウザには渡さない。
// - GET  /*                       : ビルド済みの画面（dist/）を返す
// - POST /api/gemini/:model       : Gemini の generateContent を中継する（許可したモデルだけ）
// - WS   /ws/...BidiGenerateMusic : Lyria RealTime の WebSocket を中継する
// Lyria RealTime は短時間トークン（ephemeral token）を受け付けないため、中継が必要になる（docs/経緯と設計.md 8章）。
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("GEMINI_API_KEY が設定されていません");
  process.exit(1);
}
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ALLOWED_MODELS = new Set(["gemini-flash-latest", "gemini-3.5-flash-lite", "lyria-3.5", "lyria-3-clip-preview"]);
const MAX_MUSIC_SEC = 60;

// IP ごとの簡易な回数制限（Cloud Run のインスタンス内だけで数える）
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { gemini: 60, music: 15 };
const hits = new Map();
function allow(ip, kind) {
  const now = Date.now();
  const k = `${kind}:${ip}`;
  const arr = (hits.get(k) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= LIMITS[kind]) { hits.set(k, arr); return false; }
  arr.push(now);
  hits.set(k, arr);
  return true;
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".bin": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png" };

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(DIST, "index.html");
  }
  try {
    const body = await readFile(file);
    const immutable = file.includes(`${join(DIST, "assets")}`);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function proxyGemini(req, res, model) {
  if (!ALLOWED_MODELS.has(model)) { res.writeHead(400).end("model not allowed"); return; }
  if (!allow(clientIp(req), "gemini")) { res.writeHead(429).end("too many requests"); return; }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) { res.writeHead(413).end("too large"); return; }
    chunks.push(c);
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: Buffer.concat(chunks),
  });
  res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") { res.writeHead(200).end("ok"); return; }
    const m = /^\/api\/gemini\/([\w.-]+)$/.exec(url.pathname);
    if (m && req.method === "POST") return await proxyGemini(req, res, m[1]);
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res);
    res.writeHead(405).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end("error");
  }
});

// SDK は baseUrl の末尾の / に続けて /ws/... を付けるので、先頭の / が2つになることがある
const MUSIC_PATH = /^\/+ws\/google\.ai\.generativelanguage\.(v1alpha|v1beta)\.GenerativeService\.BidiGenerateMusic$/;
const wss = new WebSocketServer({ noServer: true });
const open = new Map();

server.on("upgrade", (req, socket, head) => {
  // "//ws/..." を new URL に渡すとホスト名として解釈されるので、パスは文字列のまま切り出す
  const m = MUSIC_PATH.exec((req.url ?? "").split("?")[0]);
  const ip = clientIp(req);
  if (!m) { socket.destroy(); return; }
  if ((open.get(ip) ?? 0) >= 2 || !allow(ip, "music")) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    open.set(ip, (open.get(ip) ?? 0) + 1);
    const upstream = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${m[1]}.GenerativeService.BidiGenerateMusic?key=${KEY}`);
    const pending = [];
    const closeBoth = (code = 1000, reason = "") => {
      const c = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
      if (client.readyState <= 1) client.close(c, reason.slice(0, 120));
      if (upstream.readyState <= 1) upstream.close();
    };
    const timer = setTimeout(() => closeBoth(1000, "session time limit"), MAX_MUSIC_SEC * 1000);
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });
    upstream.on("open", () => { for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b }); });
    upstream.on("message", (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
    upstream.on("close", (code, reason) => closeBoth(code, reason.toString()));
    upstream.on("error", () => closeBoth(1011, "upstream error"));
    client.on("close", () => {
      clearTimeout(timer);
      open.set(ip, Math.max(0, (open.get(ip) ?? 1) - 1));
      if (upstream.readyState <= 1) upstream.close();
    });
    client.on("error", () => closeBoth());
  });
});

server.listen(PORT, () => console.log(`ghostnotes server on :${PORT}`));
