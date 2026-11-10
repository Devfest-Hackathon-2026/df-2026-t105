/** AudioBuffer を 16bit PCM の WAV ファイルのバイト列にする */
export function encodeWav(buf: AudioBuffer): Uint8Array<ArrayBuffer> {
  const n = buf.length, ch = buf.numberOfChannels, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(data[c][i] * 32767))), true);
  return new Uint8Array(out.buffer);
}

/** バイト列をファイルとして保存させる */
export function downloadBytes(bytes: Uint8Array<ArrayBuffer>, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** モノラルの音声（Float32Array）を 16bit PCM の WAV にする */
export function encodeMonoWav(mono: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const n = mono.length;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) out.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(mono[i] * 32767))), true);
  return new Uint8Array(out.buffer);
}
