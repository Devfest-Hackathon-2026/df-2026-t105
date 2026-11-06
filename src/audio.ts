import { trackRole, type TrackRole } from "./state";
import * as Tone from "tone";
import { SoundFontPlayer, programFor, renderSoundFont } from "./soundfont";
import type { Note, Project, Track, TrackId } from "./state";

// 音色の候補。トラックの preset にこの名前を入れる
export const PRESETS: Record<"lead" | "bass", { id: string; name: string }[]> = {
  lead: [
    { id: "sf:73", name: "フルート" },
    { id: "sf:0", name: "ピアノ" },
    { id: "sf:12", name: "マリンバ" },
    { id: "sf:80", name: "シンセリード" },
    { id: "square", name: "矩形波" },
    { id: "saw", name: "ノコギリ波" },
    { id: "soft", name: "やわらかい" },
    { id: "pluck", name: "はじく" },
  ],
  bass: [
    { id: "sf:33", name: "指弾きベース" },
    { id: "sf:32", name: "コントラバス" },
    { id: "sf:38", name: "シンセベース" },
    { id: "saw", name: "ノコギリ波" },
    { id: "sub", name: "サブベース" },
    { id: "pluck", name: "はじく" },
  ],
};

type Instruments = {
  kick: Tone.MembraneSynth;
  snare: Tone.NoiseSynth;
  hat: Tone.MetalSynth;
  bass: Tone.MonoSynth;
  lead: Tone.PolySynth;
  ghost: Tone.PolySynth;
  channels: Record<TrackRole | "ghost", Tone.Channel>;
  dispose: () => void;
};

type SynthOpts = NonNullable<ConstructorParameters<typeof Tone.Synth>[0]>;
type MonoOpts = NonNullable<ConstructorParameters<typeof Tone.MonoSynth>[0]>;

function leadOptions(preset: string): SynthOpts {
  switch (preset) {
    case "saw":
      return { oscillator: { type: "sawtooth" } as never, envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.25 }, volume: -20 };
    case "soft":
      return { oscillator: { type: "triangle" } as never, envelope: { attack: 0.06, decay: 0.3, sustain: 0.6, release: 0.5 }, volume: -12 };
    case "pluck":
      return { oscillator: { type: "square4" } as never, envelope: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.1 }, volume: -14 };
    default:
      return { oscillator: { type: "square8" } as never, envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.2 }, volume: -18 };
  }
}
function bassOptions(preset: string): MonoOpts {
  switch (preset) {
    case "sub":
      return { oscillator: { type: "sine" } as never, filter: { Q: 0.5, type: "lowpass" }, filterEnvelope: { attack: 0.005, decay: 0.1, sustain: 1, baseFrequency: 400, octaves: 0 }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.12 }, volume: -6 };
    case "pluck":
      return { oscillator: { type: "square" } as never, filter: { Q: 3, type: "lowpass" }, filterEnvelope: { attack: 0.002, decay: 0.12, sustain: 0, baseFrequency: 150, octaves: 3 }, envelope: { attack: 0.002, decay: 0.25, sustain: 0.1, release: 0.08 }, volume: -10 };
    default:
      return { oscillator: { type: "sawtooth" } as never, filter: { Q: 2, type: "lowpass" }, filterEnvelope: { attack: 0.005, decay: 0.15, sustain: 0.2, baseFrequency: 120, octaves: 2.5 }, envelope: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.1 }, volume: -10 };
  }
}

/** 楽器一式を、いまのコンテキスト（通常再生なら画面のもの、書き出しならオフラインのもの）に作る */
function makeInstruments(p: Project, out: Tone.InputNode): Instruments {
  const ch = (t?: Track) => new Tone.Channel({ volume: t?.volume ?? 0 }).connect(out);
  const channels = { drums: ch(p.tracks.drums), bass: ch(p.tracks.bass), lead: ch(p.tracks.lead), ghost: ch() };
  const kick = new Tone.MembraneSynth({ volume: -4 }).connect(channels.drums);
  const snare = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.15, sustain: 0 }, volume: -12 }).connect(channels.drums);
  const hat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.05, release: 0.01 }, volume: -26 }).connect(channels.drums);
  const bass = new Tone.MonoSynth(bassOptions(p.tracks.bass.preset ?? "saw")).connect(channels.bass);
  const lead = new Tone.PolySynth(Tone.Synth, leadOptions(p.tracks.lead.preset ?? "square")).connect(channels.lead);
  const ghost = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" } as never,
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2 },
    volume: -12,
  }).connect(channels.ghost);
  return {
    kick, snare, hat, bass, lead, ghost, channels,
    dispose: () => { for (const x of [kick, snare, hat, bass, lead, ghost, ...Object.values(channels)]) x.dispose(); },
  };
}

