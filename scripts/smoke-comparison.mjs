import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const url=process.argv[2]??'http://127.0.0.1:8899/';
mkdirSync('out/smoke-comparison',{recursive:true});
const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',(e)=>errors.push(e.message));
 await page.goto(url);await page.waitForFunction(()=>!document.querySelector('#play').disabled);
 assert.equal(await page.locator('#trials button').count(),8);
 assert.equal(await page.inputValue('#experiment'),'models');
 const modelLabels=await page.locator('#variants').innerText();
 for(const name of ['MuScriptor large','MuScriptor medium','MuScriptor small'])assert(modelLabels.includes(name),`missing model comparison ${name}`);
 assert.equal(await page.locator('#conditions').getAttribute('open'),null);
 await page.click('#play');await page.waitForTimeout(700);assert.equal(await page.getAttribute('#play','aria-pressed'),'true');
 await page.locator('#variants button').nth(1).click();assert.equal(await page.getAttribute('#play','aria-pressed'),'true');
 assert(Number(await page.inputValue('#seek'))>.4,'switch keeps current position');
 await page.click('#play');await page.locator('#winner input').first().check();await page.fill('#comment','音程はA、リズムはBが近い');
 await page.reload();await page.waitForFunction(()=>!document.querySelector('#play').disabled);
 assert.equal(await page.inputValue('#comment'),'音程はA、リズムはBが近い');assert.equal(await page.locator('#winner input:checked').count(),1);
 const [download]=await Promise.all([page.waitForEvent('download'),page.click('#export')]);await download.saveAs('out/smoke-comparison/ratings.json');
 await page.selectOption('#experiment','transcription');await page.waitForFunction(()=>!document.querySelector('#play').disabled);
 assert.equal(await page.locator('#variants button').count(),6);
 assert.equal(await page.locator('#settingLabel').textContent(),'採譜モデル');
 await page.selectOption('#experiment','prompt');await page.waitForFunction(()=>!document.querySelector('#play').disabled);
 assert.equal(await page.locator('#trials button').count(),4);assert.equal(await page.locator('#variants button').count(),2);
 await page.selectOption('#experiment','transcription');await page.waitForFunction(()=>!document.querySelector('#play').disabled);
 await page.selectOption('#experiment','models');await page.waitForFunction(()=>!document.querySelector('#play').disabled);
 await page.click('#conditions summary');assert(await page.locator('#conditionBody').isVisible());
 for(const theme of ['light','dark']){await page.emulateMedia({colorScheme:theme});for(const width of [1440,768,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:`out/smoke-comparison/${theme}-${width}.png`,fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow ${width}`)}}
 assert.deepEqual(errors,[]);console.log('PASS model comparison is default and named, methods are separate, 8 sources, blind conditions, real playback, switching position, ratings persistence/export, prompt comparison, 3 widths x 2 themes, no page errors');
}finally{await browser.close()}
