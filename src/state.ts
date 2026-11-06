export type Note = { step: number; len: number; pitch: number; vel: number };
export type TrackId = "drums" | "bass" | "lead";
export type Ghost = {
  notes: Note[];
  /** 2小節後にも同じ音が出ていれば高い（0〜1）。耳コピの確からしさの目安 */
  conf: number[];
  /** Lyria の出力全体と、ゴーストの 0 ステップ目に当たる秒数 */
  full: AudioBuffer;
  startSec: number;
  /** Lyria が実際に演奏したテンポの推定値（指定した BPM から数%ずれることがある） */
  sourceBpm: number;
  /** 曲のキーに合わせるために移調した半音数（非リアルタイムのモデルのとき） */
  transpose?: number;
  /** 演奏から推定したキー（表示用） */
  detectedKey?: string;
  /** 生成に使ったモデル */
  model?: string;
  /** basic-pitch の生の出力。整形の強さを変えて作り直すときに使う */
  raw: { startTimeSeconds: number; durationSeconds: number; pitchMidi: number; amplitude: number }[];
  /** ドラムのとき、検出をやり直すための 22.05kHz モノラル音声 */
  mono?: Float32Array;
  ampRatio: number;
  spec: LyriaSpec;
  intent: string;
  explanation: string;
  logIndex: number;
  /** 2案のうちどちらか */
  label: string;
  proposed: number;
  accepted: number;
};
export type Track = {
  id: TrackId;
  name: string;
  notes: Note[];
  mute: boolean;
  /** ソロ。どれかのトラックがソロなら、ソロのトラックだけを鳴らす */
  solo?: boolean;
  /** 音量（dB、0 が基準） */
  volume?: number;
  /** 音色（audio.ts の PRESETS の id） */
  preset?: string;
  /** いま表示しているゴースト（alts のどれか） */
  ghost: Ghost | null;
  /** 同じ依頼から作った候補（案A、案B） */
  alts?: Ghost[] | null;
};
export type LyriaSpec = {
  title?: string;
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
  /** どの案から採用したか（"A"、"B"、"A+B"、採用なしなら空） */
  chosen?: string;
  /** 比べた案の名前 */
  titles?: string[];
  /** 生成に使った Lyria のモデル */
  model?: string;
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
        Object.entries(p.tracks).map(([k, t]) => [k, { ...t, ghost: null, alts: null }]),
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

/** Lyria のプロンプトに入れる、既存トラックの内容の説明（英語）。target 以外のトラックだけを述べる */
export function describeForLyria(p: Project, target: TrackId): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const nm = (pitch: number) => `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
  const beat = (step: number) => { const b = (step % 16) / 4 + 1; return Number.isInteger(b) ? String(b) : String(parseFloat(b.toFixed(2))); };
  const dur = (len: number) => { const b = len / 4; return Number.isInteger(b) ? String(b) : String(parseFloat(b.toFixed(2))); };
  const DR: Record<number, string> = { 35: "kick", 36: "kick", 38: "snare", 40: "snare", 42: "closed hat", 44: "pedal hat", 46: "open hat", 49: "crash", 51: "ride" };
  const parts: string[] = [];
  for (const id of ["drums", "bass", "lead"] as TrackId[]) {
    if (id === target) continue;
    const notes = [...p.tracks[id].notes].sort((a, b) => a.step - b.step);
    if (!notes.length) continue;
    const bodies: { bar: number; body: string }[] = [];
    for (let b = 0; b < p.bars; b++) {
      const bar = notes.filter((n) => Math.floor(n.step / 16) === b);
      if (!bar.length) continue;
      if (id === "drums") {
        const groups = new Map<number, number[]>();
        for (const n of bar) (groups.get(n.pitch) ?? groups.set(n.pitch, []).get(n.pitch)!).push(Number(beat(n.step)));
        bodies.push({ bar: b + 1, body: [...groups].map(([p2, bs]) => `${DR[p2] ?? `drum${p2}`}@${bs.join(",")}`).join(" ") });
      } else {
        bodies.push({ bar: b + 1, body: bar.map((n) => `${nm(n.pitch)}(${dur(n.len)}b)`).join(" ") });
      }
    }
    // 同じ小節が続くときはまとめる（ループ曲は同じパターンの繰り返しが多い）
    const bars: string[] = [];
    for (let i = 0; i < bodies.length;) {
      let j = i;
      while (j + 1 < bodies.length && bodies[j + 1].body === bodies[i].body && bodies[j + 1].bar === bodies[j].bar + 1) j++;
      bars.push(j === i ? `bar${bodies[i].bar} ${bodies[i].body}` : `bars${bodies[i].bar}-${bodies[j].bar} ${bodies[i].body}`);
      i = j + 1;
    }
    parts.push(`${id === "drums" ? "drums" : `${id} melody`}: ${bars.join("; ")}`);
  }
  if (!parts.length) return "";
  const unit = target === "drums" ? "hit positions are beat numbers" : "note length is in beats";
  return `The new part plays together with this existing loop (${unit}): ${parts.join("; ")}. Make it fit around them.`;
}
