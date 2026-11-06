---
name: Ghostnotes
description: Lyria の提案を DAW のテイクとして並べ、人が小節ごとに選ぶミニ DAW
colors:
  ground: "#f3f4f6"
  surface: "#ffffff"
  surface-2: "#f8f9fb"
  sunken: "#e9ebef"
  line: "#dde0e6"
  line-strong: "#c4c8d1"
  text: "#16181d"
  muted: "#5f6573"
  accent: "#2563d9"
  lcd-bg: "#1d2128"
  lcd-text: "#9fe3b0"
  track-drums: "#c77d12"
  track-bass: "#11867a"
  track-lead: "#2f5bd3"
  ghost: "#8b3fd9"
  playhead: "#e5484d"
  error: "#c4322f"
typography:
  body:
    fontFamily: "system-ui, -apple-system, Hiragino Sans, Noto Sans JP, Segoe UI, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "system-ui, -apple-system, Hiragino Sans, Noto Sans JP, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  heading:
    fontFamily: "system-ui, -apple-system, Hiragino Sans, Noto Sans JP, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.4
  lcd:
    fontFamily: "system-ui, -apple-system, Hiragino Sans, Noto Sans JP, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: "5px"
  md: "7px"
  lg: "12px"
  pill: "50%"
spacing:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "16px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
  button-play:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    size: "34px"
  lcd:
    backgroundColor: "{colors.lcd-bg}"
    textColor: "{colors.lcd-text}"
    typography: "{typography.lcd}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  take-bar:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: "34px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "5px 8px"
---

# Design System: Ghostnotes

## Overview

DAW を触ったことがある人が、説明なしで場所を当てられる編集画面。上にトランスポート、左にトラック、中央にエディタ（テイクのレーン、鍵盤つきピアノロール、ベロシティ）、右にインスペクタを置く。参照したのは Ableton Live、Logic Pro、BandLab と作者の yuna-daw。世界観は色と細部だけに出し、配置と操作は DAW の作法に従う。明るい画面と暗い画面の両方を持ち、OS の設定に従う（`prefers-color-scheme`）。

## Colors

色は役割で使い分ける。灰色の地に、操作の色（青）、トラックの色（3色）、提案の色（紫）、再生位置の色（赤）を載せる。暗い画面の値は `src/style.css` の `@media (prefers-color-scheme: dark)` にあり、同じ名前のトークンを差し替える。

### Primary
- accent `#2563d9`（暗い画面 `#5b8cff`）：再生ボタン、主ボタン、選択中の切り替え、フォーカスの輪。

### Secondary
- ghost `#8b3fd9`（暗い画面 `#b98cff`）：AI の提案だけに使う。ゴーストノート、テイクのレーン、案の名前、ロゴの点線の部分。

### Tertiary
- track-drums `#c77d12`、track-bass `#11867a`、track-lead `#2f5bd3`：トラックの印、ピアノロールのノート、ベロシティの棒、トラック一覧の小さなクリップ。
- playhead `#e5484d`：再生位置の線と、目盛りの上の三角。

### Neutral
- ground、surface、surface-2、sunken：地、作業面、パネル、沈んだ面（クリップの背景など）。
- line、line-strong：区切り線と、ホバー時の枠。
- text、muted：本文と補足。
- lcd-bg、lcd-text：再生位置の表示だけに使う、暗い地の緑の数字。

### Named Rules
- 紫は提案専用。採用した音はトラックの色に変わるので、「どれが AI の案で、どれが自分の音か」が色で分かる。
- 色だけで状態を伝えない。確からしい提案は実線、誤検出かもしれない提案は点線で描く。

## Typography

作業画面なので、OS の UI 書体（system-ui、Hiragino Sans、Noto Sans JP）だけを使う。時刻、BPM、音数など桁が揃ってほしい数字は `font-variant-numeric: tabular-nums`。

### Hierarchy
- 本文 13.5px／1.55、ラベルと補足 12px（muted）、パネルの見出し 13px 太字、ペインの見出し 11px 太字で字間 0.06em、再生位置 15px 太字。

## Layout

`.app` は2段（トランスポート、作業域）。作業域は3列（250px、可変、340px）。1180px 未満ではインスペクタがエディタの下に回り、760px 未満では1列になる。テイクのレーン、ピアノロール、ベロシティ欄は、左に鍵盤の幅（56px、`KEY_W`）を空けて小節の列をそろえる。ピアノロールの上には 22px（`RULER_H`）の小節の目盛りがある。

## Elevation & Depth

段差は区切り線と面の明るさで表す。影を使うのは、設定のポップオーバー（`0 8px 24px` の柔らかい影）だけ。

## Shapes

ボタンと入力欄は 7px、テイクの小節とトラックの小さなクリップは 5px、ポップオーバーは 12px、再生ボタンだけ円。

## Components

### Buttons
枠線つきの白い面（暗い画面では濃い面）。主ボタンと再生ボタンだけが青で塗られる。押されている状態（`aria-pressed="true"`）は薄い青の面と青い枠。

### Inputs / Fields
ラベルは上に 12px の muted。枠線 1px、角 7px。

### Navigation
トランスポートが全体の操作を持つ（先頭へ、再生、位置表示、BPM、キー、長さ、聴くもの、元に戻す、書き出し、設定）。キーボード操作：Space で再生、Home で先頭、Cmd/Ctrl+Z で元に戻す、Tab で全部採用、1／2 で案の切り替え、Esc で破棄。

### Take lanes（この画面の特徴）
案A と案B を、ピアノロールの上に小節単位のボタンとして並べる。押すとその小節を案の音で置き換え（コンピング）、もう一度押すと元に戻る。取り込んだ小節は紫の面と枠で示す。中の小さな canvas に、その小節の音の並びを描く。

## Do's and Don'ts

### Do:
- ノートとベロシティの棒は、そのトラックの色で塗る。
- 新しい状態を足すときは、`aria-pressed` と面の色の両方で示す。
- canvas の色は CSS のトークンから読む（テーマを切り替えたら描き直す）。

### Don't:
- 紫を提案以外に使わない。
- 絵文字や文字の記号をアイコンの代わりにしない。アイコンは `index.html` の SVG（線幅 1.6）を使う。
- 配置を DAW の作法から外さない（再生系は左上、書き出しは右上）。

## 試聴比較画面

`public/compare/`は採譜実験を人が試聴する独立した画面。既存の色とシステム書体を引き継ぐ。左で音源とモデルを選び、中央で原音とA〜Eを切り替える。スマホでは音源一覧を横にスクロールする。条件は折りたたみ、評価の前に方法名が見えないようにする。評価はブラウザへ保存し、書き出せる。
