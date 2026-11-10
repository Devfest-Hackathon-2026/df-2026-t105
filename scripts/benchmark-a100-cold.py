"""Measure VM allocation -> setup -> model load -> transcription -> download; always stop VM."""
import json
import subprocess
import time
from pathlib import Path

root=Path('out/benchmark-a100-cold');root.mkdir(parents=True,exist_ok=True)
session=f'ghostnotes-cold-{int(time.time())}'
phases={};created=False;start=time.perf_counter()
remote='''import os,time,json,subprocess,sys
os.environ['HF_TOKEN_PATH']='/content/ghostnotes-hf-token'
s=time.perf_counter()
subprocess.run([sys.executable,'-m','pip','install','-q','muscriptor'],check=True)
install=time.perf_counter()-s
import torch
from muscriptor import TranscriptionModel
s=time.perf_counter();model=TranscriptionModel.load_model('medium',device='cuda');load=time.perf_counter()-s
s=time.perf_counter();events=[]
for e in model.transcribe('/content/clip.wav'):
 if type(e).__name__=='NoteStartEvent':events.append({'type':'start','index':e.index,'pitch':e.pitch,'start_time':e.start_time,'instrument':e.instrument})
 elif type(e).__name__=='NoteEndEvent':events.append({'type':'end','end_time':e.end_time,'start_event_index':e.start_event.index})
inference=time.perf_counter()-s
result={'hardware':torch.cuda.get_device_name(0),'model':'medium','installSeconds':install,'modelLoadSeconds':load,'inferenceSeconds':inference,'events':events}
open('/content/result.json','w').write(json.dumps(result))
print(json.dumps({k:v for k,v in result.items() if k!='events'}),flush=True)
'''
(root/'remote.py').write_text(remote)
def run(label,args):
 t=time.perf_counter();print('START',label,flush=True)
 with (root/f'{label}.log').open('w') as log:subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,check=True)
 phases[label]=time.perf_counter()-t;print('DONE',label,round(phases[label],2),flush=True)
try:
 created=True
 run('allocate',['colab','new','-s',session,'--gpu','A100'])
 run('credential-upload',['colab','upload','-s',session,str(Path.home()/'.cache/huggingface/token'),'/content/ghostnotes-hf-token'])
 run('audio-upload',['colab','upload','-s',session,'out/experiment-transcription/lead-current-1.wav','/content/clip.wav'])
 run('setup-and-inference',['colab','exec','-s',session,'-f',str(root/'remote.py'),'--timeout','300'])
 run('result-download',['colab','download','-s',session,'/content/result.json',str(root/'result.json')])
 phases['totalToResultSeconds']=time.perf_counter()-start
 result=json.loads((root/'result.json').read_text());summary={**phases,**{k:v for k,v in result.items() if k!='events'},'eventCount':len(result['events'])}
 (root/'timing.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2),flush=True)
finally:
 if created:run('stop',['colab','stop','-s',session])
