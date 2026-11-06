// ドラムの耳コピ（drums.js）のテスト。合成した音で検出の精度を確かめる。GLM-5.3 が書いたものを取り込んだ。
import test from "node:test";
import assert from "node:assert/strict";
import { transcribeDrums } from "../src/core/drums.js";

// ---- ドラム耳コピ: 合成音 ----

/** テスト用のドラム音源。キック=減衰する60Hzサイン、スネア=減衰する白色ノイズ、ハイハット=6.5kHzハイパス通したノイズクリック */
function synthDrums({ sr = 22050, bpm = 120, startSec = 0.5, bars = 4, seed = 1 } = {}) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const stepSec = 60 / bpm / 4;
  const steps = bars * 16;
  const x = new Float32Array(Math.ceil((startSec + steps * stepSec + 0.5) * sr));
  const add = (t0, dur, fn) => {
    const i0 = Math.round(t0 * sr), n = Math.round(dur * sr);
    for (let k = 0; k < n && i0 + k < x.length; k++) x[i0 + k] += fn(k / sr, rnd());
  };
  // ハイハットだけは先にトラックを作ってからハイパスに通す（RBJ cookbook、2段）
  const hats = new Float32Array(x.length);
  const put = (t0, dur, fn) => {
    const i0 = Math.round(t0 * sr), n = Math.round(dur * sr);
    for (let k = 0; k < n && i0 + k < hats.length; k++) hats[i0 + k] += fn(k / sr, rnd());
  };
  for (let st = 0; st < steps; st++) {
    const t0 = startSec + st * stepSec;
    if (st % 4 === 0) add(t0, 0.3, (t) => 0.8 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.1));
    if (st % 16 === 4 || st % 16 === 12) add(t0, 0.25, (t, r) => 0.5 * r * Math.exp(-t / 0.05));
    if (st % 2 === 0) put(t0, 0.05, (t, r) => 0.8 * r * Math.exp(-t / 0.012));
  }
  const hp = highpass(sr, 6500);
  const hatsHp = hp(hp(hats));
  for (let i = 0; i < x.length; i++) x[i] += hatsHp[i];
  return x;
}

/** テスト用の簡単なハイパス（RBJ cookbook を2段適用する関数を返す） */
function highpass(sr, f0) {
  const w = (2 * Math.PI * f0) / sr, alpha = Math.sin(w) / (2 * 0.707), cos = Math.cos(w);
  const a0 = 1 + alpha;
  const co = { b0: ((1 + cos) / 2) / a0, b1: (-(1 + cos)) / a0, b2: ((1 + cos) / 2) / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
  return (x) => {
    const y = new Float32Array(x.length);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      y[i] = co.b0 * x[i] + s1;
      s1 = co.b1 * x[i] - co.a1 * y[i] + s2;
      s2 = co.b2 * x[i] - co.a2 * y[i];
    }
    return y;
  };
}

function precisionRecall(detected, truth) {
  const setT = new Set(truth);
  const hit = detected.filter((s) => setT.has(s)).length;
  return {
    precision: detected.length ? hit / detected.length : 1,
    recall: truth.length ? hit / truth.length : 1,
  };
}

test("drums: 合成した4小節のキック／スネア／ハイハットを精度0.9以上で拾える", () => {
  const sr = 22050, bpm = 120, bars = 4;
  const x = synthDrums({ sr, bpm, startSec: 0.5, bars });
  const notes = transcribeDrums(x, sr, { bpm, startSec: 0.5, bars });

  const truth = {
    kick: [], snare: [], hat: [],
  };
  for (let st = 0; st < bars * 16; st++) {
    if (st % 4 === 0) truth.kick.push(st);
    if (st % 16 === 4 || st % 16 === 12) truth.snare.push(st);
    if (st % 2 === 0) truth.hat.push(st);
  }
  const byPitch = { 36: "kick", 38: "snare", 42: "hat" };
  for (const [pitch, name] of Object.entries(byPitch)) {
    const det = notes.filter((n) => n.pitch === Number(pitch)).map((n) => n.step);
    const { precision, recall } = precisionRecall(det, truth[name]);
    assert.ok(precision >= 0.9 && recall >= 0.9, `${name}: precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} det=${det}`);
    // 出力の形の約束
    for (const n of notes.filter((n) => n.pitch === Number(pitch))) {
      assert.equal(n.len, 1);
      assert.ok(n.vel >= 0 && n.vel <= 1);
    }
  }
});

