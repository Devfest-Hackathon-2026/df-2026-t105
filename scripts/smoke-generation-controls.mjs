import {chromium} from 'playwright';import assert from 'node:assert/strict';import {readFileSync,mkdirSync} from 'node:fs';
const origin=process.argv[2]??'http://127.0.0.1:8787';const audio=readFileSync('out/experiment-transcription/known-mixture.wav').toString('base64');const ref=JSON.parse(readFileSync('out/experiment-transcription/known-mixture.reference.json'));const events=ref.flatMap((n,i)=>[{type:'start',index:i,pitch:n.pitch,start_time:n.start,instrument:n.instrument},{type:'end',start_event_index:i,end_time:n.end}]);mkdirSync('out/smoke-generation-controls',{recursive:true});
const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
try{const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let active=0,maximum=0,total=0;
 await page.route('**/api/config',r=>r.fulfill({json:{realtime:true,musicModels:{'lyria-3.5':'lyria-3.5'},transcribers:{cpu:true,a100:false}}}));
 await page.route('**/api/gemini/**',r=>r.fulfill({json:{candidates:[{content:{parts:[{text:JSON.stringify({candidates:Array.from({length:4},(_,i)=>({title:`案${i+1}`,prompts:[{text:'solo flute',weight:1}],density:.4,brightness:.5,guidance:4,rationale:''}))})}]}}]}}));
 await page.route('**/api/music/**',async r=>{active++;total++;maximum=Math.max(maximum,active);await new Promise(res=>setTimeout(res,150));active--;await r.fulfill({json:{audio,mime:'audio/wav',text:'',model:'fixture'}})});
 await page.route('**/api/transcription-jobs?**',r=>r.fulfill({status:202,json:{id:'fixture-job',status:'queued'}}));
 await page.route('**/api/transcription-jobs/fixture-job',r=>r.fulfill({json:{id:'fixture-job',status:'done',events,beatGrid:{bpm:120,first_downbeat:.5,beats_per_bar:4,onset_delay:0,steady:true}}}));
 await page.goto(origin);assert.equal(await page.locator('.track').count(),1,'no demo backing on first open');assert.equal(await page.isChecked('#monitor'),false);
 for(const concurrency of [1,2,4]){
  await page.selectOption('#candidateCount','4');await page.selectOption('#generationConcurrency',String(concurrency));maximum=0;total=0;
  await page.click('#ask');await page.waitForFunction(()=>document.querySelector('#ask').disabled===false);
  assert.equal(total,4);assert.equal(maximum,concurrency);assert((await page.textContent('#status')).includes('4案が届きました'),await page.textContent('#status'));
 }
 assert.equal(await page.locator('.track').count(),3,'only detected parts, no demo backing');
 assert.equal(await page.textContent('#rollTitle'),'フルート');assert((await page.textContent('#ghostSummary')).includes('4/4'));
 assert.equal(await page.evaluate(()=>document.querySelector('#previewAudio').paused),true,'no autoplay');
 await page.locator('#previewAudio').evaluate(a=>a.play());await page.waitForTimeout(250);assert.equal(await page.locator('#previewAudio').evaluate(a=>a.paused),false);
 await page.click('#previewStop');assert.equal(await page.locator('#previewAudio').evaluate(a=>a.paused),true);assert.equal(await page.locator('#previewAudio').evaluate(a=>a.currentTime),0);
 await page.selectOption('#previewTake','3');assert.equal(await page.locator('#previewAudio').evaluate(a=>a.paused),true);
 await page.click('#acceptAll');const p=await page.evaluate(()=>JSON.parse(localStorage.getItem('ghostnotes.project.v1')));assert(p.tracks.lead.notes.length>0);assert(!p.tracks['part:flutes']);
 assert.equal(await page.locator('#importOtherParts').count(),0);
 await page.selectOption('#target','part:electric_bass');await page.selectOption('#candidateCount','1');total=0;await page.click('#ask');await page.waitForFunction(()=>document.querySelector('#ask').disabled===false);assert.equal(await page.textContent('#rollTitle'),'エレキベース');assert.equal(total,1);assert.equal(await page.locator('.track').count(),3,'reuse existing detected instruments when generating for another target');
 for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:`out/smoke-generation-controls/${width}.png`,fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))}
 assert.deepEqual(errors,[]);console.log('PASS silent default, native playback/stop, 1/2/4 concurrent jobs, 4 candidates, chosen existing track, 4-bar alignment, detected instrument arrangement, dynamic target, mobile layout');
}finally{await browser.close()}
