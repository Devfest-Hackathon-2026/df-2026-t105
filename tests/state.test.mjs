import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync(new URL('../src/state.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const state=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('new projects have an empty target without unrelated demo accompaniment',()=>{
 const p=state.demoProject();assert.deepEqual(Object.keys(p.tracks),['lead']);assert.deepEqual(p.tracks.lead.notes,[]);
});
test('loading removes exact demo backing while preserving edited and detected tracks',()=>{
 const drums=[];for(let s=0;s<64;s++){if(s%4===0)drums.push({step:s,len:1,pitch:36,vel:.9});if(s%8===4)drums.push({step:s,len:1,pitch:38,vel:.8});if(s%2===0)drums.push({step:s,len:1,pitch:42,vel:s%4===2?.6:.35})}
 const p=state.demoProject();p.tracks.drums={id:'drums',name:'Drums',notes:drums};p.tracks.bass={id:'bass',name:'Bass',notes:[{step:0,len:3,pitch:40,vel:.8}]};p.tracks['part:drums']={id:'part:drums',name:'ドラム',instrument:'drums',notes:drums};
 globalThis.localStorage={getItem:()=>JSON.stringify(p)};
 try{const loaded=state.load();assert(!loaded.tracks.drums);assert.deepEqual(loaded.tracks.bass.notes,p.tracks.bass.notes);assert(loaded.tracks['part:drums']);}finally{delete globalThis.localStorage}
});
test('content extent follows notes and proposed regions, independently of the viewport or old song boundary',()=>{
 const p=state.demoProject();p.bars=8;assert.equal(state.contentBars(p),1);
 const n={step:1600.25,len:.5,pitch:38,vel:.8};p.tracks.lead.notes.push(n);assert.equal(state.contentBars(p),101);
 n.step=32;n.len=17;assert.equal(state.contentBars(p),4);
 p.tracks.lead.notes=[];assert.equal(state.contentBars(p),1);
 p.tracks.lead.ghost={startStep:512,bars:4,notes:[]};assert.equal(state.contentBars(p),36);
});
test('loading migrates legacy synth presets and English placeholder names to SoundFont presets',()=>{
 const p=state.demoProject();
 p.tracks.lead={id:'lead',name:'Lead',preset:'soft',notes:[],mute:false,ghost:null};
 p.tracks.bass={id:'bass',name:'Bass',preset:'pluck',notes:[{step:0,len:2,pitch:40,vel:.8}],mute:false,ghost:null};
 globalThis.localStorage={getItem:()=>JSON.stringify(p)};
 try{
  const loaded=state.load();
  assert.equal(loaded.tracks.lead.preset,'sf:89');
  assert.equal(loaded.tracks.lead.name,'ピアノ');
  assert.equal(loaded.tracks.bass.preset,'sf:45');
  assert.equal(loaded.tracks.bass.name,'エレキベース');
 }finally{delete globalThis.localStorage}
});
