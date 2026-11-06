export type RawNote = { startTimeSeconds: number; durationSeconds: number; pitchMidi: number; amplitude: number };

let worker: Worker | null = null;

/** AudioBuffer を 22.05kHz モノラルにして、Web Worker の basic-pitch に通す（画面を止めないため） */
export async function transcribe(buf: AudioBuffer, onProgress: (p: number) => void): Promise<RawNote[]> {
  const sr = 22050;
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * sr), sr);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0).slice();

  worker ??= new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      if (e.data.type === "progress") onProgress(e.data.p);
      else if (e.data.type === "done") resolve(e.data.notes);
      else reject(new Error(`耳コピに失敗しました: ${e.data.message}`));
    };
    w.onerror = (e) => reject(new Error(`耳コピに失敗しました: ${e.message}`));
    w.postMessage({ mono, modelUrl: new URL(`${import.meta.env.BASE_URL}model/model.json`, location.href).href }, [mono.buffer]);
  });
}
