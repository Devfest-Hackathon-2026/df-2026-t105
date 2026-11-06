import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseTranscription } from "../server/transcription.mjs";
const out = process.argv[2] ?? "out/experiment-transcription";
const plan = JSON.parse(readFileSync(join(out, "plan.json")));
function notesFrom(events) {
 const starts = new Map(events.filter((e) => e.type === "start").map((e) => [e.index, e]));
 return events.filter((e) => e.type === "end").flatMap((e) => {
  const s = starts.get(e.start_event_index);
  return s && e.end_time > s.start_time ? [{ instrument: s.instrument, pitch: s.pitch, start: s.start_time, end: e.end_time }] : [];
 });
}
function metrics(notes, task) {
 const groups = {};
 for (const n of notes) { const g = groups[n.instrument] ??= { notes: 0, duration: 0, range: [127, 0] }; g.notes++; g.duration += n.end - n.start; g.range[0] = Math.min(g.range[0], n.pitch); g.range[1] = Math.max(g.range[1], n.pitch); }
 const events = notes.flatMap((n) => [{ time: n.start, diff: 1 }, { time: n.end, diff: -1 }]).sort((a, b) => a.time - b.time || a.diff - b.diff);
 let count = 0, max = 0, poly = 0, last = 0, active = 0;
 for (const e of events) { if (count > 1) poly += e.time - last; if (count > 0) active += e.time - last; count += e.diff; max = Math.max(max, count); last = e.time; }
 return { totalNotes: notes.length, groups, targetNotes: notes.filter((n) => n.instrument === task.instrument).length, otherNotes: notes.filter((n) => n.instrument !== task.instrument).length, maxPolyphony: max, polyphonicTimeShare: poly / Math.max(active, 1e-9) };
}
const rows = [];
for (const task of plan.tasks.filter((t) => !process.argv.includes("--controls-only") || t.treatment === "known-midi")) {
 for (const method of (process.argv.includes("--extra") ? ["stem-multitrack", "multitrack-conditioned"] : ["constrained", "multitrack", "stem-constrained"])) {
  const base = join(out, task.id), file = method.startsWith("stem-") ? join(`${base}.stems`, task.role === "bass" ? "bass.wav" : "other.wav") : `${base}.wav`;
  if (!existsSync(file)) continue;
  const resultFile = `${base}.${method}.json`;
  if (existsSync(resultFile)) { rows.push(JSON.parse(readFileSync(resultFile))); continue; }
  const wav = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ar", "22050", "-ac", "1", "-f", "wav", "-"], { maxBuffer: 20 * 1024 * 1024 });
  const form = new FormData(); form.append("file", new Blob([wav], { type: "audio/wav" }), `${task.id}.wav`); form.append("detect_tempo", "false");
  if (["constrained", "stem-constrained"].includes(method)) form.append("instruments", task.instrument);
  if (method === "multitrack-conditioned") for (const instrument of ["flutes", "electric_bass", "drums"]) form.append("instruments", instrument);
  console.log(`TRANSCRIBE ${task.id} ${method}`);
  const started = Date.now();
  try {
   const r = await fetch("http://127.0.0.1:8222/transcribe", { method: "POST", body: form, signal: AbortSignal.timeout(240000) });
   if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
   const raw = await r.text();
   writeFileSync(`${base}.${method}.sse`, raw);
   const events = parseTranscription(raw), notes = notesFrom(events);
   const row = { id: task.id, role: task.role, treatment: task.treatment, draw: task.draw, expectedInstrument: task.instrument, method, model: "small-cpu", seconds: (Date.now() - started) / 1000, ...metrics(notes, task), notes };
   writeFileSync(resultFile, JSON.stringify(row, null, 2)); rows.push(row);
   writeFileSync(join(out, process.argv.includes("--extra") ? "results-extra.json" : process.argv.includes("--controls-only") ? "results-controls.json" : "results.json"), JSON.stringify(rows, null, 2));
   console.log(`DONE ${task.id} ${method}: ${row.totalNotes} notes, ${Object.keys(row.groups).join(", ")}, ${row.seconds}s`);
  } catch (e) { console.log(`ERROR ${task.id} ${method}: ${e.message}`); writeFileSync(`${resultFile}.error`, e.stack); }
 }
}
writeFileSync(join(out, process.argv.includes("--extra") ? "results-extra.json" : process.argv.includes("--controls-only") ? "results-controls.json" : "results.json"), JSON.stringify(rows, null, 2));
