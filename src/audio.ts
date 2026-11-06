import { trackRole, type TrackRole } from "./state";
import * as Tone from "tone";
import { SOUNDFONT_PRESETS, SoundFontPlayer, renderSoundFont } from "./soundfont";
import type { Note, Project, Track, TrackId } from "./state";

// MuseScore General SoundFont 準拠の音色一覧
export const PRESETS: Record<TrackRole, { id: string; name: string }[]> = {
  lead: SOUNDFONT_PRESETS.filter((p) => p.role === "lead").map(({ id, name }) => ({ id, name })),
  bass: SOUNDFONT_PRESETS.filter((p) => p.role === "bass").map(({ id, name }) => ({ id, name })),
  drums: SOUNDFONT_PRESETS.filter((p) => p.role === "drums").map(({ id, name }) => ({ id, name })),
};

/** ソロのトラックがあればそれだけ、なければミュートしていないトラックを鳴らす */
export function audibleTracks(p: Project): Track[] {
  const all = Object.values(p.tracks);
  const solo = all.filter((t) => t.solo);
  return (solo.length ? solo : all).filter((t) => !t.mute);
}

/** 再生エンジン。MuseScore General SoundFont で全トラックを鳴らす */
export class Engine {
  private soundfont = new SoundFontPlayer();
  private loopToContent = true;
  private lyria: Tone.Player | null = null;
  private shifter: Tone.PitchShift | null = null;
  private lyriaGain = new Tone.Gain(0.8).toDestination();

  /** A=自分の版のみ / B=ゴーストを MIDI で重ねる / L=Lyria の原音を重ねる */
  mode: "A" | "B" | "L" = "B";
  onStep: (step: number) => void = () => {};

  constructor(private get: () => Project) {
    Tone.getTransport().scheduleRepeat((time) => this.tick(time), "16n");
  }

  /** 音量と音色の変更を反映する */
  applyTrackSettings() {
    void this.soundfont.ready(Object.values(this.get().tracks)).catch(() => {});
  }

  private tick(time: number) {
    const p = this.get();
    const ticks = Tone.getTransport().ticks;
    const step = Math.round(ticks / (Tone.getTransport().PPQ / 4));
    const sixteenth = Tone.Time("16n").toSeconds();
    Tone.getDraw().schedule(() => this.onStep(step), time);
    for (const t of audibleTracks(p)) {
      for (const n of t.notes) if (n.step >= step && n.step < step+1) this.trigger(t, n, time+(n.step-step)*sixteenth, sixteenth, false);
      if (this.mode === "B" && t.ghost) for (const n of t.ghost.notes) if (n.step >= step && n.step < step+1) this.trigger(t, n, time+(n.step-step)*sixteenth, sixteenth, true);
    }
  }

  private trigger(t: Track, n: Note, time: number, sixteenth: number, ghost: boolean) {
    this.soundfont.play(t, n, time, n.len * sixteenth * 0.95, ghost);
  }

  /**
   * rate: 曲のテンポ ÷ 演奏のテンポ。再生速度を変えるので音の高さも 12·log2(rate) 半音ずれる。
   * semitones: 原音を曲のキーに合わせるために動かす半音数。速度によるずれも打ち消して、合計をピッチシフトで補う。
   */
  setLyria(buf: AudioBuffer | null, rate = 1, semitones = 0, startStep = 0) {
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
    this.lyria.loop = false;
    this.lyria.loopEnd = buf.duration;
    this.lyria.sync().start(`${Math.round(startStep * Tone.getTransport().PPQ / 4)}i`);
    this.applyMode();
  }

  applyMode() {
    this.lyriaGain.gain.value = this.mode === "L" ? 0.8 : 0;
  }

  async start(startStep=0,endStep=this.get().bars*16,loop=false) {
    await Tone.start();
    await this.soundfont.ready(Object.values(this.get().tracks));
    this.soundfont.resume();
    const p = this.get();
    const tr = Tone.getTransport();
    tr.bpm.value = p.bpm;
    this.loopToContent=startStep===0&&endStep===p.bars*16;
    tr.loop = loop;
    tr.loopStart = `${Math.round(startStep*tr.PPQ/4)}i`;
    tr.loopEnd = `${Math.round(endStep*tr.PPQ/4)}i`;
    this.applyMode();
    tr.start("+0.05", `${Math.round(startStep*tr.PPQ/4)}i`);
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
    if(!this.loopToContent)return;
    const tr=Tone.getTransport();tr.loopStart=0;tr.loopEnd=`${bars}m`;
  }
  setLoop(enabled:boolean){
    this.loopToContent=true;
    const tr=Tone.getTransport();tr.loopStart=0;tr.loopEnd=`${this.get().bars}m`;tr.loop=enabled;
  }
  get context() {
    return Tone.getContext().rawContext as AudioContext;
  }
}

/**
 * 採用済みの音（ゴーストは含めない）を、ループ回数ぶん MuseScore General SoundFont で書き出す。
 * 最後に 1.5 秒の余韻を足す。
 */
export async function renderMix(p: Project, loops = 2): Promise<AudioBuffer> {
  const sixteenth = 60 / p.bpm / 4;
  const loopSec = sixteenth * 16 * p.bars;
  const tail = 1.5;
  const duration = loopSec * loops + tail;
  const tracks = audibleTracks(p);
  if (!tracks.length) return new AudioBuffer({ numberOfChannels: 2, length: Math.ceil(duration * 44100), sampleRate: 44100 });
  const sf = await renderSoundFont(p, tracks, loops, duration);
  for (let ch = 0; ch < 2; ch++) {
    const data = sf.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= 0.9;
  }
  return sf;
}
