export function transcribeDrums(
  mono: Float32Array,
  sampleRate: number,
  o: { bpm: number; startSec: number; bars?: number; sensitivity?: number },
): { step: number; len: number; pitch: number; vel: number }[];
export function estimateStartSec(mono: Float32Array, sampleRate: number, bpm: number): number;
