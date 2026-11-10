// SDK を通さず、短時間トークンを access_token として Lyria RealTime の WebSocket に渡して接続できるか試す。
// usage: node --env-file=.env scripts/token-ws-test.mjs
import { GoogleGenAI } from "@google/genai";

const admin = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1alpha" } });
async function newToken() {
  return admin.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60e3).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60e3).toISOString(),
      httpOptions: { apiVersion: "v1alpha" },
    },
  });
}

async function attempt(label, url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let bytes = 0, setupDone = false;
    const end = (why) => { try { ws.close(); } catch {} resolve({ label, setupDone, bytes, why }); };
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/lyria-realtime-exp" } }));
    ws.onmessage = async (ev) => {
      const text = typeof ev.data === "string" ? ev.data : await ev.data.text();
      const m = JSON.parse(text);
      if (m.setupComplete) {
        setupDone = true;
        ws.send(JSON.stringify({ clientContent: { weightedPrompts: [{ text: "solo flute", weight: 1 }] } }));
        ws.send(JSON.stringify({ playbackControl: "PLAY" }));
      }
      for (const c of m.serverContent?.audioChunks ?? []) bytes += c.data?.length ?? 0;
      if (bytes > 200000) end("ok");
    };
    ws.onclose = (e) => resolve({ label, setupDone, bytes, why: `close ${e.code} ${e.reason}` });
    ws.onerror = () => {};
    setTimeout(() => end("timeout"), 15000);
  });
}

const base = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage";
for (const v of ["v1alpha", "v1beta"]) {
  for (const method of ["BidiGenerateMusic", "BidiGenerateMusicConstrained"]) {
    const t = await newToken();
    console.log(JSON.stringify(await attempt(`${v} ${method} access_token`, `${base}.${v}.GenerativeService.${method}?access_token=${encodeURIComponent(t.name)}`)));
  }
}
process.exit(0);
