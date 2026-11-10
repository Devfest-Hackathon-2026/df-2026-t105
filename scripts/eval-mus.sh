#!/usr/bin/env bash
# muscriptor（small / medium）と basic-pitch の耳コピを、同じ Lyria の音源で比べる。結果は out/muscmp/results.jsonl
# usage: bash scripts/eval-mus.sh   （HuggingFace でライセンスに同意し、hf auth login 済みであること）
set -u
cd "$(dirname "$0")/.."
D=out/muscmp; mkdir -p "$D"
MUS=~/src/muscriptor
# name|bpm|root|role|instrument(muscriptor の楽器名)
SPECS=(
  "flute_C100_a|100|C|lead|flutes" "flute_C100_b|100|C|lead|flutes" "ocarina_F110|110|F|lead|flutes"
  "square_D120|120|D|lead|synth_lead" "marimba_C100|100|C|lead|chromatic_percussion"
  "ebass_F110|110|F|bass|electric_bass" "uprightbass_D120|120|D|bass|acoustic_bass" "synthbass_C100|100|C|bass|electric_bass"
)
: > "$D/results.jsonl"
for spec in "${SPECS[@]}"; do
  IFS='|' read -r name bpm root role inst <<<"$spec"
  src="out/eval/$name"
  for m in bp small medium; do
    b="$D/${name}__$m"
    ln -sf "$(realpath $src.wav)" "$b.wav"
    if [ "$m" = bp ]; then cp "$src.json" "$b.json"; secs=null
    else
      s=$(date +%s)
      (cd $MUS && uv run -q muscriptor transcribe "$(realpath ~/ghostnotes/$b.wav)" --model $m --device cpu --instruments $inst --format json -o "$(realpath -m ~/ghostnotes/$b.mus.json)") > "$b.log" 2>&1
      secs=$(( $(date +%s) - s ))
      node scripts/mus2raw.mjs "$b.mus.json" "$b.json" > /dev/null
    fi
    g=$(node scripts/ghost-render.mjs "$b" --bpm "$bpm" --root "$root" --role "$role" | head -1)
    mt=$(uv run -q --with librosa==0.11.0 python scripts/match.py "$b" 2>/dev/null | tail -1)
    node -e "const g=$g,m=$mt;console.log(JSON.stringify({name:'$name',method:'$m',sec:$secs,raw:g.rawNotes,notes:g.ghostNotes,chroma:m.chroma_match,chromaShift:m.baseline_shift1beat,onsetF1:m.onset_f1,onsetF1Random:m.onset_f1_random_grid}))" >> "$D/results.jsonl"
  done
done
echo done
