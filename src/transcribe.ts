export type RawNote = { startTimeSeconds: number; durationSeconds: number; pitchMidi: number; amplitude: number };

type Pending = { resolve: (n: RawNote[]) => void; reject: (e: Error) => void; onProgress: (p: number) => void };
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.type === "progress") p.onProgress(e.data.p);
    else {
      pending.delete(e.data.id);
      if (e.data.type === "done") p.resolve(e.data.notes);
      else p.reject(new Error(`耳コピに失敗しました: ${e.data.message}`));
    }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`耳コピに失敗しました: ${e.message}`));
    pending.clear();
  };
  return worker;
}

function run(mono: Float32Array, onProgress: (p: number) => void): Promise<RawNote[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage(
      { id, mono, modelUrl: new URL(`${import.meta.env.BASE_URL}model/model.json`, location.href).href },
      [mono.buffer],
    );
  });
}

/** AudioBuffer を 22.05kHz モノラルにして、Web Worker の basic-pitch に通す（画面を止めないため） */
export async function transcribe(buf: AudioBuffer, onProgress: (p: number) => void): Promise<RawNote[]> {
  const sr = 22050;
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * sr), sr);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0).slice();
  return run(mono, onProgress);
}

/**
 * モデルの読み込みと初回の計算（GPU のシェーダーの準備など）を、ページを開いた直後に済ませておく。
 * 初回の耳コピだけ十数秒余計にかかるのを、利用者が待たずに済むようにするため。
 */
export function warmUp(): Promise<void> {
  return run(new Float32Array(22050), () => {}).then(() => {}, () => {});
}
