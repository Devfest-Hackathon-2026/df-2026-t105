import test from 'node:test';
import assert from 'node:assert/strict';
import {notesToParts} from '../src/core/parts.js';
test('instrument parts retain chords, their pitches and shared timing instead of flattening to a lead',()=>{
 const hits=[{instrument:'acoustic_piano',pitch:60,start:1,end:2},{instrument:'acoustic_piano',pitch:64,start:1,end:2},{instrument:'electric_bass',pitch:33,start:1,end:2},{instrument:'drums',pitch:49,start:1,end:1.2}];
 const p=notesToParts(hits,{bpm:120,bars:4,startSec:1});assert.equal(p.length,3);assert.deepEqual(p[0].notes.map(n=>n.pitch),[60,64]);assert(p.every(g=>g.notes.every(n=>n.step===0)));assert.equal(p[2].notes[0].pitch,49);
});
test('fast drum rolls and triplets retain individual onsets, short lengths and all drum pitches',()=>{
 const hits=[0,.25,.5,.75,2/3].map((step,i)=>({instrument:'drums',pitch:i===4?51:38,start:step*.125,end:(step+.1)*.125}));
 const [part]=notesToParts(hits,{bpm:120,bars:1});assert.equal(part.notes.length,5);assert.deepEqual(part.notes.map(n=>n.step),[0,.25,.5,2/3,.75]);assert(part.notes.every(n=>Math.abs(n.len-.1)<1e-12));assert(part.notes.some(n=>n.pitch===51));
});
