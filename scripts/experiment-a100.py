"""A100 batch: generated experiment clips only, instrument labels and timings preserved."""
import os
os.environ['HF_TOKEN_PATH'] = '/content/ghostnotes-hf-token'
import dataclasses
import json
import subprocess
import sys
import time
import zipfile
from pathlib import Path
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'muscriptor', 'demucs'], check=True)
import numpy as np
import soundfile as sf
import torch
from demucs.pretrained import get_model
from demucs.apply import apply_model
from muscriptor import TranscriptionModel

root=Path('/content/experiment');root.mkdir(exist_ok=True)
with zipfile.ZipFile('/content/experiment-input.zip') as z:z.extractall(root)
plan=json.loads((root/'plan.json').read_text())
results=root/'gpu-results';results.mkdir(exist_ok=True)
print('GPU',torch.cuda.get_device_name(0),flush=True)
torch.set_num_threads(4)
model=get_model('htdemucs').cuda().eval()
for task in plan['tasks']:
    name=task['id'];dest=results/f'{name}.stems';dest.mkdir(exist_ok=True)
    audio,sr=sf.read(root/f'{name}.wav',dtype='float32',always_2d=True)
    wav=torch.from_numpy(audio.T.copy()).cuda();ref=wav.mean(0);mean,std=ref.mean(),ref.std().clamp_min(1e-8)
    start=time.time()
    with torch.no_grad():parts=apply_model(model,((wav-mean)/std)[None],device='cuda',shifts=0,split=True,overlap=.25,progress=False)[0]
    parts=(parts*std+mean).cpu();rms={}
    for kind,part in zip(model.sources,parts):
        data=part.T.numpy();sf.write(dest/f'{kind}.wav',data,sr,subtype='FLOAT');rms[kind]=float(np.sqrt(np.mean(data**2)))
    energy=sum(v*v for v in rms.values())
    (dest/'stats.json').write_text(json.dumps({'model':'htdemucs','device':'A100','seconds':time.time()-start,'rms':rms,'energyShare':{k:v*v/max(energy,1e-12) for k,v in rms.items()}}))
    print('SEPARATED',name,round(time.time()-start,2),flush=True)
del model;torch.cuda.empty_cache()
for size in ['small','medium','large']:
    started=time.time();model=TranscriptionModel.load_model(size,device='cuda')
    print('LOADED',size,round(time.time()-started,2),flush=True)
    for task in plan['tasks']:
        name=task['id']
        for method in ['constrained','multitrack','stem-constrained','stem-multitrack','multitrack-conditioned']:
            dest=results/f'{name}.{size}.{method}.json'
            if dest.exists():continue
            file=results/f'{name}.stems'/('bass.wav' if task['role']=='bass' else 'other.wav') if method.startswith('stem-') else root/f'{name}.wav'
            instruments=[task['instrument']] if method in ['constrained','stem-constrained'] else ['flutes','electric_bass','drums'] if method=='multitrack-conditioned' else None
            start=time.time();events=[]
            try:
                for ev in model.transcribe(str(file),instruments=instruments):
                    if type(ev).__name__=='NoteStartEvent':events.append({'type':'start','index':ev.index,'pitch':ev.pitch,'start_time':ev.start_time,'instrument':ev.instrument})
                    elif type(ev).__name__=='NoteEndEvent':events.append({'type':'end','end_time':ev.end_time,'start_event_index':ev.start_event.index})
                starts={e['index']:e for e in events if e['type']=='start'};notes=[]
                for e in events:
                    if e['type']!='end':continue
                    s=starts.get(e['start_event_index'])
                    if s and e['end_time']>s['start_time']:notes.append({'instrument':s['instrument'],'pitch':s['pitch'],'start':s['start_time'],'end':e['end_time']})
                notes.sort(key=lambda n:n['start']);groups={}
                for n in notes:
                    g=groups.setdefault(n['instrument'],{'notes':0,'duration':0,'range':[127,0]});g['notes']+=1;g['duration']+=n['end']-n['start'];g['range']=[min(g['range'][0],n['pitch']),max(g['range'][1],n['pitch'])]
                row={'id':name,'role':task['role'],'treatment':task['treatment'],'draw':task['draw'],'expectedInstrument':task['instrument'],'method':method,'model':size+'-a100','seconds':time.time()-start,'totalNotes':len(notes),'targetNotes':sum(n['instrument']==task['instrument'] for n in notes),'otherNotes':sum(n['instrument']!=task['instrument'] for n in notes),'groups':groups,'notes':notes,'events':events}
                dest.write_text(json.dumps(row))
                print('DONE',name,size,method,len(notes),round(time.time()-start,2),flush=True)
            except Exception as e:
                dest.with_suffix('.error.json').write_text(json.dumps({'error':str(e)}));print('ERROR',name,size,method,str(e),flush=True)
    del model;torch.cuda.empty_cache()
    with zipfile.ZipFile(f'/content/results-{size}.zip','w',zipfile.ZIP_DEFLATED) as z:
        for file in results.rglob('*'):
            if file.is_file():z.write(file,file.relative_to(results))
    print('CHECKPOINT',size,flush=True)
print('ALL DONE',flush=True)
