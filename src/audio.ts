import * as Tone from "tone";
import type { Note, Project, TrackId } from "./state";

/** 再生エンジン。16分ごとに今の状態を読んで鳴らすので、編集のたびに組み直す必要がない */
export class Engine {
  private kick = new Tone.MembraneSynth({ volume: -4 }).toDestination();
  private snare = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.15, sustain: 0 }, volume: -12 }).toDestination();
  private hat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.05, release: 0.01 }, volume: -26 }).toDestination();
  private bass = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    filter: { Q: 2, type: "lowpass" },
    filterEnvelope: { attack: 0.005, decay: 0.15, sustain: 0.2, baseFrequency: 120, octaves: 2.5 },
    envelope: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.1 },
    volume: -10,
  }).toDestination();
  private lead = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "square8" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.2 },
    volume: -18,
  }).toDestination();
  private ghostSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2 },
    volume: -12,
  }).toDestination();
  private lyria: Tone.Player | null = null;
  private lyriaGain = new Tone.Gain(0.8).toDestination();

  /** A=自分の版のみ / B=ゴーストを MIDI で重ねる / L=Lyria の原音を重ねる */
  mode: "A" | "B" | "L" = "B";
  onStep: (step: number) => void = () => {};

  constructor(private get: () => Project) {
    Tone.getTransport().scheduleRepeat((time) => this.tick(time), "16n");
  }

  private tick(time: number) {
    const p = this.get();
    const total = p.bars * 16;
    const ticks = Tone.getTransport().ticks;
    const step = Math.round(ticks / (Tone.getTransport().PPQ / 4)) % total;
    const sixteenth = Tone.Time("16n").toSeconds();
    Tone.getDraw().schedule(() => this.onStep(step), time);

    const play = (id: TrackId, notes: Note[], ghost: boolean) => {
      for (const n of notes) {
        if (n.step !== step) continue;
        const dur = n.len * sixteenth * 0.95;
        const v = 0.3 + 0.7 * n.vel;
        if (id === "drums") {
          if (n.pitch === 36) this.kick.triggerAttackRelease("C1", "8n", time, v);
          else if (n.pitch === 38) this.snare.triggerAttackRelease("16n", time, v);
          else this.hat.triggerAttackRelease("C6", "32n", time, v);
        } else if (ghost) {
          this.ghostSynth.triggerAttackRelease(Tone.Frequency(n.pitch, "midi").toFrequency(), dur, time, v);
        } else if (id === "bass") {
          this.bass.triggerAttackRelease(Tone.Frequency(n.pitch, "midi").toFrequency(), dur, time, v);
        } else {
          this.lead.triggerAttackRelease(Tone.Frequency(n.pitch, "midi").toFrequency(), dur, time, v);
        }
      }
    };
    for (const t of Object.values(p.tracks)) {
      if (t.mute) continue;
      play(t.id, t.notes, false);
      if (this.mode === "B" && t.ghost) play(t.id, t.ghost.notes, true);
    }
  }

  setLyria(buf: AudioBuffer | null) {
    this.lyria?.unsync().dispose();
    this.lyria = null;
    if (!buf) return;
    const p = this.get();
    this.lyria = new Tone.Player(buf).connect(this.lyriaGain);
    this.lyria.loop = true;
    this.lyria.loopEnd = (60 / p.bpm) * 4 * p.bars;
    this.lyria.sync().start(0);
    this.applyMode();
  }

  applyMode() {
    this.lyriaGain.gain.value = this.mode === "L" ? 0.8 : 0;
  }

  async start() {
    await Tone.start();
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
    this.onStep(-1);
  }
  get playing() {
    return Tone.getTransport().state === "started";
  }
  setBpm(bpm: number) {
    Tone.getTransport().bpm.value = bpm;
  }
  get context() {
    return Tone.getContext().rawContext as AudioContext;
  }
}
