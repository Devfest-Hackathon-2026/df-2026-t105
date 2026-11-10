// Lyria のドラム音声を drums.js で耳コピし、最初の小節のパターンと各ステップを JSON で出す（診断用）。
// usage: node scripts/drums-diag.mjs out/eval/drums_120.wav 120
import { execFileSync } from "node:child_process";
import { transcribeDrums, estimateStartSec } from "../src/core/drums.js";
const [path, bpmS] = process.argv.slice(2);
const bpm = Number(bpmS), sr = 22050;
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], { maxBuffer: 1 << 27 });
const mono = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const startSec = estimateStartSec(mono, sr, bpm);
const notes = transcribeDrums(mono, sr, { bpm, startSec, bars: 4 });
const steps = (p) => notes.filter((n) => n.pitch === p).map((n) => n.step);
console.log(JSON.stringify({ path, bpm, startSec: +startSec.toFixed(3), kick: steps(36), snare: steps(38), hat: steps(42) }));
