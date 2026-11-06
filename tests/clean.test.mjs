// 耳コピ結果の整形（clean.js）のテスト。
import test from "node:test";
import assert from "node:assert/strict";
import { cleanToGhost, estimateTempo } from "../src/core/clean.js";

// 120 BPM の16分音符の格子に、Cメジャーの音階を1拍ごとに置いた「生の耳コピ結果」を作る
function rawAt(bpm, { start = 2.5, n = 24, jitter = 0 } = {}) {
  const step = 60 / bpm / 4;
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  return Array.from({ length: n }, (_, i) => ({
    startTimeSeconds: start + i * 4 * step + (i % 2 ? jitter : -jitter),
    durationSeconds: step * 3,
    pitchMidi: scale[i % scale.length],
    amplitude: 0.8,
  }));
}

test("指定どおりのテンポなら、拍ごとの音が4ステップ間隔に並ぶ", () => {
  const r = cleanToGhost(rawAt(120), { bpm: 120, root: "C", role: "lead", bars: 4 });
  assert.equal(r.sourceBpm, 120);
  const steps = r.notes.map((n) => n.step);
  assert.ok(steps.length >= 12, `音が少なすぎる: ${steps.length}`);
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i] - steps[i - 1], 4);
});

test("演奏が指定より3%速いとき、テンポを推定して格子に合わせる", () => {
  const raw = rawAt(123.6, { n: 40 });
  const t = estimateTempo(raw, 120);
  assert.ok(Math.abs(t.bpm - 123.6) < 1, `推定 ${t.bpm}`);
  const r = cleanToGhost(raw, { bpm: 120, root: "C", role: "lead", bars: 4 });
  const steps = r.notes.map((n) => n.step);
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i] - steps[i - 1], 4);
});

test("同じステップの和音は、リードなら一番高い音、ベースなら一番低い音を残す", () => {
  const base = rawAt(120, { n: 8 });
  const chord = base.flatMap((n) => [n, { ...n, pitchMidi: n.pitchMidi - 12 }, { ...n, pitchMidi: n.pitchMidi + 4 }]);
  const lead = cleanToGhost(chord, { bpm: 120, root: "C", role: "lead", bars: 4, sourceBpm: 120 });
  const bass = cleanToGhost(chord, { bpm: 120, root: "C", role: "bass", bars: 4, sourceBpm: 120 });
  assert.equal(new Set(lead.notes.map((n) => n.step)).size, lead.notes.length, "リードが単音になっていない");
  assert.equal(new Set(bass.notes.map((n) => n.step)).size, bass.notes.length, "ベースが単音になっていない");
  assert.ok(lead.notes[0].pitch > bass.notes[0].pitch);
});

test("スケール外の音は近いスケール音に寄せる", () => {
  const raw = rawAt(120, { n: 8 }).map((n) => ({ ...n, pitchMidi: 61 })); // C#
  const r = cleanToGhost(raw, { bpm: 120, root: "C", role: "lead", bars: 4, sourceBpm: 120 });
  for (const n of r.notes) assert.ok([0, 2].includes(n.pitch % 12), `C# が ${n.pitch} になった`);
});
