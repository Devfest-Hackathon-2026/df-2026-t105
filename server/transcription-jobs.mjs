import { randomUUID } from 'node:crypto';
import { parseTranscriptionResult } from './transcription.mjs';

/** Bounded FIFO: return a job ID immediately, poll without holding the Cloudflare request open. */
export function createTranscriptionJobs({cpuUrl,a100Url,fetcher=fetch,maxQueued=3}={}){
 const jobs=new Map(),queue=[];let running=false;
 const snapshot=(j)=>({id:j.id,status:j.status,phase:j.status,backend:j.backend,model:j.backend==='cpu'?'small':'medium',...(j.status==='done'?{events:j.events,beatGrid:j.beatGrid}:{}),...(j.error?{error:j.error}:{})});
 async function drain(){
  if(running)return;running=true;
  try{while(queue.length){const j=queue.shift();
   try{
    j.status='preparing';
    const endpoint=j.backend==='cpu'?cpuUrl:a100Url;
    if(!endpoint)throw new Error('採譜先が設定されていません');
    j.status='transcribing';const form=new FormData();form.append('file',new Blob([j.body],{type:'audio/wav'}),'take.wav');form.append('detect_tempo',j.detectTempo?'best-effort':'false');for(const i of j.instruments)form.append('instruments',i);
    const r=await fetcher(`${endpoint.replace(/\/$/,'')}/transcribe`,{method:'POST',body:form,signal:AbortSignal.timeout(300000)});
    if(!r.ok)throw new Error(`MuScriptor HTTP ${r.status}`);
    const result=parseTranscriptionResult(await r.text());j.events=result.events;j.beatGrid=result.beatGrid;j.status='done';
   }catch(e){console.error('transcription job:',e.message);j.status='error';j.error=j.backend==='a100'?'A100の準備または採譜に失敗しました。時間をおいて再試行するか、設定で別の採譜先を選んでください':'MuScriptorに接続できません。採譜サーバーを確認してください'}
   finally{j.body=null;j.finishedAt=Date.now()}
  }}finally{running=false}
 }
 return {
  create(body,{backend='cpu',instruments=[],detectTempo=false}={}){
   if(!['cpu','a100'].includes(backend))throw new Error('Invalid backend');
   if(queue.length>=maxQueued)throw new Error('採譜ジョブが混み合っています。少し待って再試行してください');
   const j={id:randomUUID(),status:'queued',backend,instruments,detectTempo,body};jobs.set(j.id,j);queue.push(j);
   for(const [id,old]of jobs)if(old.finishedAt&&Date.now()-old.finishedAt>1800000)jobs.delete(id);
   queueMicrotask(drain);return snapshot(j);
  },
  get(id){const j=jobs.get(id);return j?snapshot(j):null},
 };
}
