export type MidiNote = { step: number; len: number; pitch: number; vel: number };
export function toMidiFile(
  tracks: { name: string; channel: number; program?: number; notes: MidiNote[] }[],
  o: { bpm: number; ppq?: number },
): Uint8Array;
export function downloadMidi(bytes: Uint8Array, filename: string): void;
