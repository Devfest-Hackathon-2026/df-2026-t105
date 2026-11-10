#!/usr/bin/env bash
# Colab の GPU で採譜した muscriptor（small / medium / large）の結果を、eval-mus.sh と同じ指標で採点する。
# 入力: out/colab/mus_out/<音源名>.<モデル>.json（colab_muscriptor.py の出力）
# 出力: out/muscmp-gpu/results.jsonl
# usage: bash scripts/eval-mus-gpu.sh
set -u
cd "$(dirname "$0")/.."
D=out/muscmp-gpu; mkdir -p "$D"
MUS_OUT=out/colab/mus_out
# name|bpm|root|role|instrument(muscriptor の楽器名)
SPECS=(
  "flute_C100_a|100|C|lead|flutes" "flute_C100_b|100|C|lead|flutes" "ocarina_F110|110|F|lead|flutes"
  "square_D120|120|D|lead|synth_lead" "marimba_C100|100|C|lead|chromatic_percussion"
  "ebass_F110|110|F|bass|electric_bass" "uprightbass_D120|120|D|bass|acoustic_bass" "synthbass_C100|100|C|bass|electric_bass"
)
: > "$D/results.jsonl"
for spec in "${SPECS[@]}"; do
  IFS='|' read -r name bpm root role inst <<<"$spec"
  for m in small medium large; do
    b="$D/${name}__${m}-gpu"
    ln -sf "$(realpath out/eval/$name.wav)" "$b.wav"
    node scripts/mus2raw.mjs "$MUS_OUT/${name}.${m}.json" "$b.json" > /dev/null
    g=$(node scripts/ghost-render.mjs "$b" --bpm "$bpm" --root "$root" --role "$role" | head -1)
    mt=$(uv run -q --with librosa==0.11.0 python scripts/match.py "$b" 2>/dev/null | tail -1)
    node -e "const g=$g,m=$mt;console.log(JSON.stringify({name:'$name',method:'${m}-gpu',sec:null,raw:g.rawNotes,notes:g.ghostNotes,chroma:m.chroma_match,chromaShift:m.baseline_shift1beat,onsetF1:m.onset_f1,onsetF1Random:m.onset_f1_random_grid}))" >> "$D/results.jsonl"
  done
done
echo done
