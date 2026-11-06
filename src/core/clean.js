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
export function estimateTempo(notes, bpm, range = 0.08) {
  const score = (b) => {
    const r = findGridPhase(notes, b);
    return { bpm: b, phase: r.phase, errRatio: r.err / (60 / b / 4) };
  };
  const nominal = score(bpm);
  let best = nominal;
  for (let k = 1 - range; k <= 1 + range + 1e-4; k += 0.005) {
    const c = score(bpm * k);
    if (c.errRatio < best.errRatio) best = c;
  }
  const chosen = best.errRatio < nominal.errRatio * 0.8 ? best : nominal;
  return { ...chosen, nominalErrRatio: nominal.errRatio };
}

// Krumhansl-Kessler の調性プロファイル（主音からの音程ごとの重み）
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * ノート列のキーを推定する。音名ごとの量（長さ×音量）を、24通りの長調・短調のプロファイルとの相関で比べる。
 * root は相対長調の主音（A マイナーなら C）。Lyria 3.5 のように指定したキーを守らない演奏を、曲のキーに移調するために使う。
 * @param {Array<{pitchMidi?:number,pitch?:number,durationSeconds?:number,len?:number,amplitude?:number,vel?:number}>} notes
 * @returns {{ root:number, tonic:number, mode:'major'|'minor', score:number, margin:number }}
 */
export function estimateKey(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) {
    const p = n.pitchMidi ?? n.pitch;
    const w = (n.durationSeconds ?? n.len ?? 1) * (n.amplitude ?? n.vel ?? 1);
    h[((p % 12) + 12) % 12] += w;
  }
  const corr = (a, b) => {
    const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  };
  const cands = [];
  for (let t = 0; t < 12; t++) {
    const rot = (prof) => prof.map((_, i) => prof[(i - t + 12) % 12]);
    cands.push({ tonic: t, mode: "major", root: t, score: corr(h, rot(KK_MAJOR)) });
    cands.push({ tonic: t, mode: "minor", root: (t + 3) % 12, score: corr(h, rot(KK_MINOR)) });
  }
  cands.sort((a, b) => b.score - a.score);
  // 相対調（同じ音の並び）は区別しても移調量が変わらないので、別の root を持つ次点との差を確からしさにする
  const other = cands.find((c) => c.root !== cands[0].root);
  return { ...cands[0], margin: cands[0].score - (other?.score ?? 0) };
}

/** 曲のキー（相対長調の主音）へ移調する半音数（-6〜+5） */
export function transposeAmount(fromRoot, toRoot) {
  return ((((toRoot - fromRoot) % 12) + 12 + 6) % 12) - 6;
}

const ROLE_RANGE = { lead: [57, 84], bass: [28, 52], chords: [48, 79] };

/**
 * @param {Array<{startTimeSeconds:number,durationSeconds:number,pitchMidi:number,amplitude:number}>} raw
 * conform: true のとき（テンポとキーを守らない非リアルタイムのモデル向け）は、キーを推定して曲のキーに移調し、
 * テンポを前後 15% から推定し、音が格子に一番よく乗る4小節を探して使う。
 * @param {{bpm:number, root:string|number, role:'lead'|'bass', startSec?:number, sourceBpm?:number, transpose?:number, conform?:boolean, bars?:number, ampRatio?:number}} o
 * @returns {{notes:Array<{step:number,len:number,pitch:number,vel:number}>, phase:number, startSec:number, sourceBpm:number, transpose:number, detectedKey:object|null, dropped:object}}
 */
export function cleanToGhost(rawIn, o) {
  // 移調: 指定があればその量、conform なら推定したキーから決める
  let detectedKey = null;
  let transpose = o.transpose ?? 0;
  if (o.transpose === undefined && o.conform && rawIn.length) {
    detectedKey = estimateKey(rawIn);
    const target = typeof o.root === "number" ? o.root : NOTE_NAMES.indexOf(o.root);
    transpose = transposeAmount(detectedKey.root, target);
  }
  const raw = transpose ? rawIn.map((n) => ({ ...n, pitchMidi: n.pitchMidi + transpose })) : rawIn;
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
  const tempo = o.sourceBpm
    ? { bpm: o.sourceBpm, phase: findGridPhase(loud, o.sourceBpm).phase }
    : estimateTempo(loud, o.bpm, o.conform ? 0.15 : 0.08);
  const sourceBpm = tempo.bpm;
  const step = 60 / sourceBpm / 4;
  const phase = tempo.phase;
  // 窓の開始: 指定がなければ、最初の 2 秒（立ち上がりの不安定な部分）を飛ばした最初の小節頭
  const barSec = step * 16;
  let start0 = o.startSec ?? phase + Math.ceil((2 - phase) / barSec) * barSec;
  if (o.startSec === undefined && o.conform) start0 = bestWindowStart(loud, step, phase, barSec, steps) ?? start0;

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
  return { notes: out, phase, startSec: start0, sourceBpm, transpose, detectedKey, dropped };
}

/**
 * 長い演奏の中から、使う4小節の開始位置を選ぶ。小節頭ごとに、窓に入る音の「格子への乗り方」を足し合わせ、
 * 最も大きい窓を選ぶ（イントロの無音や、テンポが揺れる部分を避けるため）。
 */
function bestWindowStart(notes, step, phase, barSec, steps) {
  const end = Math.max(...notes.map((n) => n.startTimeSeconds), 0);
  let best = null, bestScore = -1;
  for (let s0 = phase; s0 + steps * step <= end + step; s0 += barSec) {
    if (s0 < 0.5) continue;
    let score = 0;
    for (const n of notes) {
      const x = (n.startTimeSeconds - s0) / step;
      if (x < -0.5 || x >= steps - 0.5) continue;
      const off = Math.abs(x - Math.round(x));
      score += Math.max(0, 1 - 2.5 * off) * (n.amplitude ?? 1);
    }
    if (score > bestScore) { bestScore = score; best = s0; }
  }
  return best;
}
