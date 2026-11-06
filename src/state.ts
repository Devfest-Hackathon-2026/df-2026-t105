export type Note = { step: number; len: number; pitch: number; vel: number };
export type TrackId = "drums" | "bass" | "lead";
export type Ghost = {
  notes: Note[];
  /** 2小節後にも同じ音が出ていれば高い（0〜1）。耳コピの確からしさの目安 */
  conf: number[];
  /** Lyria の出力全体と、ゴーストの 0 ステップ目に当たる秒数 */
  full: AudioBuffer;
  startSec: number;
  /** basic-pitch の生の出力。整形の強さを変えて作り直すときに使う */
  raw: { startTimeSeconds: number; durationSeconds: number; pitchMidi: number; amplitude: number }[];
  ampRatio: number;
  spec: LyriaSpec;
  intent: string;
  explanation: string;
  logIndex: number;
};
export type Track = { id: TrackId; name: string; notes: Note[]; mute: boolean; ghost: Ghost | null };
export type LyriaSpec = {
  prompts: { text: string; weight: number }[];
  density: number;
  brightness: number;
  guidance: number;
  rationale: string;
};
export type LogEntry = {
  at: string;
  track: TrackId;
  intent: string;
  spec: LyriaSpec;
  proposed: number;
  accepted: number;
  reason: string;
};
export type Project = {
  bpm: number;
  root: string;
  bars: number;
  tracks: Record<TrackId, Track>;
  log: LogEntry[];
};

export const STEPS_PER_BAR = 16;
export const DRUM_ROWS = [
  { pitch: 42, name: "Hat" },
  { pitch: 38, name: "Snare" },
  { pitch: 36, name: "Kick" },
];
export const RANGE: Record<TrackId, [number, number]> = {
  drums: [36, 42],
  bass: [28, 52],
  lead: [57, 84],
};

export function demoProject(): Project {
  const drums: Note[] = [];
  for (let s = 0; s < 64; s++) {
    if (s % 4 === 0) drums.push({ step: s, len: 1, pitch: 36, vel: 0.9 });
    if (s % 8 === 4) drums.push({ step: s, len: 1, pitch: 38, vel: 0.8 });
    if (s % 2 === 0) drums.push({ step: s, len: 1, pitch: 42, vel: s % 4 === 2 ? 0.6 : 0.35 });
  }
  // Am - F - C - G のルート
  const roots = [45, 41, 36, 43];
  const bass: Note[] = [];
  roots.forEach((r, bar) => {
    const p = r < 40 ? r + 12 : r;
    bass.push({ step: bar * 16, len: 3, pitch: p - 12, vel: 0.9 });
    bass.push({ step: bar * 16 + 6, len: 2, pitch: p - 12, vel: 0.7 });
    bass.push({ step: bar * 16 + 10, len: 2, pitch: p, vel: 0.7 });
    bass.push({ step: bar * 16 + 14, len: 2, pitch: p - 12, vel: 0.6 });
  });
  return {
    bpm: 100,
    root: "C",
    bars: 4,
    tracks: {
      drums: { id: "drums", name: "Drums", notes: drums, mute: false, ghost: null },
      bass: { id: "bass", name: "Bass", notes: bass, mute: false, ghost: null },
      lead: { id: "lead", name: "Lead", notes: [], mute: false, ghost: null },
    },
    log: [],
  };
}

const KEY = "ghostnotes.project.v1";
export function save(p: Project) {
  try {
    const plain = {
      ...p,
      tracks: Object.fromEntries(
        Object.entries(p.tracks).map(([k, t]) => [k, { ...t, ghost: null }]),
      ),
    };
    localStorage.setItem(KEY, JSON.stringify(plain));
  } catch {}
}
export function load(): Project | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Project) : null;
  } catch {
    return null;
  }
}

export function describeTrack(p: Project, id: TrackId): string {
  const t = p.tracks[id];
  if (!t.notes.length) return `${t.name}: (empty)`;
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const n = [...t.notes].sort((a, b) => a.step - b.step);
  if (id === "drums") {
    const row = (pitch: number) =>
      n.filter((x) => x.pitch === pitch && x.step < 16).map((x) => x.step).join(",");
    return `Drums (bar 1 steps, 16th grid): kick[${row(36)}] snare[${row(38)}] hat[${row(42)}]`;
  }
  return `${t.name}: ` + n.map((x) => `${x.step}:${names[x.pitch % 12]}${Math.floor(x.pitch / 12) - 1}x${x.len}`).join(" ");
}
