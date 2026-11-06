import * as Tone from "tone";
import { WorkletSynthesizer } from "spessasynth_lib";
import { SoundBankLoader, SpessaSynthProcessor } from "spessasynth_core";
import workletUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import { trackRole } from "./state";
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
  private synths: WorkletSynthesizer[] = [];
  private loading?: Promise<void>;
  private moduleReady?: Promise<void>;
  private version = 0;
  private extraChannels = new Map<string,number>();
  private nextChannel = 4;
  private channelFor(track:Track,ghost=false) {
    if(!track.id.startsWith("part:"))return channel(track.id,ghost);
    const key=track.id+"/"+ghost;
    if(!this.extraChannels.has(key)) {
      while([9,10].includes(this.nextChannel))this.nextChannel++;
      this.extraChannels.set(key,this.nextChannel++);
    }
    return this.extraChannels.get(key)!;
  }
  async ready(tracks:Track[] = []) {
    for(const t of tracks){this.channelFor(t);this.channelFor(t,true)}
    if(this.loading)await this.loading;
    const needed=Math.floor(Math.max(10,...this.extraChannels.values())/16)+1;
    if(this.synths.length>=needed){
      for(const t of tracks)for(const ghost of [false,true]){const index=this.channelFor(t,ghost);this.synths[Math.floor(index/16)].midiChannels[index%16].setDrums((t.role??t.id)==="drums")}
      return;
    }
    this.loading=this.prepare(needed,tracks).finally(()=>{this.loading=undefined});
    return this.loading;
  }
  private async prepare(needed:number,tracks:Track[]) {
    const data=await bytes(),ctx=Tone.getContext();
    this.moduleReady ??= ctx.addAudioWorkletModule(workletUrl);
    await this.moduleReady;
    // Keep each worklet at its native 16 channels. The library emits reset events before
    // channelAdded when expanding, so multiple fixed banks avoid its state-sync race.
    while(this.synths.length<needed) {
      const synth=new WorkletSynthesizer(ctx.rawContext as AudioContext,{
        audioNodeCreators:{worklet:(_ctx,name,opts)=>ctx.createAudioWorkletNode(name,opts)},
      });
      try {
        synth.connect(ctx.rawContext.destination);await synth.isReady;
        await synth.soundBankManager.addSoundBank(data.slice(0),"MuseScore_General");
        this.synths.push(synth);
      } catch(e){synth.destroy();throw e}
    }
    for(const t of tracks)for(const ghost of [false,true]) {
      const index=this.channelFor(t,ghost),synth=this.synths[Math.floor(index/16)];
      synth.midiChannels[index%16].setDrums((t.role??t.id)==="drums");
    }
  }
  play(track:Track,n:Note,time:number,duration:number,ghost=false) {
    const program=programFor(track.role??track.id,track.preset);
    if(program===null)return false;
    const index=this.channelFor(track,ghost),synth=this.synths[Math.floor(index/16)],ch=index%16;
    if(!synth)return true;
    synth.programChange(ch,program,{time});
    synth.controllerChange(ch,7,Math.min(127,Math.round(90*10**((track.volume??0)/20))),{time});
    synth.noteOn(ch,n.pitch,Math.round((.3+.7*n.vel)*100),{time});
    synth.noteOff(ch,n.pitch,{time:time+duration});return true;
  }
  stop(){const version=++this.version;for(const s of this.synths)s.stopAll(true);setTimeout(()=>{if(this.version===version)for(const s of this.synths)s.stopAll(true)},150)}
  resume(){++this.version}
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
    let nextChannel = 0;
    for (const t of tracks) {
      const program = programFor(trackRole(p,t.id), t.preset);
      if (program === null) continue;
      if(nextChannel===9)nextChannel++;
      const ch = nextChannel++;
      while(ch>=synth.midiChannels.length)synth.createMIDIChannel();
      if(trackRole(p,t.id)==="drums")synth.midiChannels[ch].setDrums(true);
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
