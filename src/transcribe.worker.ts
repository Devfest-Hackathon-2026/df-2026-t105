import "./worker-shim";
import * as tf from "@tensorflow/tfjs";
import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";

let bp: BasicPitch | null = null;
// 要求は届いた順に1つずつ処理する（モデルを同時に2回走らせない）
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<{ id: number; mono: Float32Array; modelUrl: string }>) => {
  const { id, mono, modelUrl } = e.data;
  queue = queue.then(async () => {
    try {
      bp ??= new BasicPitch(modelUrl);
      const frames: number[][] = [], onsets: number[][] = [], contours: number[][] = [];
      const evaluate = () => bp!.evaluateModel(
        mono,
        (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
        (p) => self.postMessage({ id, type: "progress", p }),
      );
      try {
        await evaluate();
      } catch (err) {
        // GPU／ドライバーによってシェーダーをコンパイルできない場合は，
        // 同じ音声をCPUで再処理する．途中まで得た結果は重複させない．
        if (tf.getBackend() !== "webgl" || !/shader|webgl|glsl|context lost/i.test(String((err as Error)?.message ?? err))) throw err;
        if (!await tf.setBackend("cpu")) throw err;
        await tf.ready();
        frames.length = onsets.length = contours.length = 0;
        self.postMessage({ id, type: "progress", p: 0 });
        await evaluate();
      }
      const notes = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.5, 0.3, 11)));
      notes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
      self.postMessage({
        id,
        type: "done",
        notes: notes.map(({ startTimeSeconds, durationSeconds, pitchMidi, amplitude }) => ({ startTimeSeconds, durationSeconds, pitchMidi, amplitude })),
      });
    } catch (err) {
      self.postMessage({ id, type: "error", message: String((err as Error)?.message ?? err) });
    }
  });
};
