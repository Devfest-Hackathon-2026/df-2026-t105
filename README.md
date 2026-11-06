# Ghostnotes

Lyria に弾いてもらったフレーズを耳コピして、ピアノロール上に「ゴーストノート」として重ねるミニ DAW。Gemini が意図を2通りに解釈し、Lyria が2案を演奏する。どの音を採用するかは人が聴き比べて決め、採用した理由も記録する。

DevFest Tokyo 2025 ハッカソン（テーマ "Own the Why, Build with Intent."）向けの試作。経緯、検証結果、既存製品との違い、今後の計画は [docs/経緯と設計.md](docs/経緯と設計.md) にまとめてある。公開の手順は [docs/公開手順.md](docs/公開手順.md)。

## 動かし方

```bash
npm install
cp .env.example .env      # GEMINI_API_KEY を書く
npm run server            # 中継サーバー（:8787）。API キーはここだけが持つ
npm run dev               # 画面（http://127.0.0.1:5173）。/api と /ws は中継サーバーへ流れる
```

画面右上の API キー欄は空のままでよい。空なら中継サーバー経由で Gemini と Lyria を呼ぶ。キーを入れると、ブラウザから直接呼ぶ（開発用）。

- `?demo` を付けて開くと、事前に生成した2案をすぐ出すボタンが出る（実演で生成が遅れたとき用。`npm run make-demo` で作り直せる）。
- `npm run build` のあと `npm start` で、本番と同じ構成（中継サーバーが画面も配信する）で動く。

## 使い方

1. Lead か Bass（Drums は試験的）を選び、「どうしたいか」を日本語で書く（例:「ベースに寄り添う、少し切ないメロディ。最後の小節で上がって終わりたい」）。
2. 「Lyria に2案弾いてもらう」を押す。約50秒で2案が届く。
3. 案A／案B を切り替え（キー 1／2）、上部の A／B／L で聴き比べる。A は自分のノートだけ、B はゴーストを MIDI で重ねた音、L は Lyria の原音を重ねた音。
4. ゴーストノートをクリックで1音ずつ採用、右クリックで消去。小節ごとのボタンでまとめて採用、Tab で全部採用。実線は確からしい音、点線は誤検出の可能性がある音。
5. 「拾う音の量」で整形の強さを変えられる（生成し直さない）。小節の頭がずれていれば「← 1/16」「1/16 →」で動かす。
6. 「理由を残して閉じる」で、意図、比べた2案、どちらから何音採用したか、理由が「判断の記録」に残る。
7. 「MIDI に書き出す」で、採用済みの音を .mid にして手元の DAW に持っていける。

## 確かめ方

```bash
npm test                                            # 整形処理、MIDI 書き出し、ドラム検出の単体テスト
node --env-file=.env scripts/smoke.mjs <URL> out/x  # ブラウザで生成から記録までを通す（API を呼ぶ）
node scripts/smoke-demo.mjs <URL>                   # デモモードと MIDI 書き出しを通す（API を呼ばない）
bash scripts/eval-batch.sh                          # Lyria に10本弾かせ、耳コピの一致度とテンポを測る
```

設計ドキュメントを共有用の HTML にするには `npm run doc-page`（`out/ghostnotes-design.html` に出る）。

## 構成

| パス | 役割 |
|---|---|
| `src/main.ts` | 画面と操作の流れ、デモモード |
| `src/audio.ts` | Tone.js による再生（16分ごとに状態を読んで鳴らす） |
| `src/roll.ts` | ピアノロール（canvas） |
| `src/gemini.ts` | 意図 → Lyria への指示2案、提案の説明 |
| `src/lyria.ts` | Lyria RealTime の呼び出し |
| `src/transcribe.ts`, `src/transcribe.worker.ts` | basic-pitch による耳コピ（Web Worker） |
| `src/core/clean.js` | 耳コピ結果の整形（テンポ推定、格子合わせ、単音化、音域とスケール合わせ） |
| `src/core/midi.js` | MIDI ファイルの書き出し |
| `src/core/drums.js` | ドラムの検出（試験的。帯域ごとの音の立ち上がりからキック・スネア・ハイハットを拾う） |
| `server/index.mjs` | 公開用の中継サーバー（Gemini と Lyria の通信を中継し、API キーを持つ） |
| `scripts/` | 検証用のスクリプト（Lyria の録音、耳コピ、テンポ推定、一致度、一括評価、批評、デモ作成） |
| `docs/data/` | 一括評価の結果 |
