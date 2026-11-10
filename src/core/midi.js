// ゴーストノートを Standard MIDI File (SMF) として書き出す。
// ブラウザとスクリプトの両方から読むので、依存のない素の ESM で書く。

/** @param {number} n */
function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

/** @param {number} n */
function u24(n) {
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** @param {number} n */
function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** デルタタイム etc. 用の可変長数（最大 0x0FFFFFFF） @param {number} n */
function vlq(n) {
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return bytes;
}

/** @param {string} s */
const ascii = (s) => [...new TextEncoder().encode(s)];

const strBytes = (s) => [...s].map((c) => c.charCodeAt(0));

/**
 * トラック列を format 1 の SMF バイト列にする。1 ステップ = 16分音符 = ppq/4 ティック。
 * 先頭トラックはテンポと拍子だけのコンダクトトラック。
 * @param {Array<{name:string, channel:number, port?:number, program?:number, notes:Array<{step:number,len:number,pitch:number,vel:number}>}>} tracks
 * @param {{bpm:number, ppq?:number}} o
 * @returns {Uint8Array}
 */
export function toMidiFile(tracks, { bpm, ppq = 480 }) {
  const tick = (step) => Math.round((step * ppq) / 4);
  const usPerQuarter = Math.round(60000000 / bpm);

  // コンダクトトラック: テンポ + 4/4 拍子 + 終端
  const conduct = [
    ...vlq(0), 0xff, 0x51, 0x03, ...u24(usPerQuarter),
    ...vlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];

  const chunks = [conduct];
  for (const tr of tracks) {
    const ch = tr.channel & 0x0f;
    /** @type {Array<[number, number, number[]]>} */ // [tick, offが先=0/on=1, データ]
    const ev = [[0, 0, [0xff, 0x03, ...vlq(ascii(tr.name).length), ...ascii(tr.name)]]];
    if (tr.port) ev.push([0, 0, [0xff, 0x21, 1, tr.port & 0x7f]]);
    if (tr.program !== undefined) ev.push([0, 0, [0xc0 | ch, tr.program & 0x7f]]);
    for (const n of tr.notes) {
      const vel = Math.max(1, Math.min(127, Math.round(n.vel * 127)));
      const pitch = n.pitch & 0x7f;
      ev.push([tick(n.step), 1, [0x90 | ch, pitch, vel]]);
      ev.push([Math.max(tick(n.step)+1,tick(n.step + n.len)), 0, [0x80 | ch, pitch, 0x40]]);
    }
    // 同じティックではノートオフを先にする（同じ音の再発音で前の音が鳴りっぱなしにならないように）
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const bytes = [];
    let prev = 0;
    for (const [t, , data] of ev) {
      bytes.push(...vlq(t - prev), ...data);
      prev = t;
    }
    bytes.push(...vlq(0), 0xff, 0x2f, 0x00);
    chunks.push(bytes);
  }

  const out = [
    ...strBytes("MThd"), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(ppq),
  ];
  for (const c of chunks) out.push(...strBytes("MTrk"), ...u32(c.length), ...c);
  return Uint8Array.from(out);
}

/**
 * SMF バイト列をブラウザでダウンロードさせる。呼ぶまで DOM に触らない。
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
export function downloadMidi(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Standard MIDI File (Format 0 / Format 1) を読み込み、BPM とトラック配列に変換する。
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {{ bpm: number, ppq: number, tracks: Array<{ name: string, channel: number, program: number, role: "drums" | "bass" | "lead", notes: Array<{ step: number, len: number, pitch: number, vel: number }> }> }}
 */
export function fromMidiFile(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const str = (i, n) => Array.from(b.subarray(i, i + n)).map((c) => String.fromCharCode(c)).join("");
  const be = (i, n) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = (v * 256) + b[i + k];
    return v;
  };
  if (b.length < 14 || str(0, 4) !== "MThd") throw new Error("有効な MIDI ファイルではありません");
  const headLen = be(4, 4);
  const division = be(12, 2);
  const ppq = division & 0x8000 ? 480 : Math.max(1, division);
  let bpm = 120;
  const roundStep = (s) => Math.round(s * 960) / 960;
  const toStep = (tick) => roundStep((tick * 4) / ppq);

  const parsedTracks = [];
  let offset = 8 + headLen;
  const dec = new TextDecoder();
  while (offset + 8 <= b.length) {
    const chunkId = str(offset, 4);
    const chunkLen = be(offset + 4, 4);
    const end = Math.min(b.length, offset + 8 + chunkLen);
    if (chunkId === "MTrk") {
      let j = offset + 8;
      let tick = 0;
      let runningStatus = 0;
      let trackName = "";
      /** @type {Map<number, { program: number, active: Map<number, { tick: number, vel: number }[]>, notes: { step: number, len: number, pitch: number, vel: number }[] }>} */
      const byChan = new Map();
      const getChan = (ch) => {
        if (!byChan.has(ch)) byChan.set(ch, { program: 0, active: new Map(), notes: [] });
        return byChan.get(ch);
      };

      while (j < end) {
        let delta = 0;
        while (j < end) {
          const by = b[j++];
          delta = (delta << 7) | (by & 0x7f);
          if (!(by & 0x80)) break;
        }
        tick += delta;
        if (j >= end) break;
        let st = b[j];
        if (st < 0x80) {
          st = runningStatus;
        } else {
          j++;
          if (st < 0xf0) runningStatus = st;
        }
        if (st === 0xff) {
          const metaType = b[j++];
          let len = 0;
          while (j < end) {
            const by = b[j++];
            len = (len << 7) | (by & 0x7f);
            if (!(by & 0x80)) break;
          }
          const data = b.subarray(j, j + len);
          j += len;
          if (metaType === 0x51 && data.length === 3) {
            const us = (data[0] << 16) | (data[1] << 8) | data[2];
            if (us > 0) bpm = Math.max(40, Math.min(240, Math.round(60000000 / us)));
          } else if (metaType === 0x03 && data.length > 0 && !trackName) {
            trackName = dec.decode(data).trim();
          }
        } else if (st === 0xf0 || st === 0xf7) {
          let len = 0;
          while (j < end) {
            const by = b[j++];
            len = (len << 7) | (by & 0x7f);
            if (!(by & 0x80)) break;
          }
          j += len;
        } else {
          const type = st & 0xf0;
          const ch = st & 0x0f;
          const d1 = b[j++] ?? 0;
          const d2 = (type === 0xc0 || type === 0xd0) ? 0 : (b[j++] ?? 0);
          const cObj = getChan(ch);
          if (type === 0xc0) {
            cObj.program = d1 & 0x7f;
          } else if (type === 0x90 && d2 > 0) {
            const stack = cObj.active.get(d1) ?? [];
            stack.push({ tick, vel: Math.max(0.05, Math.min(1, Math.round((d2 / 127) * 100) / 100)) });
            cObj.active.set(d1, stack);
          } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
            const stack = cObj.active.get(d1);
            if (stack && stack.length) {
              const start = stack.shift();
              const step = toStep(start.tick);
              const len = Math.max(roundStep(1 / 8), roundStep(toStep(tick) - step));
              cObj.notes.push({ step, len, pitch: d1 & 0x7f, vel: start.vel });
            }
          }
        }
      }
      for (const [ch, cObj] of byChan.entries()) {
        if (!cObj.notes.length) continue;
        const isDrums = ch === 9;
        const prog = cObj.program;
        const isBass = !isDrums && ((prog >= 32 && prog <= 39) || prog === 43 || prog === 58);
        const role = isDrums ? "drums" : isBass ? "bass" : "lead";
        parsedTracks.push({
          name: trackName || (isDrums ? "ドラム" : `Track ${parsedTracks.length + 1}`),
          channel: ch,
          program: isDrums ? 0 : prog,
          role,
          notes: cObj.notes.sort((a, b2) => a.step - b2.step || a.pitch - b2.pitch),
        });
      }
    }
    offset = end;
  }
  return { bpm, ppq, tracks: parsedTracks };
}
