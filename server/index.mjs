import { createTranscriptionJobs } from "./transcription-jobs.mjs";
import { parseTranscription } from "./transcription.mjs";
// 公開用の中継サーバー。API キーや GCP の認証はこのサーバーだけが持ち、ブラウザには渡さない。
// - GET  /*                       : ビルド済みの画面（dist/）を返す
// - GET  /api/config              : どのモデルが使えるか（画面がモデルの選択肢を決めるのに使う）
// - POST /api/gemini/:model       : Gemini の generateContent を中継する（許可したモデルだけ）
// - POST /api/music/:model        : Lyria 3.5 / 3 Pro / 3 Clip で作曲し、{ audio, mime, text, model } を返す
// - WS   /ws/...BidiGenerateMusic : Lyria RealTime の WebSocket を中継する（AI Studio のキーがあるときだけ）
// - POST /api/transcribe?instruments=drums : 音声（WAV）を muscriptor のサーバー（MUSCRIPTOR_URL）で採譜し、{ events } を返す
// Lyria RealTime は短時間トークン（ephemeral token）を受け付けないため、中継が必要になる（docs/経緯と設計.md 8章）。
//
// 呼び出し先は2通り。
// - AI Studio（GEMINI_API_KEY）: generativelanguage.googleapis.com。Lyria 3.5 と RealTime が使える
// - Vertex AI / Agent Platform（VERTEX_PROJECT）: aiplatform.googleapis.com。ハッカソンの GCP クレジットはこちらに使える。
//   Lyria は 3 Pro と 3 Clip（interactions API）。認証は Cloud Run ならサービスアカウント、手元なら gcloud のトークン
// 両方を設定したときは、作曲と Gemini は Vertex、RealTime は AI Studio を使う。
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.GEMINI_API_KEY;
const VERTEX_PROJECT = process.env.VERTEX_PROJECT;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? "global";
// Vertex で使う Gemini のモデル（AI Studio の gemini-flash-latest のような別名は Vertex にはない）
const VERTEX_GEMINI_MODEL = process.env.VERTEX_GEMINI_MODEL ?? "gemini-2.5-flash";
if (!KEY && !VERTEX_PROJECT) {
  console.error("GEMINI_API_KEY か VERTEX_PROJECT のどちらかを設定してください");
  process.exit(1);
}
const BACKEND = VERTEX_PROJECT ? "vertex" : "aistudio";
// muscriptor のサーバー（`muscriptor serve`）。設定されていれば、ドラムなどの耳コピに使う
const MUSCRIPTOR_URL = process.env.MUSCRIPTOR_URL ?? "http://127.0.0.1:8222";
const MUSCRIPTOR_A100_URL = process.env.MUSCRIPTOR_A100_URL ?? "http://127.0.0.1:8223";
const transcriptionJobs = createTranscriptionJobs({ cpuUrl: MUSCRIPTOR_URL, a100Url: MUSCRIPTOR_A100_URL });
async function transcriberHealth(endpoint) {
  if (!endpoint) return false;
  try { return (await fetch(`${endpoint.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ALLOWED_MODELS = new Set(["gemini-flash-latest", "gemini-3.5-flash-lite"]);
// 画面が指定する作曲モデル → 実際に呼ぶモデル。Vertex には 3.5 がないので 3 Pro で代える
const MUSIC_MODELS = BACKEND === "vertex"
  ? { "lyria-3.5": "lyria-3-pro-preview", "lyria-3-pro-preview": "lyria-3-pro-preview", "lyria-3-clip-preview": "lyria-3-clip-preview" }
  : { "lyria-3.5": "lyria-3.5", "lyria-3-pro-preview": "lyria-3-pro-preview", "lyria-3-clip-preview": "lyria-3-clip-preview" };
const MAX_MUSIC_SEC = 60;

// IP ごとの簡易な回数制限（Cloud Run のインスタンス内だけで数える）
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { gemini: 60, music: 15, compose: 20, transcribe: 40 };
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

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---- Vertex の認証。Cloud Run ではメタデータサーバー、手元では gcloud からアクセストークンを取る ----
let tokenCache = { token: "", exp: 0 };
async function vertexToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  try {
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      const j = await r.json();
      tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
      return tokenCache.token;
    }
  } catch {}
  const { execFileSync } = await import("node:child_process");
  const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  tokenCache = { token, exp: Date.now() + 30 * 60_000 };
  return token;
}
const vertexBase = () => `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}`;

async function proxyGemini(req, res, model) {
  if (!ALLOWED_MODELS.has(model)) { res.writeHead(400).end("model not allowed"); return; }
  if (!allow(clientIp(req), "gemini")) { res.writeHead(429).end("too many requests"); return; }
  const body = await readBody(req, 256 * 1024);
  if (!body) { res.writeHead(413).end("too large"); return; }
  let r;
  if (BACKEND === "vertex") {
    // Vertex の generateContent は AI Studio と同じ形の本文を受け取る。thinkingLevel は Gemini 3 系だけなので外す
    const j = JSON.parse(body.toString());
    if (!VERTEX_GEMINI_MODEL.startsWith("gemini-3")) delete j.generationConfig?.thinkingConfig;
    r = await fetch(`${vertexBase()}/publishers/google/models/${VERTEX_GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await vertexToken()}` },
      body: JSON.stringify(j),
    });
  } else {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body,
    });
  }
  res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

/** 作曲。AI Studio は generateContent、Vertex は interactions API。どちらも { audio(base64), mime, text, model } にそろえて返す */
async function compose(req, res, requested) {
  const model = MUSIC_MODELS[requested];
  if (!model) { res.writeHead(400).end("model not allowed"); return; }
  if (!allow(clientIp(req), "compose")) { res.writeHead(429).end("too many requests"); return; }
  const body = await readBody(req, 16 * 1024);
  if (!body) { res.writeHead(413).end("too large"); return; }
  const { prompt } = JSON.parse(body.toString());
  if (typeof prompt !== "string" || !prompt.trim()) { res.writeHead(400).end("prompt required"); return; }
  let out;
  if (BACKEND === "vertex") {
    const r = await fetch(`${vertexBase()}/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${await vertexToken()}` },
      body: JSON.stringify({ model, input: [{ type: "user_input", content: [{ type: "text", text: prompt }] }] }),
    });
    if (!r.ok) { res.writeHead(r.status, { "Content-Type": "text/plain" }).end((await r.text()).slice(0, 500)); return; }
    const j = await r.json();
    const contents = (j.steps ?? []).flatMap((s) => s.content ?? []);
    const audio = contents.find((c) => c.type === "audio" && c.data);
    out = { audio: audio?.data ?? null, mime: audio?.mime_type ?? null, text: contents.filter((c) => c.type === "text").map((c) => c.text).join("\n"), model };
  } else {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["AUDIO", "TEXT"] } }),
    });
    if (!r.ok) { res.writeHead(r.status, { "Content-Type": "text/plain" }).end((await r.text()).slice(0, 500)); return; }
    const j = await r.json();
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const audio = parts.find((p) => p.inlineData?.data);
    out = { audio: audio?.inlineData.data ?? null, mime: audio?.inlineData.mimeType ?? null, text: parts.filter((p) => p.text).map((p) => p.text).join("\n"), model: j.modelVersion ?? model };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
}

/** 音声を muscriptor に送り、SSE で返ってくる音符のイベントを集めて JSON で返す */
async function transcribeWithMuscriptor(req, res, url) {
  const backend = url.searchParams.get("backend") ?? "cpu";
  if (!["cpu", "a100"].includes(backend)) { res.writeHead(400).end("unknown transcription backend"); return; }
  const endpoint = backend === "a100" ? MUSCRIPTOR_A100_URL : MUSCRIPTOR_URL;
  if (!endpoint) { res.writeHead(503).end("MuScriptor CPU is not configured"); return; }
  if (!allow(clientIp(req), "transcribe")) { res.writeHead(429).end("too many requests"); return; }
  const body = await readBody(req, 20 * 1024 * 1024);
  if (!body) { res.writeHead(413).end("too large"); return; }
  const form = new FormData();
  form.append("file", new Blob([body], { type: "audio/wav" }), "take.wav");
  for (const inst of (url.searchParams.get("instruments") ?? "").split(",").filter(Boolean)) form.append("instruments", inst);
  form.append("detect_tempo", "false");
  try {
    const r = await fetch(`${endpoint.replace(/\/$/, "")}/transcribe`, { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
    if (!r.ok) { res.writeHead(502).end(`MuScriptor ${backend}: HTTP ${r.status}`); return; }
    const events = parseTranscription(await r.text());
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ events, backend }));
  } catch (e) {
    console.error(`MuScriptor ${backend}:`, e.message);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(backend === "a100"
      ? "A100 の採譜に接続できません。npm run a100 で起動するか、設定で別の採譜先を選んでください"
      : "MuScriptor CPU の採譜に失敗しました。サーバーを確認するか、ブラウザ内の採譜を選んでください");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (url.pathname === "/api/config") {
      const [cpu, a100] = await Promise.all([transcriberHealth(MUSCRIPTOR_URL), transcriberHealth(MUSCRIPTOR_A100_URL)]);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({
        backend: BACKEND, realtime: !!KEY, music: Object.keys(MUSIC_MODELS), musicModels: MUSIC_MODELS,
        transcriber: cpu ? "muscriptor" : "basic-pitch", transcribers: { cpu, a100 },
        transcription: { default: cpu ? "cpu" : a100 ? "a100" : "browser", models: { cpu: "small", a100: process.env.A100_MODEL ?? "medium" } },
      }));
      return;
    }
    if (url.pathname === "/api/transcription-jobs" && req.method === "POST") {
      if (!allow(clientIp(req), "transcribe")) { res.writeHead(429).end("too many requests"); return; }
      const body = await readBody(req, 20 * 1024 * 1024);
      if (!body) { res.writeHead(413).end(); return; }
      try {
        const job = transcriptionJobs.create(body, { backend: url.searchParams.get("backend") ?? "a100", instruments: (url.searchParams.get("instruments") ?? "").split(",").filter(Boolean) });
        res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify(job));
      } catch(e) { res.writeHead(429).end(e.message); }
      return;
    }
    const jobMatch = /^\/api\/transcription-jobs\/([a-f0-9-]+)$/.exec(url.pathname);
    if (jobMatch && req.method === "GET") {
      const job = transcriptionJobs.get(jobMatch[1]);
      res.writeHead(job ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(job ?? { error: "採譜ジョブが見つかりません" })); return;
    }
    if (url.pathname === "/api/transcribe" && req.method === "POST") return await transcribeWithMuscriptor(req, res, url);
    const mm = /^\/api\/music\/([\w.-]+)$/.exec(url.pathname);
    if (mm && req.method === "POST") return await compose(req, res, mm[1]);
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
  if (!m || !KEY) { socket.destroy(); return; }
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
