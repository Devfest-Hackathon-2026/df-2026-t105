// muscriptor の JSON（start / end のイベント列）を、耳コピの生の結果と同じ形 { notes: [{startTimeSeconds, durationSeconds, pitchMidi, amplitude}] } にする。
// muscriptor は音の強さを出さないので amplitude は 0.8 で固定する。
// usage: node scripts/mus2raw.mjs in.json out.json
import { readFileSync, writeFileSync } from "node:fs";
const [inp, out] = process.argv.slice(2);
const ev = JSON.parse(readFileSync(inp, "utf8"));
const starts = new Map(ev.filter((e) => e.type === "start").map((e) => [e.index, e]));
const notes = ev.filter((e) => e.type === "end").map((e) => {
  const s = starts.get(e.start_event_index);
  return { startTimeSeconds: s.start_time, durationSeconds: Math.max(0.03, e.end_time - s.start_time), pitchMidi: s.pitch, amplitude: 0.8 };
}).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
writeFileSync(out, JSON.stringify({ notes }));
console.log(`${notes.length} notes`);
