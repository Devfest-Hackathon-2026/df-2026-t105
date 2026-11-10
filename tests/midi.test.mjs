// MIDI 書き出しのテスト（GLM-5.3 が書いたものを取り込んだ）。node:test で動く。
// 実行: npm run test:core / node --test tests/

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fromMidiFile, toMidiFile } from "../src/core/midi.js";


const root = fileURLToPath(new URL("..", import.meta.url));

// ---- SMF の最小パーサ（書き出し側はランニングステータスを使わない前提） ----

function parseSmf(b) {
  const s = (i, n) => Array.from(b.subarray(i, i + n)).map((c) => String.fromCharCode(c)).join("");
  const be = (i, n) => Array.from(b.subarray(i, i + n)).reduce((a, c) => (a << 8) | c, 0);
  const head = { id: s(0, 4), len: be(4, 4), format: be(8, 2), ntrks: be(10, 2), division: be(12, 2) };
  const tracks = [];
  let i = 14;
  while (i < b.length) {
    const id = s(i, 4);
    const end = i + 8 + be(i + 4, 4);
    let j = i + 8, tick = 0;
    const events = [];
    while (j < end) {
      let d = 0;
      for (;;) { const by = b[j++]; d = (d << 7) | (by & 0x7f); if (!(by & 0x80)) break; }
      tick += d;
      const st = b[j++];
      if (st === 0xff) {
        const type = b[j++];
        let l = 0;
        for (;;) { const by = b[j++]; l = (l << 7) | (by & 0x7f); if (!(by & 0x80)) break; }
        events.push({ tick, meta: type, data: Array.from(b.subarray(j, j + l)) });
        j += l;
      } else {
        const nb = (st & 0xf0) === 0xc0 || (st & 0xf0) === 0xd0 ? 1 : 2;
        events.push({ tick, status: st, data: Array.from(b.subarray(j, j + nb)) });
        j += nb;
      }
    }
    tracks.push({ id, events });
    i = end;
  }
  return { head, tracks };
}

test("midi: 3音のトラックを format 1 で書き出せる", () => {
  const notes = [
    { step: 0, len: 4, pitch: 60, vel: 0.8 }, // ノートオフ(step 4)が次のノートオンと同ティック
    { step: 4, len: 2, pitch: 62, vel: 0.5 },
    { step: 8, len: 4, pitch: 67, vel: 1 },
  ];
  const bytes = toMidiFile([{ name: "lead", channel: 0, program: 73, notes }], { bpm: 120 });
  const { head, tracks } = parseSmf(bytes);

  assert.equal(head.id, "MThd");
  assert.equal(head.len, 6);
  assert.equal(head.format, 1);
  assert.equal(head.ntrks, 2); // コンダクトトラック + 入力1トラック
  assert.equal(head.division, 480);
  assert.deepEqual(tracks.map((t) => t.id), ["MTrk", "MTrk"]);

  // トラック0: テンポ 120bpm = 500000us、4/4、終端
  const metas = tracks[0].events.filter((e) => e.meta !== undefined);
  assert.deepEqual(metas.find((e) => e.meta === 0x51).data, [0x07, 0xa1, 0x20]);
  assert.deepEqual(metas.find((e) => e.meta === 0x58).data, [4, 2, 24, 8]);
  assert.ok(metas.some((e) => e.meta === 0x2f));

  // トラック1: 名前・プログラムチェンジ・ノート数
  const ev = tracks[1].events;
  const name = ev.find((e) => e.meta === 0x03);
  assert.equal(name.data.map((c) => String.fromCharCode(c)).join(""), "lead");
  const pc = ev.find((e) => (e.status & 0xf0) === 0xc0);
  assert.equal(pc.status, 0xc0);
  assert.equal(pc.data[0], 73);
  const noteOns = ev.filter((e) => (e.status & 0xf0) === 0x90);
  const noteOffs = ev.filter((e) => (e.status & 0xf0) === 0x80);
  assert.equal(noteOns.length, 3);
  assert.equal(noteOffs.length, 3);
  // ノートオンは 16分 = 120 ティック刻み、ベロシティは clamp(round(vel*127),1,127)
  assert.deepEqual(noteOns.map((e) => e.tick), [0, 480, 960]);
  assert.deepEqual(noteOns.map((e) => e.data[1]), [102, 64, 127]);
  // 同じティックではノートオフが先
  const at480 = ev.filter((e) => e.tick === 480);
  assert.equal((at480[0].status & 0xf0), 0x80);
});

// ---- ドラム耳コピ: 合成音 ----

/** テスト用のドラム音源。キック=減衰する60Hzサイン、スネア=減衰する白色ノイズ、ハイハット=高域強調のノイズクリック */
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
  for (let st = 0; st < steps; st++) {
    const t0 = startSec + st * stepSec;
    if (st % 4 === 0) add(t0, 0.3, (t) => 0.8 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.1));
    if (st % 16 === 4 || st % 16 === 12) add(t0, 0.25, (t, r) => 0.5 * r * Math.exp(-t / 0.05));
    if (st % 2 === 0) {
      // 隣接差分で高域を強調したノイズクリック
      let prev = 0;
      add(t0, 0.05, (t, r) => { const v = 0.4 * (r - prev) * Math.exp(-t / 0.012); prev = r; return v; });
    }
  }
  return x;
}

function precisionRecall(detected, truth) {
  const setT = new Set(truth);
  const hit = detected.filter((s) => setT.has(s)).length;
  return {
    precision: detected.length ? hit / detected.length : 1,
    recall: truth.length ? hit / truth.length : 1,
  };
}


test('midi: short snare rolls and triplets keep their timing and duration',()=>{
 const notes=[0,.25,.5,.75,4/3].map(step=>({step,len:.125,pitch:38,vel:.8}));
 const parsed=parseSmf(toMidiFile([{name:'Snare roll',channel:9,notes}],{bpm:120}));
 const on=parsed.tracks[1].events.filter(e=>e.status===0x99),off=parsed.tracks[1].events.filter(e=>e.status===0x89);
 assert.deepEqual(on.map(e=>e.tick),[0,30,60,90,160]);assert.deepEqual(off.map(e=>e.tick),[15,45,75,105,175]);
});

test('midi: fromMidiFile round-trips BPM, drums, bass and lead tracks',()=>{
 const origTracks=[
  {name:'ピアノ',channel:0,program:0,notes:[{step:0,len:4,pitch:60,vel:0.8},{step:4,len:2,pitch:64,vel:0.75}]},
  {name:'エレキベース',channel:1,program:33,notes:[{step:0,len:8,pitch:36,vel:0.9}]},
  {name:'ドラム',channel:9,program:0,notes:[{step:0,len:1,pitch:36,vel:0.95},{step:4,len:1,pitch:38,vel:0.85}]},
 ];
 const bytes=toMidiFile(origTracks,{bpm:128});
 const imported=fromMidiFile(bytes);
 assert.equal(imported.bpm,128);
 assert.equal(imported.tracks.length,3);
 assert.equal(imported.tracks[0].name,'ピアノ');
 assert.equal(imported.tracks[0].role,'lead');
 assert.equal(imported.tracks[0].notes.length,2);
 assert.equal(imported.tracks[1].role,'bass');
 assert.equal(imported.tracks[1].program,33);
 assert.equal(imported.tracks[2].role,'drums');
 assert.equal(imported.tracks[2].channel,9);
});
