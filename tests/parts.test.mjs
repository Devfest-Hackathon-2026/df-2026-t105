import test from 'node:test';
import assert from 'node:assert/strict';
import {notesToParts} from '../src/core/parts.js';
test('instrument parts retain chords, their pitches and shared timing instead of flattening to a lead',()=>{
 const hits=[{instrument:'acoustic_piano',pitch:60,start:1,end:2},{instrument:'acoustic_piano',pitch:64,start:1,end:2},{instrument:'electric_bass',pitch:33,start:1,end:2},{instrument:'drums',pitch:49,start:1,end:1.2}];
 const p=notesToParts(hits,{bpm:120,bars:4,startSec:1});assert.equal(p.length,3);assert.deepEqual(p[0].notes.map(n=>n.pitch),[60,64]);assert(p.every(g=>g.notes.every(n=>n.step===0)));assert.equal(p[2].notes[0].pitch,49);
});
