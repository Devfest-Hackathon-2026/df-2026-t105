// Render raw, instrument-labelled notes with the same official SF3 used in the app.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BasicSoundBank, SoundBankLoader, SpessaSynthProcessor } from "spessasynth_core";
const out = process.argv[2] ?? "out/experiment-transcription";
const bankData = readFileSync("public/soundfonts/MuseScore_General.sf3");
await BasicSoundBank.ready;
const programs = { acoustic_piano:0,electric_piano:4,chromatic_percussion:12,organ:16,acoustic_guitar:24,clean_electric_guitar:27,distorted_electric_guitar:30,acoustic_bass:32,electric_bass:33,violin:40,viola:41,cello:42,contrabass:43,orchestral_harp:46,timpani:47,string_ensemble:48,synth_strings:50,voice:52,orchestra_hit:55,trumpet:56,trombone:57,tuba:58,french_horn:60,brass_section:61,soprano_and_alto_sax:64,tenor_sax:66,baritone_sax:67,oboe:68,english_horn:69,bassoon:70,clarinet:71,flutes:73,synth_lead:80,synth_pad:88,drums:0 };
async function render(notes, path, duration=20) {
 const sr=44100, n=Math.ceil((duration+1)*sr), left=new Float32Array(n),right=new Float32Array(n);
 const synth=new SpessaSynthProcessor(sr,{effectsEnabled:false});await synth.ready;synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(bankData.buffer.slice(bankData.byteOffset, bankData.byteOffset+bankData.byteLength)),"MuseScore_General");
 const groups=[...new Set(notes.map((x)=>x.instrument))], channels=new Map(); let ch=0;
 for(const group of groups){if(ch===9)ch++;if(ch>=16)throw new Error("Too many instrument groups");const c=group==="drums"?9:ch++;channels.set(group,c);synth.programChange(c,programs[group]??0);synth.controllerChange(c,7,80);}
 const events=notes.flatMap((note)=>[{sample:Math.round(note.start*sr),on:true,note},{sample:Math.round(note.end*sr),on:false,note}]).sort((a,b)=>a.sample-b.sample||Number(a.on)-Number(b.on));
 let i=0;for(let pos=0;pos<n;){while(i<events.length&&events[i].sample<=pos){const e=events[i++],c=channels.get(e.note.instrument);if(e.on)synth.noteOn(c,e.note.pitch,e.note.velocity??85);else synth.noteOff(c,e.note.pitch);}const size=Math.min(128,n-pos,i<events.length?events[i].sample-pos:128);synth.process(left,right,pos,size);pos+=size;}
 synth.destroy();const b=Buffer.alloc(44+n*4);b.write("RIFF");b.writeUInt32LE(b.length-8,4);b.write("WAVEfmt ",8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*4,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(n*4,40);for(let j=0;j<n;j++){b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,left[j]))*32767),44+j*4);b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,right[j]))*32767),46+j*4);}writeFileSync(path,b);
}
const planPath=join(out,"plan.json"),plan=JSON.parse(readFileSync(planPath));
if(!existsSync(join(out,"known-mixture.wav"))){
 const notes=[];for(let i=0;i<16;i++){const start=.5+i*.5;notes.push({instrument:"flutes",pitch:[72,76,79,76][i%4],start,end:start+.35});if(i%2===0)notes.push({instrument:"electric_bass",pitch:[36,41,45,43][Math.floor(i/4)],start,end:start+.7});notes.push({instrument:"drums",pitch:i%4===2?38:36,start,end:start+.08,velocity:65});notes.push({instrument:"drums",pitch:42,start:start+.25,end:start+.32,velocity:45});}
 writeFileSync(join(out,"known-mixture.reference.json"),JSON.stringify(notes,null,2));
 await render(notes,join(out,"known-mixture.wav"),9);
 await render(notes.filter((n)=>n.instrument==="flutes"),join(out,"known-flute-only.wav"),9);
 if(!plan.tasks.some((t)=>t.id==="known-mixture")) plan.tasks.push({id:"known-mixture",role:"lead",instrument:"flutes",treatment:"known-midi",draw:1,model:"official-SF3",prompt:"Synthetic known-MIDI control"});writeFileSync(planPath,JSON.stringify(plan,null,2));
}
if(process.argv.includes("--control-only"))process.exit(0);
for(const task of plan.tasks)for(const method of ["constrained","multitrack","stem-constrained"]){const base=join(out,`${task.id}.${method}`);if(!existsSync(`${base}.json`)||existsSync(`${base}.wav`))continue;const row=JSON.parse(readFileSync(`${base}.json`));await render(row.notes,`${base}.wav`,task.id==="known-mixture"?9:20);console.log(`RENDER ${task.id} ${method}`);}
