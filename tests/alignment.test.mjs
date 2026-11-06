import test from 'node:test';import assert from 'node:assert/strict';
import {selectAlignedWindow} from '../src/core/alignment.js';
import {mapConcurrent} from '../src/core/concurrency.js';
import {setTimeout as delay} from 'node:timers/promises';
test('late introduction: choose four complete bars instead of cutting off the melody',()=>{const notes=Array.from({length:16},(_,i)=>({start:8+i*.5,end:8+i*.5+.3}));const r=selectAlignedWindow(notes,{bpm:120,bars:4,audioDuration:20,firstDownbeat:0});assert.equal(r.startSec,8);assert.equal(r.completeAudio,true)});
test('pickup remains off the downbeat rather than moving every first note onto beat one',()=>{const notes=Array.from({length:16},(_,i)=>({start:.25+i*.5,end:.5+i*.5}));assert.equal(selectAlignedWindow(notes,{bpm:120,bars:4,audioDuration:10,firstDownbeat:0}).startSec,0)});
test('generation respects concurrency and candidate order',async()=>{let active=0,max=0;const result=await mapConcurrent([0,1,2,3],2,async i=>{active++;max=Math.max(max,active);await delay(12-i*2);active--;return i});assert.equal(max,2);assert.deepEqual(result,[0,1,2,3])});