/** 1音を鳴らす（通常再生と書き出しで共通） */
function trigger(ins: Instruments, id: TrackId, n: Note, time: number, sixteenth: number, ghost: boolean) {
  const dur = n.len * sixteenth * 0.95;
  const v = 0.3 + 0.7 * n.vel;
  if (id === "drums") {
    if (n.pitch === 36) ins.kick.triggerAttackRelease("C1", "8n", time, v);
    else if (n.pitch === 38) ins.snare.triggerAttackRelease("16n", time, v);
    else ins.hat.triggerAttackRelease("C6", "32n", time, v);
  } else {
    const f = Tone.Frequency(n.pitch, "midi").toFrequency();
    if (ghost) ins.ghost.triggerAttackRelease(f, dur, time, v);
    else if (id === "bass") ins.bass.triggerAttackRelease(f, dur, time, v);
    else ins.lead.triggerAttackRelease(f, dur, time, v);
  }
}

/** ソロのトラックがあればそれだけ、なければミュートしていないトラックを鳴らす */
export function audibleTracks(p: Project): Track[] {
  const all = Object.values(p.tracks);
  const solo = all.filter((t) => t.solo);
  return (solo.length ? solo : all).filter((t) => !t.mute);
}

/** 再生エンジン。16分ごとに今の状態を読んで鳴らすので、編集のたびに組み直す必要がない */
export class Engine {
  private ins: Instruments;
  private soundfont = new SoundFontPlayer();
  private presetKey = "";
  private lyria: Tone.Player | null = null;
  private shifter: Tone.PitchShift | null = null;
  private lyriaGain = new Tone.Gain(0.8).toDestination();

  /** A=自分の版のみ / B=ゴーストを MIDI で重ねる / L=Lyria の原音を重ねる */
  mode: "A" | "B" | "L" = "B";
  onStep: (step: number) => void = () => {};

  constructor(private get: () => Project) {
    this.ins = makeInstruments(get(), Tone.getDestination());
    this.presetKey = this.keyOf(get());
    Tone.getTransport().scheduleRepeat((time) => this.tick(time), "16n");
  }

  private keyOf(p: Project) {
    return `${p.tracks.lead.preset ?? "square"}/${p.tracks.bass.preset ?? "saw"}`;
  }

  /** 音量と音色の変更を反映する。音色が変わったときだけ楽器を作り直す */
  applyTrackSettings() {
    const p = this.get();
    const key = this.keyOf(p);
    if (key !== this.presetKey) {
      this.ins.dispose();
      this.ins = makeInstruments(p, Tone.getDestination());
      this.presetKey = key;
    }
    for (const id of ["drums", "bass", "lead"] as TrackRole[]) this.ins.channels[id].volume.value = p.tracks[id].volume ?? 0;
  }

  private tick(time: number) {
    const p = this.get();
    const total = p.bars * 16;
    const ticks = Tone.getTransport().ticks;
    const step = Math.round(ticks / (Tone.getTransport().PPQ / 4)) % total;
    const sixteenth = Tone.Time("16n").toSeconds();
    Tone.getDraw().schedule(() => this.onStep(step), time);
    for (const t of audibleTracks(p)) {
      for (const n of t.notes) if (n.step === step) this.trigger(t, n, time, sixteenth, false);
      if (this.mode === "B" && t.ghost) for (const n of t.ghost.notes) if (n.step === step) this.trigger(t, n, time, sixteenth, true);
    }
  }

  private trigger(t: Track, n: Note, time: number, sixteenth: number, ghost: boolean) {
    if (!this.soundfont.play(t, n, time, n.len * sixteenth * 0.95, ghost)) trigger(this.ins, trackRole(this.get(),t.id), n, time, sixteenth, ghost);
  }

