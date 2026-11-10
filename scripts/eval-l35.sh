#!/usr/bin/env bash
# 非リアルタイムの Lyria（3.5 と 3 Clip）が、プロンプトで伝えたテンポ・キー・長さをどれくらい守るかを測る。
# 結果は out/l35eval/results.jsonl。生成に失敗したら3回まで試す。
# usage: bash scripts/eval-l35.sh
set -u
cd "$(dirname "$0")/.."
D=out/l35eval
mkdir -p "$D"
# name|model|style|inst|root(相対長調の主音)|keyname|scale-notes|bpm
SPECS=(
  "l35plain_flute_A100|lyria-3.5|plain|flute|C|A minor|A natural minor|100"
  "l35ts_flute_A100|lyria-3.5|ts|flute|C|A minor|A natural minor|100"
  "clip_flute_A100|lyria-3-clip-preview|plain|flute|C|A minor|A natural minor|100"
  "l35plain_ocarina_D110|lyria-3.5|plain|ocarina|F|D minor|D natural minor|110"
  "l35ts_ocarina_D110|lyria-3.5|ts|ocarina|F|D minor|D natural minor|110"
  "clip_ocarina_D110|lyria-3-clip-preview|plain|ocarina|F|D minor|D natural minor|110"
  "l35plain_bass_G120|lyria-3.5|plain|synth bass|G|G major|G major|120"
  "l35ts_bass_G120|lyria-3.5|ts|synth bass|G|G major|G major|120"
  "clip_bass_G120|lyria-3-clip-preview|plain|synth bass|G|G major|G major|120"
)
prompt() {
  local style=$1 inst=$2 key=$3 notes=$4 bpm=$5
  local line="single-note melody"
  [ "$inst" = "synth bass" ] && line="single-note bassline"
  if [ "$style" = ts ]; then
    echo "[0:00 - 0:20] A short loop: solo $inst playing a simple $line, dry, no reverb, no accompaniment, no drums, no chords, no other instruments. Strict steady tempo of $bpm BPM in 4/4, key of $key using only the notes of $notes. Instrumental only, no vocals. The track ends at 0:20."
  else
    echo "Solo $inst playing a simple $line. Dry, no reverb, no accompaniment, no drums, no chords, no other instruments. Tempo exactly $bpm BPM, key of $key, 4/4. Instrumental only, no vocals. About 20 seconds long."
  fi
}
gen() {
  IFS='|' read -r name model style inst root key notes bpm <<<"$1"
  [ -s "$D/$name.wav" ] && return
  for i in 1 2 3; do
    node --env-file=.env scripts/lyria-gen.mjs "$model" "$D/$name.wav" "$(prompt "$style" "$inst" "$key" "$notes" "$bpm")" > "$D/$name.gen.json" 2>&1
    [ -s "$D/$name.wav" ] && return
    sleep 3
  done
}
i=0
for s in "${SPECS[@]}"; do gen "$s" & i=$((i+1)); (( i % 3 == 0 )) && wait; done
wait
echo generated
: > "$D/results.jsonl"
analyze() {
  IFS='|' read -r name model style inst root key notes bpm <<<"$1"
  local b="$D/$name"
  [ -s "$b.wav" ] || { echo "{\"name\":\"$name\",\"error\":\"no audio\"}"; return; }
  local dur; dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$b.wav")
  local ms; ms=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$b.gen.json','utf8').trim().split('\n').pop()).ms)}catch{console.log(null)}")
  local tp; tp=$(uv run -q --with librosa==0.11.0 python scripts/tempo.py "$b.wav" "$bpm" 2>/dev/null | tail -1)
  [ -s "$b.tr.json" ] || node scripts/transcribe.mjs "$b.wav" --bpm "$bpm" --scale "$root" --json "$b.json" 2>/dev/null | tail -1 > "$b.tr.json"
  node -e "const t=$tp,a=$(cat "$b.tr.json");console.log(JSON.stringify({name:'$name',model:'$model',style:'$style',bpm:$bpm,root:'$root',genMs:$ms,durationSec:+(+'$dur').toFixed(1),estBpm:t.librosa_bpm,beatStdMs:t.beat_interval_ms_std,inScale:a.inScaleRatio,rawNotes:a.notes,maxPoly:a.maxPolyphony}))"
}
i=0
for s in "${SPECS[@]}"; do analyze "$s" >> "$D/results.jsonl" & i=$((i+1)); (( i % 2 == 0 )) && wait; done
wait
echo done
