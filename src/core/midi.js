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
      ev.push([tick(n.step + Math.max(1, n.len)), 0, [0x80 | ch, pitch, 0x40]]);
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
