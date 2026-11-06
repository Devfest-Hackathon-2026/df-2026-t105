// Prompt ablation: same model/context, two treatments, two roles, two draws each.
// Generated audio and raw results stay in ignored out/; no private recordings are uploaded.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const out = process.argv[2] ?? "out/experiment-transcription";
const origin = process.env.EXPERIMENT_SERVER ?? "http://127.0.0.1:8788";
mkdirSync(out, { recursive: true });
const roles = {
 lead: { instrument: "flutes", text: "solo monophonic dry flute, single notes, a slightly wistful melody that rises in the final bar", context: "The new part plays together with this existing loop (note length is in beats): drums: bars1-4 kick@1,2,3,4 snare@2,4 closed hat@1,1.5,2,2.5,3,3.5,4,4.5; bass melody: bar1 A1(1b) A2(0.5b); bar2 F1(1b) F2(0.5b); bar3 C2(1b) C3(0.5b); bar4 G1(1b) G2(0.5b). Make it fit around them." },
 bass: { instrument: "electric_bass", text: "solo monophonic dry electric bass fingered, single notes, a bouncy bassline locked to the kick drum", context: "The new part plays together with this existing loop (note length is in beats): drums: bars1-4 kick@1,2,3,4 snare@2,4 closed hat@1,1.5,2,2.5,3,3.5,4,4.5. Make it fit around them." },
};
const tasks = [];
for (const [role, spec] of Object.entries(roles)) for (const treatment of ["current", "isolated"]) for (let draw = 1; draw <= 2; draw++) {
 const base = `[0:00 - 0:20] A short loop: ${spec.text}. ${spec.context} no drums, no chords, no other instruments. Strict steady tempo of 100 BPM in 4/4, key of C major. Instrumental only, no vocals, no singing. The track ends at 0:20.`;
 const prompt = treatment === "current" ? base : `DELIVER ONLY THE ISOLATED ${role === "lead" ? "FLUTE LEAD" : "ELECTRIC BASS"} TRACK, as a dry stem for a DAW. ${base} The accompaniment described above is already playing in the user's DAW; it is harmonic and rhythmic reference ONLY. Do NOT render, imitate, double, or add that accompaniment to this output. Exactly one instrument, playing one note at a time. No backing track, no drum kit, percussion, chords, pads, additional bass or melody instruments, vocal sounds, effects or reverb. The delivered audio must contain ONLY the requested ${role} instrument from start to finish.`;
 tasks.push({ id: `${role}-${treatment}-${draw}`, role, treatment, draw, instrument: spec.instrument, model: "lyria-3.5", prompt });
}
// Fixed balanced order: do not generate all control samples before all treatment samples.
const order = [0, 2, 6, 4, 3, 1, 5, 7].map((i) => tasks[i]);
writeFileSync(join(out, "plan.json"), JSON.stringify({ createdAt: new Date().toISOString(), model: "lyria-3.5", requestedSeconds: 20, cropSeconds: 20, replicates: 2, seed: null, tasks: order }, null, 2));
let next = 0;
async function worker() {
 while (next < order.length) {
  const task = order[next++], base = join(out, task.id);
  if (existsSync(`${base}.wav`)) { console.log(`SKIP ${task.id}`); continue; }
  const started = Date.now();
  console.log(`GENERATE ${task.id}`);
  try {
   const r = await fetch(`${origin}/api/music/${task.model}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: task.prompt }), signal: AbortSignal.timeout(240000) });
   if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
   const data = await r.json();
   if (!data.audio) throw new Error("No audio returned");
   const full = `${base}.source`;
   writeFileSync(full, Buffer.from(data.audio, "base64"));
   execFileSync("ffmpeg", ["-y", "-v", "error", "-i", full, "-t", "20", "-ar", "44100", "-ac", "2", `${base}.wav`]);
   writeFileSync(`${base}.generation.json`, JSON.stringify({ ...task, actualModel: data.model, mime: data.mime, generationSeconds: (Date.now() - started) / 1000, text: data.text }, null, 2));
   console.log(`DONE ${task.id} ${(Date.now() - started) / 1000}s`);
  } catch (e) { writeFileSync(`${base}.error.json`, JSON.stringify({ ...task, error: e.message }, null, 2)); console.error(`FAIL ${task.id}: ${e.message}`); }
 }
}
await Promise.all([worker(), worker()]);
