export type Note = { step: number; len: number; pitch: number; vel: number };
export type TrackRole = "drums" | "bass" | "lead";
export type TrackId = TrackRole | `part:${string}`;
export type Ghost = {
  notes: Note[];
  /** 2小節後にも同じ音が出ていれば高い（0〜1）。耳コピの確からしさの目安 */
  conf: number[];
  polyphonic?: boolean;
  startStep?: number;
  bars?: number;
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
  raw: { startTimeSeconds: number; durationSeconds: number; pitchMidi: number; amplitude: number; instrument?: string }[];
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
  role?: TrackRole;
  instrument?: string;
  polyphonic?: boolean;
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
  tracks: Record<string, Track>;
  log: LogEntry[];
};

/** Content extent for playback/export; the editor itself has no end boundary. */
export function contentBars(p:Project):number {
  let end=0;
  for(const track of Object.values(p.tracks)) {
    for(const n of track.notes)end=Math.max(end,n.step+n.len);
    for(const g of track.alts??(track.ghost?[track.ghost]:[])){
      if(g.bars)end=Math.max(end,(g.startStep??0)+g.bars*16);
      for(const n of g.notes)end=Math.max(end,n.step+n.len);
    }
  }
  return Math.max(1,Math.ceil(end/16));
}

export const STEPS_PER_BAR = 16;
export const DRUM_ROWS = [
  [35,"Acoustic Kick"],[36,"Kick"],[37,"Side Stick"],[38,"Snare"],[39,"Clap"],[40,"Electric Snare"],
  [41,"Low Floor Tom"],[42,"Closed Hi-hat"],[43,"High Floor Tom"],[44,"Pedal Hi-hat"],[45,"Low Tom"],[46,"Open Hi-hat"],
  [47,"Low Mid Tom"],[48,"High Mid Tom"],[49,"Crash 1"],[50,"High Tom"],[51,"Ride 1"],[52,"China"],[53,"Ride Bell"],
  [54,"Tambourine"],[55,"Splash"],[56,"Cowbell"],[57,"Crash 2"],[58,"Vibraslap"],[59,"Ride 2"],
  [60,"High Bongo"],[61,"Low Bongo"],[62,"Mute Conga"],[63,"Open Conga"],[64,"Low Conga"],[65,"High Timbale"],
  [66,"Low Timbale"],[67,"High Agogo"],[68,"Low Agogo"],[69,"Cabasa"],[70,"Maracas"],[71,"Short Whistle"],
  [72,"Long Whistle"],[73,"Short Guiro"],[74,"Long Guiro"],[75,"Claves"],[76,"High Woodblock"],[77,"Low Woodblock"],
  [78,"Mute Cuica"],[79,"Open Cuica"],[80,"Mute Triangle"],[81,"Open Triangle"],
].map(([pitch,name])=>({pitch:pitch as number,name:name as string}));
export const RANGE: Record<TrackRole, [number, number]> = {
  drums: [36, 42],
  bass: [28, 52],
  lead: [57, 84],
};

function legacyDemoProject(): Project {
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

/** Start without an unrelated backing arrangement; the target becomes a detected instrument. */
export function demoProject(): Project {
  return { bpm:100, root:"C", bars:4, tracks:{lead:{id:"lead",name:"生成先",notes:[],mute:false,ghost:null}}, log:[] };
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
    if (!s) return null;
    const project = JSON.parse(s) as Project;
    const legacy = legacyDemoProject();
    // Remove only the exact untouched demo backing, never edited or transcribed parts.
    for (const id of ["drums","bass"] as const) {
      const t=project.tracks[id];
      if(t&&!t.instrument&&t.name===legacy.tracks[id].name&&JSON.stringify(t.notes)===JSON.stringify(legacy.tracks[id].notes))delete project.tracks[id];
    }
    return project;
  } catch {
    return null;
  }
}

export function describeTrack(p: Project, id: TrackId): string {
  const t = p.tracks[id];
  if (!t.notes.length) return `${t.name}: (empty)`;
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const n = [...t.notes].sort((a, b) => a.step - b.step);
  if (trackRole(p,id) === "drums") {
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
  for (const id of Object.keys(p.tracks) as TrackId[]) {
    if (id === target) continue;
    const notes = [...p.tracks[id].notes].sort((a, b) => a.step - b.step);
    if (!notes.length) continue;
    const bodies: { bar: number; body: string }[] = [];
    for (let b = 0; b < p.bars; b++) {
      const bar = notes.filter((n) => Math.floor(n.step / 16) === b);
      if (!bar.length) continue;
      if (trackRole(p,id) === "drums") {
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

export function trackRole(p: Project, id: TrackId): TrackRole { return p.tracks[id]?.role ?? (id === "drums" || id === "bass" ? id : "lead"); }
export function trackRange(p: Project, id: TrackId): [number,number] {
  if(!id.startsWith("part:")&&!p.tracks[id].polyphonic)return RANGE[trackRole(p,id)];
  const notes = [...p.tracks[id].notes, ...(p.tracks[id].ghost?.notes ?? [])];
  const fallback = RANGE[trackRole(p,id)];
  return notes.length ? [Math.max(0,Math.min(fallback[0],...notes.map((n)=>n.pitch))-2),Math.min(127,Math.max(fallback[1],...notes.map((n)=>n.pitch))+2)] : fallback;
}
