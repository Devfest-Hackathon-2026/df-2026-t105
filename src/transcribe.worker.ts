import "./worker-shim";
import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";

let bp: BasicPitch | null = null;

self.onmessage = async (e: MessageEvent<{ mono: Float32Array; modelUrl: string }>) => {
  try {
    bp ??= new BasicPitch(e.data.modelUrl);
    const frames: number[][] = [], onsets: number[][] = [], contours: number[][] = [];
    await bp.evaluateModel(
      e.data.mono,
      (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
      (p) => self.postMessage({ type: "progress", p }),
    );
    const notes = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.5, 0.3, 11)));
    notes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    self.postMessage({ type: "done", notes: notes.map(({ startTimeSeconds, durationSeconds, pitchMidi, amplitude }) => ({ startTimeSeconds, durationSeconds, pitchMidi, amplitude })) });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err as Error)?.message ?? err) });
  }
};
