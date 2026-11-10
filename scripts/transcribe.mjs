// WAV を basic-pitch で MIDI ノートに戻し、テンポの格子とスケールにどれだけ合うかを測る。
// usage: node scripts/transcribe.mjs in.wav --bpm 100 --scale C [--json out.json]
import * as tf from "@tensorflow/tfjs";
import { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } from "@spotify/basic-pitch";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const input = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const bpm = Number(opt("--bpm", 100));
const scaleRoot = opt("--scale", "C");
const jsonOut = opt("--json", null);

const raw = execFileSync("ffmpeg", ["-v", "error", "-i", input, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);

const modelDir = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@spotify/basic-pitch/model");
const manifest = JSON.parse(readFileSync(join(modelDir, "model.json"), "utf8"));
const weightData = new Uint8Array(readFileSync(join(modelDir, "group1-shard1of1.bin"))).buffer;
const model = tf.loadGraphModel({
  load: async () => ({
    modelTopology: manifest.modelTopology,
    format: manifest.format, generatedBy: manifest.generatedBy, convertedBy: manifest.convertedBy,
    weightSpecs: manifest.weightsManifest.flatMap((g) => g.weights),
    weightData,
  }),
});

const bp = new BasicPitch(model);
const frames = [], onsets = [], contours = [];
const t0 = Date.now();
await bp.evaluateModel(audio, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, () => {});
const notes = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.5, 0.3, 11)));
notes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

// テンポ格子(16分)への当てはまり: 位相を全探索し、最もずれが小さい位相での平均ずれ
const step = 60 / bpm / 4;
let best = { phase: 0, err: Infinity };
for (let p = 0; p < step; p += 0.002) {
  const err = notes.reduce((s, n) => { const x = ((n.startTimeSeconds - p) % step + step) % step; return s + Math.min(x, step - x); }, 0) / Math.max(1, notes.length);
  if (err < best.err) best = { phase: p, err };
}
const NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const root = NAMES.indexOf(scaleRoot);
const major = [0,2,4,5,7,9,11].map((d) => (d + root) % 12);
const inScale = notes.filter((n) => major.includes(n.pitchMidi % 12)).length;
const maxPoly = (() => { let m = 0; for (const n of notes) { const c = notes.filter((k) => k.startTimeSeconds <= n.startTimeSeconds && k.startTimeSeconds + k.durationSeconds > n.startTimeSeconds).length; m = Math.max(m, c); } return m; })();

const summary = {
  input, seconds: +(audio.length / 22050).toFixed(1), notes: notes.length, transcribeMs: Date.now() - t0,
  pitchRange: notes.length ? [Math.min(...notes.map((n) => n.pitchMidi)), Math.max(...notes.map((n) => n.pitchMidi))] : null,
  inScaleRatio: +(inScale / Math.max(1, notes.length)).toFixed(3),
  gridPhaseSec: +best.phase.toFixed(3),
  meanGridErrorMs: +(best.err * 1000).toFixed(1), randomBaselineMs: +(step / 4 * 1000).toFixed(1),
  maxPolyphony: maxPoly,
};
console.log(JSON.stringify(summary));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, notes }, null, 1));
