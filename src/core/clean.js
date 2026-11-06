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

/**
 * Lyria は指定した BPM から数%ずれて演奏することがあるので、実際のテンポを指定値の前後 8% から探す。
 * 候補を増やすほど偶然に格子へ合う候補も出やすくなるため、指定値より 20% 以上よく合うときだけ乗り換える。
 * @returns {{ bpm:number, phase:number, errRatio:number, nominalErrRatio:number }}
 */
export function estimateTempo(notes, bpm) {
  const score = (b) => {
    const r = findGridPhase(notes, b);
    return { bpm: b, phase: r.phase, errRatio: r.err / (60 / b / 4) };
  };
  const nominal = score(bpm);
  let best = nominal;
  for (let k = 0.92; k <= 1.0801; k += 0.005) {
    const c = score(bpm * k);
    if (c.errRatio < best.errRatio) best = c;
  }
  const chosen = best.errRatio < nominal.errRatio * 0.8 ? best : nominal;
  return { ...chosen, nominalErrRatio: nominal.errRatio };
}

const ROLE_RANGE = { lead: [57, 84], bass: [28, 52], chords: [48, 79] };

/**
 * @param {Array<{startTimeSeconds:number,durationSeconds:number,pitchMidi:number,amplitude:number}>} raw
 * @param {{bpm:number, root:string|number, role:'lead'|'bass', startSec?:number, sourceBpm?:number, bars?:number, ampRatio?:number}} o
 * @returns {{notes:Array<{step:number,len:number,pitch:number,vel:number}>, phase:number, startSec:number, sourceBpm:number, dropped:object}}
 */
export function cleanToGhost(raw, o) {
  const bars = o.bars ?? 4;
  const steps = bars * 16;
  const pcs = scalePitchClasses(o.root);
  const [lo, hi] = ROLE_RANGE[o.role] ?? ROLE_RANGE.lead;
  const dropped = { quiet: 0, overlap: 0, outOfWindow: 0, snapped: 0, merged: 0, outOfRange: 0 };

  const maxAmp = Math.max(...raw.map((n) => n.amplitude), 1e-9);
  const loud = raw.filter((n) => {
    const ok = n.amplitude >= maxAmp * (o.ampRatio ?? 0.35);
    if (!ok) dropped.quiet++;
    return ok;
  });

  // 演奏の実際のテンポ（sourceBpm）で格子に合わせる。ステップ数は曲のテンポと共通なので、MIDI はそのまま使える
  const tempo = o.sourceBpm ? { bpm: o.sourceBpm, phase: findGridPhase(loud, o.sourceBpm).phase } : estimateTempo(loud, o.bpm);
  const sourceBpm = tempo.bpm;
  const step = 60 / sourceBpm / 4;
  const phase = tempo.phase;
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

  // 単音化: 同じステップで鳴る音のうち、そのステップで一番大きい音の半分以上の音量があるものに絞り、
  // リードは一番高い音（メロディは上に出ることが多い）、ベースは一番低い音を取る
  const picked = [];
  for (const [s, cands] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
    const top = Math.max(...cands.map((c) => c.amplitude));
    const strong = cands.filter((c) => c.amplitude >= top * 0.5);
    strong.sort(o.role === "bass" ? (a, b) => a.pitchMidi - b.pitchMidi : (a, b) => b.pitchMidi - a.pitchMidi);
    dropped.overlap += cands.length - 1;
    picked.push(strong[0]);
  }
  // 音域合わせ: 1音ずつ折り返すと別のメロディになるので、フレーズ全体をオクターブ単位で動かす
  const sortedP = picked.map((c) => c.pitchMidi).sort((a, b) => a - b);
  const median = sortedP[sortedP.length >> 1] ?? (lo + hi) / 2;
  const shift = 12 * Math.round(((lo + hi) / 2 - median) / 12);

  const out = [];
  for (const c of picked) {
    let p = c.pitchMidi + shift;
    if (p < lo - 12 || p > hi + 12) { dropped.outOfRange = (dropped.outOfRange ?? 0) + 1; continue; }
    while (p < lo) p += 12;
    while (p > hi) p -= 12;
    // 前の音と同じ高さで、前の音がまだ鳴り続けている位置なら、新しい音ではなく伸ばしとみなす
    const prev = out[out.length - 1];
    if (prev && prev.pitch === p && prev.step + prev.len > c.s) {
      prev.len = Math.max(prev.len, c.s + c.len - prev.step);
      dropped.merged = (dropped.merged ?? 0) + 1;
      continue;
    }
    if (!pcs.includes(((p % 12) + 12) % 12)) {
      // 一番近いスケール音へ寄せる（同じ距離なら下）
      const down = [1, 2].find((d) => pcs.includes((((p - d) % 12) + 12) % 12));
      const up = [1, 2].find((d) => pcs.includes((((p + d) % 12) + 12) % 12));
      p = down !== undefined && (up === undefined || down <= up) ? p - down : p + up;
      dropped.snapped++;
    }
    out.push({ step: c.s, len: c.len, pitch: p, vel: Math.min(1, c.amplitude / maxAmp) });
  }
  // 単音なので、次の音と重なる長さは切る
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]?.step ?? steps;
    out[i].len = Math.max(1, Math.min(out[i].len, next - out[i].step));
  }
  return { notes: out, phase, startSec: start0, sourceBpm, dropped };
}
