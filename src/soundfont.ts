import * as Tone from "tone";
import { WorkletSynthesizer } from "spessasynth_lib";
import { SoundBankLoader, SpessaSynthProcessor } from "spessasynth_core";
import workletUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import type { Note, Project, Track, TrackId } from "./state";

const URL_SF = `${import.meta.env.BASE_URL}soundfonts/MuseScore_General.sf3`;
let bankBytes: Promise<ArrayBuffer> | undefined;
function bytes() {
  return bankBytes ??= fetch(URL_SF).then((r) => {
    if (!r.ok) throw new Error(`音源を読み込めませんでした（${r.status}）。再読み込みしてください`);
    return r.arrayBuffer();
  }).catch((e) => { bankBytes = undefined; throw e; });
}
export function programFor(id: TrackId, preset?: string): number | null {
  if (id === "drums") return 0;
  const value = preset ?? (id === "lead" ? "sf:73" : "sf:33");
  return /^sf:\d+$/.test(value) ? Number(value.slice(3)) : null;
}
export function midiProgram(id: TrackId, preset?: string): number {
  return programFor(id, preset) ?? (id === "bass" ? (preset === "sub" ? 39 : 38) : preset === "saw" ? 81 : 80);
}
const channel = (id: TrackId, ghost = false) => (id === "drums" ? 9 : id === "bass" ? 1 : 0) + (ghost ? (id === "drums" ? 1 : 2) : 0);

export class SoundFontPlayer {
  private synth?: WorkletSynthesizer;
  private loading?: Promise<void>;
  private version = 0;
  async ready() {
    if (this.synth) return;
    return this.loading ??= this.init().catch((e) => { this.loading = undefined; throw e; });
  }
  private async init() {
    const data = await bytes();
    const ctx = Tone.getContext();
    await ctx.addAudioWorkletModule(workletUrl);
    const synth = new WorkletSynthesizer(ctx.rawContext as AudioContext, {
      audioNodeCreators: { worklet: (_ctx, name, opts) => ctx.createAudioWorkletNode(name, opts) },
    });
    try {
      synth.connect(ctx.rawContext.destination);
      await synth.isReady;
      await synth.soundBankManager.addSoundBank(data.slice(0), "MuseScore_General");
      synth.midiChannels[10].setDrums(true);
      this.synth = synth;
    } catch (e) { synth.destroy(); throw e; }
  }
  play(track: Track, n: Note, time: number, duration: number, ghost = false) {
    const program = programFor(track.id, track.preset);
    if (program === null) return false;
    if (!this.synth) return true;
    const synth = this.synth, ch = channel(track.id, ghost);
    synth.programChange(ch, program, { time });
    synth.controllerChange(ch, 7, Math.min(127, Math.round(90 * 10 ** ((track.volume ?? 0) / 20))), { time });
    synth.noteOn(ch, n.pitch, Math.round((0.3 + 0.7 * n.vel) * 100), { time });
    synth.noteOff(ch, n.pitch, { time: time + duration });
    return true;
  }
  stop() {
    // Clear queued note-ons too: stopAll alone does not cancel future scheduled notes.
    const version = ++this.version;
    this.synth?.stopAll(true);
    setTimeout(() => { if (this.version === version) this.synth?.stopAll(true); }, 150);
  }
  resume() { ++this.version; }
}

/** Render the same SF3 presets and track gains used during playback. */
export async function renderSoundFont(p: Project, tracks: Track[], loops: number, duration: number): Promise<AudioBuffer> {
  const sr = 44100;
  const synth = new SpessaSynthProcessor(sr, { effectsEnabled: false });
  try {
    await synth.ready;
    synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer((await bytes()).slice(0)), "MuseScore_General");
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: Math.ceil(duration * sr), sampleRate: sr });
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    const sixteenth = 60 / p.bpm / 4, loopSec = sixteenth * p.bars * 16;
    const events: { sample: number; on: boolean; ch: number; note: Note }[] = [];
    for (const t of tracks) {
      const program = programFor(t.id, t.preset);
      if (program === null) continue;
      const ch = channel(t.id);
      synth.programChange(ch, program);
      synth.controllerChange(ch, 7, Math.min(127, Math.round(90 * 10 ** ((t.volume ?? 0) / 20))));
      for (let k = 0; k < loops; k++) for (const note of t.notes) {
        if (note.step >= p.bars * 16) continue;
        const start = k * loopSec + note.step * sixteenth;
        events.push({ sample: Math.round(start * sr), on: true, ch, note }, { sample: Math.round((start + note.len * sixteenth * 0.95) * sr), on: false, ch, note });
      }
    }
    events.sort((a, b) => a.sample - b.sample || Number(a.on) - Number(b.on));
    let i = 0;
    for (let pos = 0; pos < buffer.length;) {
      while (i < events.length && events[i].sample <= pos) {
        const e = events[i++];
        if (e.on) synth.noteOn(e.ch, e.note.pitch, Math.round((0.3 + 0.7 * e.note.vel) * 100));
        else synth.noteOff(e.ch, e.note.pitch);
      }
      const size = Math.min(128, buffer.length - pos, i < events.length ? events[i].sample - pos : 128);
      synth.process(left, right, pos, size);
      pos += size;
    }
    return buffer;
  } finally { synth.destroy(); }
}
