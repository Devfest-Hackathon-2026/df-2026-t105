"""Demucs baseline using existing torch, soundfile I/O; never alter source audio."""
import sys, json, time
from pathlib import Path
import numpy as np
import torch
import soundfile as sf
from demucs.pretrained import get_model
from demucs.apply import apply_model

torch.set_num_threads(4)
out = Path(sys.argv[1] if len(sys.argv) > 1 else 'out/experiment-transcription')
t0 = time.time()
model = get_model('htdemucs').cpu().eval()
print('MODEL READY', round(time.time()-t0, 2), flush=True)
for task in json.loads((out/'plan.json').read_text())['tasks']:
    source = out/f"{task['id']}.wav"
    if not source.exists(): continue
    dest = out/f"{task['id']}.stems"
    if (dest/'stats.json').exists(): continue
    dest.mkdir(exist_ok=True)
    audio, sr = sf.read(source, dtype='float32', always_2d=True)
    if sr != model.samplerate: raise ValueError(f'{sr} != {model.samplerate}')
    wav = torch.from_numpy(audio.T.copy())
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std().clamp_min(1e-8)
    begin = time.time()
    with torch.no_grad():
        parts = apply_model(model, ((wav-mean)/std)[None], device='cpu', shifts=0, split=True, overlap=0.25, progress=False, num_workers=0)[0]
    parts = parts*std + mean
    rms = {}
    for name, part in zip(model.sources, parts):
        data = part.T.numpy()
        sf.write(dest/f'{name}.wav', data, sr, subtype='FLOAT')
        rms[name] = float(np.sqrt(np.mean(data**2)))
    total = sum(v*v for v in rms.values())
    stats = {'model':'htdemucs', 'seconds':time.time()-begin, 'rms':rms, 'energyShare':{k:v*v/max(total,1e-12) for k,v in rms.items()}, 'warning':'Stem energy is separator attribution, not ground truth leakage.'}
    (dest/'stats.json').write_text(json.dumps(stats,indent=2))
    print(task['id'], json.dumps(stats), flush=True)
