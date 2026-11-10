// 短時間トークン（ephemeral token）で Lyria RealTime に接続できるかを確かめる。
// usage: node --env-file=.env scripts/token-test.mjs
import { GoogleGenAI } from "@google/genai";

const admin = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1alpha" } });
const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const newSessionExpireTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();
let token;
try {
  token = await admin.authTokens.create({ config: { uses: 1, expireTime, newSessionExpireTime, httpOptions: { apiVersion: "v1alpha" } } });
  console.log("token created:", token.name?.slice(0, 12) + "…");
} catch (e) {
  console.log("token create failed:", e.message);
  process.exit(1);
}

for (const apiVersion of ["v1alpha", "v1beta"]) {
  const ai = new GoogleGenAI({ apiKey: token.name, httpOptions: { apiVersion } });
  let bytes = 0, err = null, closeReason = "";
  try {
    const session = await ai.live.music.connect({
      model: "models/lyria-realtime-exp",
      callbacks: {
        onmessage: (m) => { for (const c of m.serverContent?.audioChunks ?? []) bytes += c.data?.length ?? 0; },
        onerror: (e) => { err = e?.message ?? String(e); },
        onclose: (e) => { closeReason = `${e?.code ?? ""} ${e?.reason ?? ""}`; },
      },
    });
    await session.setWeightedPrompts({ weightedPrompts: [{ text: "solo flute", weight: 1 }] });
    await session.play();
    await new Promise((r) => setTimeout(r, 7000));
    session.close();
  } catch (e) {
    err = e.message;
  }
  console.log(JSON.stringify({ apiVersion, receivedBase64Bytes: bytes, err, closeReason }));
}
process.exit(0);
