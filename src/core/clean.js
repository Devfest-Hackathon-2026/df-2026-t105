// basic-pitch が出した生のノート列を、DAW のゴーストノートとして使える形に整える。
// ブラウザとスクリプトの両方から読むので、依存のない素の ESM で書く。

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

export function scalePitchClasses(root) {
  const r = typeof root === "number" ? root : NOTE_NAMES.indexOf(root);
  return MAJOR.map((d) => (d + r) % 12);
}

/** 16分音符の格子に対する最適な位相（秒）を探す */
export function findGridPhase(notes, bpm) {
  const step = 60 / bpm / 4;
  let best = { phase: 0, err: Infinity };
  const w = notes.map((n) => n.amplitude ?? 1);
  for (let p = 0; p < step; p += 0.001) {
    let e = 0, ws = 0;
    notes.forEach((n, i) => {
      const x = (((n.startTimeSeconds - p) % step) + step) % step;
      e += Math.min(x, step - x) * w[i]; ws += w[i];
    });
    e /= Math.max(ws, 1e-9);
    if (e < best.err) best = { phase: p, err: e };
  }
  return best;
}

const ROLE_RANGE = { lead: [57, 84], bass: [28, 52], chords: [48, 79] };

/**
 * @param {Array<{startTimeSeconds:number,durationSeconds:number,pitchMidi:number,amplitude:number}>} raw
 * @param {{bpm:number, root:string|number, role:'lead'|'bass', startSec?:number, bars?:number, ampRatio?:number}} o
 * @returns {{notes:Array<{step:number,len:number,pitch:number,vel:number}>, phase:number, dropped:object}}
 */
export function cleanToGhost(raw, o) {
  const step = 60 / o.bpm / 4;
  const bars = o.bars ?? 4;
  const steps = bars * 16;
  const pcs = scalePitchClasses(o.root);
  const [lo, hi] = ROLE_RANGE[o.role] ?? ROLE_RANGE.lead;
  const dropped = { quiet: 0, overlap: 0, outOfWindow: 0, snapped: 0 };

  const maxAmp = Math.max(...raw.map((n) => n.amplitude), 1e-9);
  const loud = raw.filter((n) => {
    const ok = n.amplitude >= maxAmp * (o.ampRatio ?? 0.35);
    if (!ok) dropped.quiet++;
    return ok;
  });

  const { phase } = findGridPhase(loud, o.bpm);
  // 窓の開始: 指定がなければ、最初の 2 秒（立ち上がりの不安定な部分）を飛ばした最初の小節頭
  const barSec = step * 16;
  const start0 = o.startSec ?? phase + Math.ceil((2 - phase) / barSec) * barSec;

  /** @type {Map<number, any[]>} */
  const byStep = new Map();
  for (const n of loud) {
    const s = Math.round((n.startTimeSeconds - start0) / step);
    if (s < 0 || s >= steps) { dropped.outOfWindow++; continue; }
    const len = Math.max(1, Math.round(n.durationSeconds / step));
    (byStep.get(s) ?? byStep.set(s, []).get(s)).push({ ...n, s, len });
  }

  const out = [];
  for (const [s, cands] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
    // 単音化: リードは音量の大きいもの、ベースは最も低いもの
    cands.sort(o.role === "bass" ? (a, b) => a.pitchMidi - b.pitchMidi : (a, b) => b.amplitude - a.amplitude);
    dropped.overlap += cands.length - 1;
    const c = cands[0];
    let p = c.pitchMidi;
    while (p < lo) p += 12;
    while (p > hi) p -= 12;
    if (!pcs.includes(((p % 12) + 12) % 12)) {
      // 一番近いスケール音へ寄せる（同じ距離なら下）
      const down = [1, 2].find((d) => pcs.includes((((p - d) % 12) + 12) % 12));
      const up = [1, 2].find((d) => pcs.includes((((p + d) % 12) + 12) % 12));
      p = down !== undefined && (up === undefined || down <= up) ? p - down : p + up;
      dropped.snapped++;
    }
    out.push({ step: s, len: c.len, pitch: p, vel: Math.min(1, c.amplitude / maxAmp) });
  }
  // 単音なので、次の音と重なる長さは切る
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]?.step ?? steps;
    out[i].len = Math.max(1, Math.min(out[i].len, next - out[i].step));
  }
  return { notes: out, phase, startSec: start0, dropped };
}
