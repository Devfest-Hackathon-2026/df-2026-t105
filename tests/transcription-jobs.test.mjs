import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptionJobs } from '../server/transcription-jobs.mjs';
import { setTimeout as delay } from 'node:timers/promises';
test('jobs return immediately and run serially, retaining every instrument',async()=>{
 let active=0,max=0;
 const fetcher=async()=>{active++;max=Math.max(max,active);await delay(10);active--;return new Response('data: {"type":"start","index":0,"pitch":60,"start_time":0,"instrument":"acoustic_piano"}\n\ndata: {"type":"transcription_complete"}\n\n')};
 const jobs=createTranscriptionJobs({cpuUrl:'http://worker',fetcher});
 const a=jobs.create(new Uint8Array([1]),{backend:'cpu'}),b=jobs.create(new Uint8Array([2]),{backend:'cpu'});
 assert.equal(a.status,'queued');assert.equal(b.status,'queued');
 for(let i=0;i<100&&jobs.get(b.id).status!=='done';i++)await delay(5);
 assert.equal(jobs.get(a.id).events[0].instrument,'acoustic_piano');assert.equal(jobs.get(b.id).status,'done');assert.equal(max,1);
});
test('failed or truncated upstream output is an error, not an empty successful transcription',async()=>{
 const jobs=createTranscriptionJobs({cpuUrl:'http://worker',fetcher:async()=>new Response('data: {"type":"progress"}\n')});
 const j=jobs.create(new Uint8Array([1]),{backend:'cpu'});
 for(let i=0;i<100&&jobs.get(j.id).status!=='error';i++)await delay(5);
 assert.equal(jobs.get(j.id).status,'error');assert.equal(jobs.get(j.id).events,undefined);
});
