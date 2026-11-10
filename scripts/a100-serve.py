"""Start MuScriptor on a private Colab runtime (scripts/a100.mjs)."""
import os
import subprocess
import sys
from pathlib import Path

subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'muscriptor'], check=True)
env = {**os.environ, 'HF_TOKEN_PATH': '/content/ghostnotes-hf-token'}
model = Path('/content/ghostnotes-model.txt').read_text().strip()
if model not in ('small', 'medium', 'large'):
    raise ValueError('Unsupported model')
log = open('/content/ghostnotes-muscriptor.log', 'a')
process = subprocess.Popen(
    [sys.executable, '-m', 'muscriptor', 'serve', '--device', 'cuda', '--model', model, '--port', '8222'],
    stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True,
)
print(f'MuScriptor starting: pid={process.pid}, model={model}', flush=True)
