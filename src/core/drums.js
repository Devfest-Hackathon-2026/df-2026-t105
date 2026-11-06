// Lyria のドラム専用音声を耳コピして、16分音符の格子に並ぶキック／スネア／ハイハットの位置を拾う。
// FFT は使わない。RBJ cookbook のバイカッドで3帯域に分け、短時間振幅の立ち上がり（正の流れ）を
// 帯域ごとの適応しきい値でピーク拾いし、16分ステップへ量子化する。
// ブラウザとスクリプトの両方から読むので、依存のない素の ESM で書く。

const HOP_SEC = 0.005; // フレーム間隔
const FRAME_SEC = 0.023; // 振幅測定窓の長さ（中心合わせ）

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** RBJ cookbook のバイカッド係数（bandpass は常時 0dB） */
function biquad(type, f0, q, sr) {
  const w = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  let b0, b1, b2;
  if (type === "bandpass") {
    b0 = alpha; b1 = 0; b2 = -alpha;
  } else {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function applyBiquad(x, co) {
  const y = new Float32Array(x.length);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    y[i] = co.b0 * x[i] + s1;
    s1 = co.b1 * x[i] - co.a1 * y[i] + s2;
    s2 = co.b2 * x[i] - co.a2 * y[i];
  }
  return y;
}

// 帯域: キック 40–150Hz、スネア 150–2500Hz（スネアのノイズ成分が主）、ハイハット 6kHz 以上。
// バイカッド1段のすそは 6dB/oct と緩い（キックの60Hzがスネア帯域に届く）ので、3段掛けて分離を上げる。
// スネア帯域にはハイハットの漏れが短いクリックとして届くので、鳴りが少し続くイベントだけを残す
// （sustain = ピーク後 30〜60ms の振幅がピークの何割以上あるか。スネアのノイズは減衰が遅く、クリックは速い）。
const BANDS = [
  { name: "kick", pitch: 36, filters: [["bandpass", 95, 0.85], ["bandpass", 95, 0.85], ["bandpass", 95, 0.85]] },
  { name: "snare", pitch: 38, sustain: 0.45, filters: [["bandpass", 1300, 0.55], ["bandpass", 1300, 0.55], ["bandpass", 1300, 0.55]] },
  { name: "hat", pitch: 42, filters: [["highpass", 6000, 0.7], ["highpass", 6000, 0.7], ["highpass", 6000, 0.7]] },
];

/** 中心合わせ窓でフレームごとの振幅（RMS）を測る */
function frameAmps(x, sr) {
  const hop = Math.max(1, Math.round(HOP_SEC * sr));
  const frame = Math.max(hop * 2, 2 ** Math.round(Math.log2(FRAME_SEC * sr)));
  const n = Math.ceil(x.length / hop) + 1;
  const amps = new Float64Array(n);
  const half = frame / 2;
  for (let i = 0; i < n; i++) {
    const c = i * hop;
    const a = Math.max(0, Math.round(c - half));
    const b = Math.min(x.length, Math.round(c + half));
    let e = 0;
    for (let j = a; j < b; j++) e += x[j] * x[j];
    amps[i] = b > a ? Math.sqrt(e / (b - a)) : 0;
  }
  return { amps, hop, frame };
}

function median(arr, a, b) {
  const s = Array.from(arr.slice(a, b)).sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

/**
 * 振幅列から立ち上がり（正の流れ）のピークをオンセットとして拾う。
 * しきい値は前後 ±0.5s の移動中央値 + 感度で決まる追加項。近傍のピークは強い方だけ残す。
 * 時刻は「中心合わせ窓の流れピークが実際の立ち上がりより半窓分早く出る」分を補正済み。
 */
function pickOnsets(amps, hop, frame, sr, sensitivity, sustainRatio = 0) {
  const n = amps.length;
  const flux = new Float64Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, amps[i] - amps[i - 1]);
  let max = 0;
  for (let i = 0; i < n; i++) if (flux[i] > max) max = flux[i];
  if (max <= 0) return [];
  const add = (0.3 - 0.45 * clamp01(sensitivity)) * max;
  const W = Math.round(0.5 / HOP_SEC);
  const span = Math.max(1, Math.round(0.04 / HOP_SEC));

  const cands = [];
  for (let i = 1; i < n - 1; i++) {
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    if (flux[i] < median(flux, Math.max(0, i - W), Math.min(n, i + W + 1)) * 1.5 + add) continue;
    if (sustainRatio > 0) {
      let peak = 0, tail = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 6); j++) peak = Math.max(peak, amps[j]);
      for (let j = Math.min(n - 1, i + 6); j <= Math.min(n - 1, i + 12); j++) tail = Math.max(tail, amps[j]);
      if (tail < peak * sustainRatio) continue; // 減衰が速すぎるクリック（ハイハットの漏れなど）
    }
    cands.push(i);
  }
  // 強い順に確定し、40ms 以内にある候補は捨てる（非極大抑制）
  cands.sort((a, b) => flux[b] - flux[a]);
  const taken = [];
  for (const i of cands) {
    if (taken.some((j) => Math.abs(j - i) < span)) continue;
    taken.push(i);
  }
  const lag = frame / 2 - hop / 2; // 窓の広がりの分だけピークは早く出る
  return taken.sort((a, b) => a - b).map((i) => {
    let amp = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 6); j++) amp = Math.max(amp, amps[j]);
    return { t: (i * hop + lag) / sr, strength: flux[i], amp };
  });
}

