// Lyria 3.5 / 3 Pro / 3 Clip（generateContent）で曲を生成し、WAV と付随テキストを保存する検証用スクリプト。
// RealTime と違い、BPM やキーは設定値ではなくプロンプトの文章で伝える。
// usage: node --env-file=.env scripts/lyria-gen.mjs <model> <out.wav> "<prompt>"
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [model, outPath, prompt] = process.argv.slice(2);
const t0 = Date.now();
const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["AUDIO", "TEXT"], responseFormat: { audio: { mimeType: "AUDIO_WAV" } } },
  }),
});
const ms = Date.now() - t0;
if (!r.ok) {
  console.log(JSON.stringify({ model, ok: false, status: r.status, ms, body: (await r.text()).slice(0, 400) }));
  process.exit(1);
}
const j = await r.json();
const parts = j.candidates?.[0]?.content?.parts ?? [];
const text = parts.filter((p) => p.text).map((p) => p.text).join("\n");
const audio = parts.find((p) => p.inlineData?.data);
mkdirSync(dirname(outPath), { recursive: true });
let bytes = 0, mime = null;
if (audio) {
  const buf = Buffer.from(audio.inlineData.data, "base64");
  bytes = buf.length;
  mime = audio.inlineData.mimeType;
  writeFileSync(outPath, buf);
}
writeFileSync(outPath.replace(/\.\w+$/, ".txt"), text);
console.log(JSON.stringify({ model, ok: !!audio, ms, mime, bytes, modelVersion: j.modelVersion, text: text.slice(0, 200) }));
