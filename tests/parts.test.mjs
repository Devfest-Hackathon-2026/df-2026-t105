import test from 'node:test';
import assert from 'node:assert/strict';
import {INSTRUMENTS, instrumentInfo, notesToParts, roundStep} from '../src/core/parts.js';
import {selectAlignedWindow} from '../src/core/alignment.js';

test('instrument parts retain chords, their pitches and shared timing instead of flattening to a lead',()=>{
 const hits=[{instrument:'acoustic_piano',pitch:60,start:1,end:2},{instrument:'acoustic_piano',pitch:64,start:1,end:2},{instrument:'electric_bass',pitch:33,start:1,end:2},{instrument:'drums',pitch:49,start:1,end:1.2}];
 const p=notesToParts(hits,{bpm:120,bars:4,startSec:1});assert.equal(p.length,3);assert.deepEqual(p[0].notes.map(n=>n.pitch),[60,64]);assert(p.every(g=>g.notes.every(n=>n.step===0)));assert.equal(p[2].notes[0].pitch,49);
});
test('fast drum rolls and triplets retain individual onsets, short lengths and all drum pitches',()=>{
 const hits=[0,.25,.5,.75,2/3].map((step,i)=>({instrument:'drums',pitch:i===4?51:38,start:step*.125,end:(step+.1)*.125}));
 const [part]=notesToParts(hits,{bpm:120,bars:1});assert.equal(part.notes.length,5);assert.deepEqual(part.notes.map(n=>n.step),[0,.25,.5,2/3,.75]);assert(part.notes.every(n=>Math.abs(n.len-.1)<1e-12));assert(part.notes.some(n=>n.pitch===51));
});
test('MuScriptor 35 canonical instruments and GM program numbers match 1-to-1',()=>{
 const canonical=[
  ['acoustic_piano',0],['electric_piano',4],['chromatic_percussion',9],['organ',19],
  ['acoustic_guitar',24],['clean_electric_guitar',27],['distorted_electric_guitar',30],
  ['acoustic_bass',32],['electric_bass',33],['violin',40],['viola',41],['cello',42],
  ['contrabass',43],['orchestral_harp',46],['timpani',47],['string_ensemble',48],
  ['synth_strings',50],['voice',52],['orchestra_hit',55],['trumpet',56],['trombone',57],
  ['tuba',58],['french_horn',60],['brass_section',61],['soprano_and_alto_sax',65],
  ['tenor_sax',66],['baritone_sax',67],['oboe',68],['english_horn',69],['bassoon',70],
  ['clarinet',71],['flutes',73],['synth_lead',80],['synth_pad',89],['drums',0]
 ];
 assert.equal(Object.keys(INSTRUMENTS).length,35);
 for(const [name,prog] of canonical){
  assert.equal(INSTRUMENTS[name][0],prog,`Mismatch for ${name}`);
  assert.equal(instrumentInfo(name).program,prog);
 }
 assert.equal(instrumentInfo('program_73').program,73);
 assert.equal(instrumentInfo('program_33').role,'bass');
});
test('shuffle beat with unsteady beat_grid and null beats_per_bar aligns downbeats and triplet upbeats',()=>{
 // Simulate a 4-bar shuffle groove where beat_this returned steady=false and beats_per_bar=null
 const beats=Array.from({length:20},(_,i)=>1.2+i*0.5+Math.sin(i)*0.012);
 const hits=[];
 for(let b=0;b<16;b++){
  const t0=beats[b],t1=beats[b+1],dt=t1-t0;
  // Kick on 1 & 3, Snare on 2 & 4 (with a slightly early bar-1 downbeat -12ms)
  const onset0=t0+(b===0?-0.012:0.005);
  hits.push({instrument:'drums',pitch:b%2===0?36:38,start:onset0,end:onset0+0.02});
  // Shuffle hi-hat on beat and 2/3 of the beat (8th triplet upbeat)
  hits.push({instrument:'drums',pitch:42,start:t0+0.004,end:t0+0.02});
  hits.push({instrument:'drums',pitch:42,start:t0+(2/3)*dt-0.006,end:t0+(2/3)*dt+0.015});
 }
 const grid={bpm:120,beats_per_bar:null,first_downbeat:beats[0],onset_delay:0,beat_subdivision:3,steady:false,beats};
 const clock=selectAlignedWindow(hits,{bpm:100,bars:4,audioDuration:12,beatGrid:grid});
 const [drums]=notesToParts(hits,{bpm:clock.sourceBpm,bars:4,startSec:clock.startSec,windowBeats:clock.windowBeats,subdivision:clock.subdivision,quantizeStrength:0.85});
 // Bar 1 downbeat kick at step 0 is preserved (not dropped by early onset)
 assert.ok(drums.notes.some(n=>n.pitch===36&&n.step===0));
 // Shuffle upbeat hi-hat in beat 1 sits near 8/3 (2.6667 steps)
 assert.ok(drums.notes.some(n=>n.pitch===42&&Math.abs(n.step-roundStep(8/3))<0.15));
});
