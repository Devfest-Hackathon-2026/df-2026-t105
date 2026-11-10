// Exercise real DAW import/edit/export with a known three-instrument transcription.
import {chromium} from 'playwright';import assert from 'node:assert/strict';import {readFileSync,mkdirSync} from 'node:fs';
const url=process.argv[2]??'http://127.0.0.1:8788';const reference=JSON.parse(readFileSync('out/experiment-transcription/known-mixture.reference.json'));const events=reference.flatMap((n,i)=>[{type:'start',index:i,instrument:n.instrument,pitch:n.pitch,start_time:n.start},{type:'end',start_event_index:i,end_time:n.end}]);
const rawAudio=readFileSync('out/experiment-transcription/known-mixture.wav').toString('base64');
const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});mkdirSync('out/smoke-multitrack',{recursive:true});
try{const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/config',r=>r.fulfill({json:{realtime:true,musicModels:{'lyria-3.5':'lyria-3.5'},transcribers:{cpu:true,a100:true},transcription:{default:'a100'}}}));
 await page.route('**/api/transcription/warmup',r=>r.fulfill({status:202,json:{phase:'ready'}}));
 await page.route('**/api/gemini/**',r=>r.fulfill({json:{candidates:[{content:{parts:[{text:JSON.stringify({candidates:[{title:'フルート',prompts:[{text:'solo flute',weight:1}],density:.4,brightness:.5,guidance:4,rationale:''}]})}]}}]}}));
 await page.route('**/api/music/**',r=>r.fulfill({json:{audio:rawAudio,mime:'audio/wav',text:'',model:'fixture'}}));
 await page.route('**/api/transcription-jobs?**',r=>r.fulfill({status:202,json:{id:'test-job',status:'queued'}}));
 await page.route('**/api/transcription-jobs/test-job',r=>r.fulfill({json:{id:'test-job',status:'done',events,model:'small',beatGrid:{bpm:120,first_downbeat:.5,beats_per_bar:4,steady:true,onset_delay:0}}}));
 await page.goto(url);await page.click('#play');await page.waitForFunction(()=>document.querySelector('#play').getAttribute('aria-pressed')==='true',{timeout:60000});await page.click('#play');await page.fill('#intent','フルートを足す');await page.uncheck('#monitor');await page.click('#ask');await page.waitForFunction(()=>document.querySelector('#ask').disabled===false);
 assert((await page.textContent('#status')).includes('3パート'),await page.textContent('#status'));
 assert.equal(await page.locator('.track').count(),3);
 for(const name of ['フルート','エレキベース','ドラム'])assert((await page.locator('#tracks').innerText()).includes(name));
 const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('ghostnotes.project.v1')));
 for(const i of [0,1,2]){await page.locator('.track-name').nth(i).click();await page.click('#acceptAll')}
 const p=await stored();assert(p.tracks.lead.notes.length>0);assert(p.tracks['part:electric_bass'].notes.length>0);assert(p.tracks['part:drums'].notes.length>0);
 const [download]=await Promise.all([page.waitForEvent('download'),page.click('#exportMidi')]);await download.saveAs('out/smoke-multitrack/parts.mid');const midi=readFileSync('out/smoke-multitrack/parts.mid');assert.equal(midi.readUInt16BE(10),4);
 await page.click('#play');await page.waitForFunction(()=>document.querySelector('#play').getAttribute('aria-pressed')==='true',{timeout:60000});await page.click('#play');
 const [wav]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.click('#exportWav')]);await wav.saveAs('out/smoke-multitrack/parts.wav');
 await page.reload();assert.equal(await page.locator('.track').count(),3);assert((await stored()).tracks.lead.notes.length>0);await page.screenshot({path:'out/smoke-multitrack/daw.png'});assert.deepEqual(errors,[]);
 console.log('PASS three separate editable parts, simultaneous notes retained, playback, 4 MIDI tracks, WAV export, reload persistence');
}finally{await browser.close()}
