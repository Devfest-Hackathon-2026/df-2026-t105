# Colab の GPU で muscriptor（small / medium / large）を動かし、評価用の音源を採譜する。
# 使い方（Colab CLI）: 音源と HF のトークンを渡して実行し、mus_out/ の JSON を持ち帰る。
#   colab run --gpu A100 scripts/colab_muscriptor.py
# 前提: 同じ作業ディレクトリに clips/*.wav と hf_token.txt（HuggingFace の Read トークン）があること。
#       結果は mus_out/<音源名>.<モデル>.json と mus_out/timing.json に出る。
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# 音源名 → muscriptor の楽器名（scripts/eval-mus.sh と同じ対応）
INSTRUMENTS = {
    "flute_C100_a": "flutes", "flute_C100_b": "flutes", "ocarina_F110": "flutes",
    "square_D120": "synth_lead", "marimba_C100": "chromatic_percussion",
    "ebass_F110": "electric_bass", "uprightbass_D120": "acoustic_bass", "synthbass_C100": "electric_bass",
}
MODELS = [a for a in sys.argv[1:] if a in ("small", "medium", "large")] or ["small", "medium", "large"]

def sh(*args):
    print("+", " ".join(args), flush=True)
    subprocess.run(args, check=True)

token_file = Path("hf_token.txt")
if token_file.exists():
    os.environ["HF_TOKEN"] = token_file.read_text().strip()
sh(sys.executable, "-m", "pip", "install", "-q", "muscriptor")

from muscriptor import TranscriptionModel  # noqa: E402

out = Path("mus_out")
out.mkdir(exist_ok=True)
timing = {}
for size in MODELS:
    t0 = time.time()
    model = TranscriptionModel.load_model(size)
    timing[f"{size}:load"] = round(time.time() - t0, 1)
    for wav in sorted(Path("clips").glob("*.wav")):
        name = wav.stem
        inst = INSTRUMENTS.get(name)
        t1 = time.time()
        events = []
        for ev in model.transcribe(str(wav), instruments=[inst] if inst else None):
            kind = type(ev).__name__
            if kind == "NoteStartEvent":
                events.append({"type": "start", "pitch": ev.pitch, "start_time": ev.start_time, "index": ev.index, "instrument": ev.instrument})
            elif kind == "NoteEndEvent":
                events.append({"type": "end", "end_time": ev.end_time, "start_event_index": ev.start_event.index})
        timing[f"{size}:{name}"] = round(time.time() - t1, 2)
        (out / f"{name}.{size}.json").write_text(json.dumps(events))
        print(size, name, len(events), "events", timing[f"{size}:{name}"], "s", flush=True)
    del model
(out / "timing.json").write_text(json.dumps(timing, indent=1))
print(json.dumps(timing, indent=1))
