// Baseline: same 20-second source clips, raw Basic Pitch output, no quantization or monophonic cleanup.
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const root='out/experiment-transcription';
const tasks=JSON.parse(readFileSync(join(root,'plan.json'))).tasks.filter((t)=>t.treatment!=='known-midi');let next=0;
async function run(task){
 const base=join(root,task.id),raw=`${base}.basic-pitch.json`;
 if(!existsSync(raw))await new Promise((ok,fail)=>{
  const p=spawn(process.execPath,['scripts/transcribe.mjs',`${base}.wav`,'--bpm','100','--scale','C','--json',raw],{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',(b)=>{err+=b});p.on('error',fail);p.on('exit',(code)=>code===0?ok():fail(new Error(`${task.id}: ${err.slice(-300)}`)));
 });
 const data=JSON.parse(readFileSync(raw));
 const notes=data.notes.map((n)=>({pitch:n.pitchMidi,start:n.startTimeSeconds,end:n.startTimeSeconds+n.durationSeconds,instrument:task.instrument}));
 const row={id:task.id,role:task.role,treatment:task.treatment,draw:task.draw,expectedInstrument:task.instrument,model:'basic-pitch',method:'multitrack',seconds:data.summary.transcribeMs/1000,totalNotes:notes.length,targetNotes:null,otherNotes:null,instrumentClassification:false,groups:{[task.instrument]:{notes:notes.length}},notes,warning:'Basic Pitch does not classify instruments. The requested instrument is assigned for soundfont playback only.'};
 writeFileSync(`${base}.basic-pitch.baseline.json`,JSON.stringify(row,null,2));console.log(`DONE Basic Pitch ${task.id}: ${notes.length} notes`);
}
async function worker(){while(next<tasks.length)await run(tasks[next++])}
await Promise.all(Array.from({length:4},worker));
