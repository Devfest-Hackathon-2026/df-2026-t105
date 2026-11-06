// Lyria RealTime から指定秒数だけ音声を受け取り、WAV に保存する検証用スクリプト。
// usage: node --env-file=.env scripts/lyria-rt.mjs out/name.wav '{"prompts":[...],"config":{...},"seconds":20}'
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [outPath, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson);
const seconds = spec.seconds ?? 20;

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1alpha" });

const chunks = [];
let mime = null;
let bytes = 0;
let firstAudioAt = null;
const t0 = Date.now();
let resolveDone;
const done = new Promise((r) => (resolveDone = r));

const session = await client.live.music.connect({
  model: "models/lyria-realtime-exp",
  callbacks: {
    onmessage: (m) => {
      if (m.filteredPrompt) console.error("filtered:", JSON.stringify(m.filteredPrompt));
      for (const c of m.serverContent?.audioChunks ?? []) {
        if (!mime) mime = c.mimeType;
        if (firstAudioAt === null) firstAudioAt = Date.now() - t0;
        const b = Buffer.from(c.data, "base64");
        chunks.push(b);
        bytes += b.length;
      }
    },
    onerror: (e) => console.error("error:", e?.message ?? e),
    onclose: (e) => { console.error("closed", e?.reason ?? ""); resolveDone(); },
  },
});

await session.setWeightedPrompts({ weightedPrompts: spec.prompts });
await session.setMusicGenerationConfig({ musicGenerationConfig: spec.config ?? {} });
await session.play();

const rate = () => Number(/rate=(\d+)/.exec(mime ?? "")?.[1] ?? 48000);
const ch = () => Number(/channels=(\d+)/.exec(mime ?? "")?.[1] ?? 2);
const timer = setInterval(() => {
  if (bytes >= seconds * rate() * ch() * 2) { session.close(); }
}, 200);
const hardStop = setTimeout(() => session.close(), (seconds + 60) * 1000);
await done;
clearInterval(timer); clearTimeout(hardStop);

const pcm = Buffer.concat(chunks);
const sr = rate(), nch = ch();
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(nch, 22); header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * nch * 2, 28);
header.writeUInt16LE(nch * 2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, Buffer.concat([header, pcm]));
console.log(JSON.stringify({ outPath, mime, seconds: pcm.length / (sr * nch * 2), firstAudioMs: firstAudioAt, wallMs: Date.now() - t0 }));
process.exit(0);
