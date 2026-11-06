// 文字起こし結果を整形し、整形後の MIDI を簡単な合成音で鳴らした WAV と、元音声の同じ区間を並べた聴き比べ用ファイルを作る。
// usage: node scripts/ghost-render.mjs out/lead_c_100 --bpm 100 --root C --role lead
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cleanToGhost, NOTE_NAMES } from "../src/core/clean.js";

const [base, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const bpm = Number(opt("--bpm", 100)), root = opt("--root", "C"), role = opt("--role", "lead");
const { notes: raw } = JSON.parse(readFileSync(`${base}.json`, "utf8"));
const res = cleanToGhost(raw, { bpm, root, role, bars: 4 });
const step = 60 / bpm / 4;

const sr = 48000, total = Math.ceil(64 * step * sr);
const buf = new Float32Array(total);
for (const n of res.notes) {
  const f = 440 * 2 ** ((n.pitch - 69) / 12);
  const s0 = Math.round(n.step * step * sr), len = Math.round(n.len * step * sr);
  for (let i = 0; i < len && s0 + i < total; i++) {
    const t = i / sr, env = Math.min(1, i / 200) * Math.exp(-3 * t) * (i > len - 400 ? (len - i) / 400 : 1);
    const ph = (t * f) % 1;
    buf[s0 + i] += 0.25 * (0.6 * (2 * ph - 1) + 0.4 * Math.sin(2 * Math.PI * f * t)) * env * (0.5 + 0.5 * n.vel);
  }
}
const pcm = Buffer.alloc(total * 2);
buf.forEach((v, i) => pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2));
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
writeFileSync(`${base}.ghost.wav`, Buffer.concat([h, pcm]));

// 聴き比べ: 元音声の同じ4小節 → 1拍の無音 → 整形後のMIDI → 両方を重ねたもの
const dur = (64 * step).toFixed(3);
execFileSync("ffmpeg", ["-v", "error", "-y",
  "-ss", res.startSec.toFixed(3), "-t", dur, "-i", `${base}.wav`, "-i", `${base}.ghost.wav`,
  "-filter_complex",
  `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit[o1][o2];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit[g1][g2];` +
  `[o2][g2]amix=inputs=2:normalize=0[mix];anullsrc=r=48000:cl=stereo,atrim=0:0.6[s1];anullsrc=r=48000:cl=stereo,atrim=0:0.6[s2];` +
  `[o1][s1][g1][s2][mix]concat=n=5:v=0:a=1[out]`,
  "-map", "[out]", "-b:a", "160k", `${base}.compare.mp3`]);

const roll = res.notes.map((n) => `${n.step}:${NOTE_NAMES[n.pitch % 12]}${Math.floor(n.pitch / 12) - 1}x${n.len}`).join(" ");
console.log(JSON.stringify({ base, rawNotes: raw.length, ghostNotes: res.notes.length, startSec: +res.startSec.toFixed(3), dropped: res.dropped }));
console.log(roll);