/** @returns {Array<{name:string, pitch:number, onsets:Array<{t:number,strength:number,amp:number}>}>} */
function analyzeBands(mono, sampleRate, sensitivity) {
  return BANDS.map((band) => {
    let y = mono;
    for (const [type, f0, q] of band.filters) y = applyBiquad(y, biquad(type, f0, q, sampleRate));
    const { amps, hop, frame } = frameAmps(y, sampleRate);
    return { name: band.name, pitch: band.pitch, onsets: pickOnsets(amps, hop, frame, sampleRate, sensitivity, band.sustain ?? 0) };
  });
}

/**
 * ドラム音声をキック(36)／スネア(38)／クローズハット(42)の並びに耳コピする。
 * @param {Float32Array} mono モノラル音声
 * @param {number} sampleRate
 * @param {{bpm:number, startSec:number, bars?:number, sensitivity?:number}} o
 * @returns {Array<{step:number, len:number, pitch:number, vel:number}>}
 */
export function transcribeDrums(mono, sampleRate, { bpm, startSec, bars = 4, sensitivity = 0.5 }) {
  const stepSec = 60 / bpm / 4;
  const steps = bars * 16;
  const notes = [];
  for (const band of analyzeBands(mono, sampleRate, sensitivity)) {
    const win = band.onsets.filter((o) => o.t >= startSec - stepSec * 0.5 && o.t < startSec + (steps + 0.5) * stepSec);
    const maxAmp = Math.max(0, ...win.map((o) => o.amp));
    if (maxAmp <= 0) continue;
    // 量子化: 一番近い16分ステップへ。35% ステップ以上離れていたら弾く。1ステップ1発まで。
    const byStep = new Map();
    for (const o of win) {
      const s = Math.round((o.t - startSec) / stepSec);
      if (s < 0 || s >= steps) continue;
      if (Math.abs(o.t - (startSec + s * stepSec)) > 0.35 * stepSec) continue;
      const prev = byStep.get(s);
      if (!prev || o.amp > prev.amp) byStep.set(s, o);
    }
    for (const [s, o] of byStep) {
      notes.push({ step: s, len: 1, pitch: band.pitch, vel: Math.max(0.05, Math.min(1, o.amp / maxAmp)) });
    }
  }
  return notes.sort((a, b) => a.step - b.step || a.pitch - b.pitch);
}

/**
 * キックのオンセットが拍位置に一番よく揃う格子の位相（1ms 刻みで全探索）を探し、
 * 2.0 秒以降で最初の小節頭の位置（秒）を返す。キックは拍に乗ると仮定。
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {number} bpm
 */
export function estimateStartSec(mono, sampleRate, bpm) {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const kicks = analyzeBands(mono, sampleRate, 0.5)[0].onsets;
  let best = { phase: 0, score: -1 };
  for (let p = 0; p < beatSec; p += 0.001) {
    let score = 0;
    for (const o of kicks) {
      const d = (((o.t - p) % beatSec) + beatSec) % beatSec;
      if (Math.min(d, beatSec - d) < 0.015) score += o.strength;
    }
    if (score > best.score) best = { phase: p, score };
  }
  return best.phase + Math.ceil((2 - best.phase) / barSec) * barSec;
}
