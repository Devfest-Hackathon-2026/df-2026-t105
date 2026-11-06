#!/usr/bin/env bash
# 楽器・キー・BPM を変えて Lyria に弾かせ、耳コピの一致度とテンポを測る。結果は out/eval/results.jsonl
# usage: bash scripts/eval-batch.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p out/eval
R="node --env-file=.env scripts/lyria-rt.mjs"
SC='{"C":"C_MAJOR_A_MINOR","D":"D_MAJOR_B_MINOR","F":"F_MAJOR_D_MINOR","G":"G_MAJOR_E_MINOR"}'
scale() { node -e "console.log(($SC)['$1'])"; }
# name|role|root|bpm|prompt
MEL=(
  "flute_C100_a|lead|C|100|solo monophonic dry flute, lyrical melody, single notes"
  "flute_C100_b|lead|C|100|solo monophonic dry flute, lyrical melody, single notes"
  "clarinet_G90|lead|G|90|solo monophonic dry clarinet, gentle melody, single notes"
  "square_D120|lead|D|120|solo monophonic dry square-wave synth lead, catchy melody, single notes"
  "ocarina_F110|lead|F|110|solo monophonic dry ocarina, folk melody, single notes"
  "marimba_C100|lead|C|100|solo monophonic dry marimba, simple melody, single notes"
  "synthbass_C100|bass|C|100|solo monophonic dry synth bass, groovy bassline, single notes"
  "ebass_F110|bass|F|110|solo monophonic dry electric bass fingered, funky bassline, single notes"
  "ebass_G90|bass|G|90|solo monophonic dry electric bass fingered, simple bassline, single notes"
  "uprightbass_D120|bass|D|120|solo monophonic dry upright bass, walking bassline, single notes"
)
DR=(80 100 120 140)

gen_mel() {
  IFS='|' read -r name role root bpm prompt <<<"$1"
  [ -f "out/eval/$name.wav" ] && return
  local extra='"muteDrums":true,"muteBass":true'
  [ "$role" = bass ] && extra='"muteDrums":true'
  $R "out/eval/$name.wav" "{\"seconds\":20,\"prompts\":[{\"text\":\"$prompt\",\"weight\":1}],\"config\":{\"bpm\":$bpm,\"scale\":\"$(scale "$root")\",\"density\":0.4,\"guidance\":4.5,$extra}}" > "out/eval/$name.log" 2>&1
}
gen_drum() {
  local bpm=$1 name="drums_$1"
  [ -f "out/eval/$name.wav" ] && return
  $R "out/eval/$name.wav" "{\"seconds\":20,\"prompts\":[{\"text\":\"steady pop rock drum beat, kick snare hi-hat\",\"weight\":1}],\"config\":{\"bpm\":$bpm,\"onlyBassAndDrums\":true,\"muteBass\":true,\"guidance\":4.5}}" > "out/eval/$name.log" 2>&1
}

# 生成（3本ずつ並列。Lyria は実時間で返すので、待ち時間は本数/3 × 約25秒）
jobs=()
for spec in "${MEL[@]}"; do jobs+=("m:$spec"); done
for b in "${DR[@]}"; do jobs+=("d:$b"); done
i=0
for j in "${jobs[@]}"; do
  if [[ $j == m:* ]]; then gen_mel "${j#m:}" & else gen_drum "${j#d:}" & fi
  i=$((i+1)); (( i % 3 == 0 )) && wait
done
wait
echo "generated"

: > out/eval/results.jsonl
# 耳コピ（2本ずつ並列）と一致度
analyze() {
  IFS='|' read -r name role root bpm prompt <<<"$1"
  local b="out/eval/$name"
  [ -f "$b.wav" ] || { echo "{\"base\":\"$b\",\"error\":\"no audio\"}"; return; }
  node scripts/transcribe.mjs "$b.wav" --bpm "$bpm" --scale "$root" --json "$b.json" 2>/dev/null | tail -1 > "$b.tr.json"
  node scripts/ghost-render.mjs "$b" --bpm "$bpm" --root "$root" --role "$role" > /dev/null
  local mt; mt=$(uv run -q --with librosa==0.11.0 python scripts/match.py "$b" 2>/dev/null | tail -1)
  node -e "const a=$(cat "$b.tr.json"),m=$mt;console.log(JSON.stringify({name:'$name',role:'$role',bpm:$bpm,inScale:a.inScaleRatio,gridErrMs:a.meanGridErrorMs,randGridMs:a.randomBaselineMs,maxPoly:a.maxPolyphony,rawNotes:a.notes,...m}))"
}
i=0
for spec in "${MEL[@]}"; do
  analyze "$spec" >> out/eval/results.jsonl &
  i=$((i+1)); (( i % 2 == 0 )) && wait
done
wait
for b in "${DR[@]}"; do
  uv run -q --with librosa==0.11.0 python scripts/tempo.py "out/eval/drums_$b.wav" "$b" 2>/dev/null | tail -1 | sed "s/^{/{\"name\":\"drums_$b\",\"bpm\":$b,/" >> out/eval/results.jsonl
done
echo "done"
