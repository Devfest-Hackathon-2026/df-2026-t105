// Build a listening pack from completed CPU and/or A100 experiments; no placeholder audio.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { BasicSoundBank, SoundBankLoader, SpessaSynthProcessor } from "spessasynth_core";
const root=process.argv[2]??'out/experiment-transcription';
const dest='public/compare',media=join(dest,'audio');mkdirSync(media,{recursive:true});
const plan=JSON.parse(readFileSync(join(root,'plan.json')));
const bytes=readFileSync('public/soundfonts/MuseScore_General.sf3');await BasicSoundBank.ready;
const programs={acoustic_piano:0,electric_piano:4,chromatic_percussion:12,organ:16,acoustic_guitar:24,clean_electric_guitar:27,distorted_electric_guitar:30,acoustic_bass:32,electric_bass:33,violin:40,viola:41,cello:42,contrabass:43,orchestral_harp:46,timpani:47,string_ensemble:48,synth_strings:50,voice:52,orchestra_hit:55,trumpet:56,trombone:57,tuba:58,french_horn:60,brass_section:61,soprano_and_alto_sax:64,tenor_sax:66,baritone_sax:67,oboe:68,english_horn:69,bassoon:70,clarinet:71,flutes:73,synth_lead:80,synth_pad:88,drums:0};
async function render(notes,path,seconds){
 const sr=22050,n=Math.ceil(seconds*sr),left=new Float32Array(n),right=new Float32Array(n),synth=new SpessaSynthProcessor(sr,{effectsEnabled:false});await synth.ready;synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),'general');
 const channels=new Map();let ch=0;for(const group of [...new Set(notes.map((x)=>x.instrument))]){if(ch===9)ch++;if(ch>=16)throw new Error('Too many instruments');const c=group==='drums'?9:ch++;channels.set(group,c);synth.programChange(c,programs[group]??0);synth.controllerChange(c,7,80)}
 const events=notes.flatMap((note)=>[{sample:Math.round(note.start*sr),on:true,note},{sample:Math.round(note.end*sr),on:false,note}]).sort((a,b)=>a.sample-b.sample||Number(a.on)-Number(b.on));let i=0;
 for(let pos=0;pos<n;){while(i<events.length&&events[i].sample<=pos){const e=events[i++],c=channels.get(e.note.instrument);if(e.on)synth.noteOn(c,e.note.pitch,85);else synth.noteOff(c,e.note.pitch)}const size=Math.min(128,n-pos,i<events.length?events[i].sample-pos:128);synth.process(left,right,pos,size);pos+=size}
 synth.destroy();const pcm=Buffer.alloc(n*8);for(let j=0;j<n;j++){pcm.writeFloatLE(left[j],j*8);pcm.writeFloatLE(right[j],j*8+4)}execFileSync('ffmpeg',['-y','-v','error','-f','f32le','-ar',String(sr),'-ac','2','-i','pipe:0','-b:a','128k',path],{input:pcm,maxBuffer:10*1024*1024});
}
const names={'constrained':'原音 → 対象楽器だけに制限して採譜','multitrack':'原音 → 複数楽器を自動判別して採譜','stem-constrained':'ステム分離 → 対象楽器だけに制限して採譜','stem-multitrack':'ステム分離 → 複数楽器を自動判別して採譜','multitrack-conditioned':'原音 → 想定する複数楽器を指定して採譜'};
const samples=[];const models=new Set();
for(const task of plan.tasks){
 if(task.treatment==='known-midi')continue;
 const original=`${task.id}.mp3`;
 if(!existsSync(join(media,original)))execFileSync('ffmpeg',['-y','-v','error','-i',join(root,`${task.id}.wav`),'-b:a','160k',join(media,original)]);
 const rows=[];for(const dir of [root,join(root,'gpu-results')]){if(!existsSync(dir))continue;for(const file of readdirSync(dir)){if(!file.startsWith(task.id+'.')||!file.endsWith('.json')||file.endsWith('.error.json'))continue;try{const r=JSON.parse(readFileSync(join(dir,file)));if(r.notes&&r.model&&r.method&&r.model!=="small-cpu")rows.push(r)}catch{}}}
 const variants=[];for(const r of rows){const filename=`${task.id}.${r.model}.${r.method}.mp3`;if(!existsSync(join(media,filename)))await render(r.notes,join(media,filename),20);models.add(r.model);variants.push({id:`${r.model}/${r.method}`,model:r.model,method:r.model==="basic-pitch"?"原音 → 音高を採譜（楽器分類なし）":names[r.method],url:`./audio/${filename}`,notes:r.totalNotes,seconds:r.model==="basic-pitch"?undefined:r.seconds,instruments:Object.keys(r.groups),instrumentClassification:r.instrumentClassification!==false})}
 samples.push({id:task.id,role:task.role,draw:task.draw,duration:20,condition:task.treatment,conditionName:task.treatment==='isolated'?'対象トラックだけを出力するよう強調':'従来のソロ指定',prompt:task.prompt,original:`./audio/${original}`,variants});
}
const available=[...models].sort((a,b)=>['basic-pitch','large-a100','medium-a100','small-a100'].indexOf(a)-['basic-pitch','large-a100','medium-a100','small-a100'].indexOf(b));
const manifest={id:'prompt-transcription-2026-11-06',updatedAt:new Date().toISOString(),models:available,samples};writeFileSync(join(dest,'manifest.json.tmp'),JSON.stringify(manifest,null,2));renameSync(join(dest,'manifest.json.tmp'),join(dest,'manifest.json'));console.log(JSON.stringify({models:available,samples:samples.length,variants:samples.reduce((s,t)=>s+t.variants.length,0)}));