  /**
   * rate: 曲のテンポ ÷ 演奏のテンポ。再生速度を変えるので音の高さも 12·log2(rate) 半音ずれる。
   * semitones: 原音を曲のキーに合わせるために動かす半音数。速度によるずれも打ち消して、合計をピッチシフトで補う。
   */
  setLyria(buf: AudioBuffer | null, rate = 1, semitones = 0) {
    this.lyria?.unsync().dispose();
    this.lyria = null;
    this.shifter?.dispose();
    this.shifter = null;
    if (!buf) return;
    const shift = semitones - 12 * Math.log2(rate);
    this.lyria = new Tone.Player(buf);
    if (Math.abs(shift) > 0.05) {
      this.shifter = new Tone.PitchShift({ pitch: shift, windowSize: 0.08 }).connect(this.lyriaGain);
      this.lyria.connect(this.shifter);
    } else {
      this.lyria.connect(this.lyriaGain);
    }
    this.lyria.playbackRate = rate;
    this.lyria.loop = true;
    this.lyria.loopEnd = buf.duration;
    this.lyria.sync().start(0);
    this.applyMode();
  }

  applyMode() {
    this.lyriaGain.gain.value = this.mode === "L" ? 0.8 : 0;
  }

  async start() {
    await Tone.start();
    await this.soundfont.ready(Object.values(this.get().tracks));
    this.soundfont.resume();
    const p = this.get();
    const tr = Tone.getTransport();
    tr.bpm.value = p.bpm;
    tr.loop = true;
    tr.loopStart = 0;
    tr.loopEnd = `${p.bars}m`;
    this.applyMode();
    tr.start("+0.05", 0);
  }
  stop() {
    Tone.getTransport().stop();
    this.soundfont.stop();
    this.onStep(-1);
  }
  get playing() {
    return Tone.getTransport().state === "started";
  }
  setBpm(bpm: number) {
    Tone.getTransport().bpm.value = bpm;
  }
  /** 鍵盤を押したときなどに、その場で1音鳴らす */
  async audition(id: TrackId, pitch: number) {
    await Tone.start();
    await this.soundfont.ready(Object.values(this.get().tracks));
    this.trigger(this.get().tracks[id], { step: 0, len: 2, pitch, vel: 0.8 }, Tone.now() + 0.01, 60 / this.get().bpm / 4, false);
  }
  setBars(bars: number) {
    Tone.getTransport().loopEnd = `${bars}m`;
  }
  get context() {
    return Tone.getContext().rawContext as AudioContext;
  }
}

/**
 * 採用済みの音（ゴーストは含めない）を、ループ回数ぶんオフラインで書き出す。
 * 最後に 1.5 秒の余韻を足す。
 */
export async function renderMix(p: Project, loops = 2): Promise<AudioBuffer> {
  const sixteenth = 60 / p.bpm / 4;
  const loopSec = sixteenth * 16 * p.bars;
  const tail = 1.5;
  const sfTracks = audibleTracks(p).filter((t) => programFor(trackRole(p,t.id), t.preset) !== null);
  const sf = sfTracks.length ? await renderSoundFont(p, sfTracks, loops, loopSec * loops + tail) : null;
  const rendered = await Tone.Offline(() => {
    const master = new Tone.Gain(0.9).toDestination();
    const ins = makeInstruments(p, master);
    for (let k = 0; k < loops; k++) {
      for (const t of audibleTracks(p)) {
        for (const n of t.notes.filter((n) => n.step < p.bars * 16 && programFor(trackRole(p,t.id), t.preset) === null)) trigger(ins, trackRole(p,t.id), n, k * loopSec + n.step * sixteenth, sixteenth, false);
      }
    }
  }, loopSec * loops + tail, 2, 44100);
  const result = rendered.get() as AudioBuffer;
  if (sf) for (let ch = 0; ch < 2; ch++) {
    const dst = result.getChannelData(ch), src = sf.getChannelData(ch);
    for (let i = 0; i < dst.length; i++) dst[i] += src[i] * 0.9;
  }
  return result;
}
