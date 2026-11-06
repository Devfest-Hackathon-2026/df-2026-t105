"""Summaries use known MIDI for accuracy; generated audio has no ground-truth score."""
import json
import statistics
from pathlib import Path
root=Path('out/experiment-transcription')
rows=[]
for d in [root,root/'gpu-results']:
 for p in d.glob('*.json'):
  try:r=json.loads(p.read_text())
  except Exception:continue
  if isinstance(r,dict) and isinstance(r.get('notes'),list) and r.get('model') and r.get('method'):rows.append(r)

def score(ref,est,instrument=True):
 used=set();hits=0
 for e in sorted(est,key=lambda n:n['start']):
  options=[(abs(r['start']-e['start']),i) for i,r in enumerate(ref) if i not in used and r['pitch']==e['pitch'] and (not instrument or r['instrument']==e['instrument']) and abs(r['start']-e['start'])<=.05]
  if options:used.add(min(options)[1]);hits+=1
 precision=hits/len(est) if est else 0;recall=hits/len(ref) if ref else 0
 return {'precision':round(precision,3),'recall':round(recall,3),'f1':round(2*precision*recall/(precision+recall),3) if precision+recall else 0,'hits':hits,'referenceNotes':len(ref),'estimatedNotes':len(est)}
controls=[]
for r in rows:
 refpath=root/f"{r['id']}.reference.json"
 if not refpath.exists():continue
 ref=json.loads(refpath.read_text());target=r['expectedInstrument'];ref_target=[n for n in ref if n['instrument']==target];est_target=[n for n in r['notes'] if n['instrument']==target]
 controls.append({k:r[k] for k in ['id','model','method','seconds']}|{'target':score(ref_target,est_target),'allInstruments':score(ref,r['notes']),'pitchWithoutInstrument':score(ref,r['notes'],False)})
parity=[]
for c in rows:
 if c['model']!='small-cpu' or c['method'].startswith('stem-'):continue
 g=next((g for g in rows if g['id']==c['id'] and g['method']==c['method'] and g['model']=='small-a100'),None)
 if not g:continue
 norm=lambda notes:sorted([(n['instrument'],n['pitch'],round(n['start'],4),round(n['end'],4)) for n in notes])
 parity.append({'id':c['id'],'method':c['method'],'identicalNotes':norm(c['notes'])==norm(g['notes']),'cpuSeconds':c['seconds'],'a100Seconds':g['seconds']})
separation=[]
for task in json.loads((root/'plan.json').read_text())['tasks']:
 if task['treatment']=='known-midi':continue
 file=root/'gpu-results'/f"{task['id']}.stems"/'stats.json'
 if not file.exists():file=root/f"{task['id']}.stems"/'stats.json'
 if file.exists():separation.append({'id':task['id'],'role':task['role'],'treatment':task['treatment'],**json.loads(file.read_text())})
summary={'schema':1,'onsetToleranceSeconds':.05,'accuracyDefinition':'Exact MIDI pitch and onset within 50 ms; instrument identity also required except pitchWithoutInstrument; no offset criterion.','generatedAudioWarning':'No reference MIDI. Instrument labels and stem energy are estimates, not ground truth. Two independent draws per role/treatment, no shared random seed; exploratory only.','controls':controls,'cpuGpuParity':parity,'separation':separation,'timings':{model:{method:{'meanSeconds':round(statistics.mean([r['seconds'] for r in rows if r['model']==model and r['method']==method and not r['id'].startswith('known-')]),2)} for method in sorted({r['method'] for r in rows if r['model']==model and not r['id'].startswith('known-')})} for model in sorted({r['model'] for r in rows})}}
root.joinpath('summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps({'rows':len(rows),'controls':len(controls),'parity':parity,'timings':summary['timings']},indent=2))
