# Ghostnotes

Lyria に弾いてもらったフレーズを耳コピして、ピアノロール上に「ゴーストノート」として重ねるミニ DAW。生成は既定で1案。生成数と同時生成数を、それぞれ1〜4から選べる。どの音を採用するかは人が聴き比べて決め、採用した理由も記録する。

GDGoC Japan Devfest 2026 Hackathon（テーマ "Own the Why, Build with Intent."）向けの試作。経緯、検証結果、既存製品との違い、今後の計画は [docs/経緯と設計.md](docs/経緯と設計.md) にまとめてある。公開の手順は [docs/公開手順.md](docs/公開手順.md)。

## 試聴比較

[試聴比較UI](https://oracletail.tail0dad76.ts.net/ghostnotes/)（Tailscale内限定）。原音と採譜音の切り替え、区間ループ、音量調整、条件を伏せた比較、評価の保存・JSON書き出しに対応する。既定はBasic Pitchと、A100で計算したMuScriptor large・medium・smallの比較。採譜方法や生成プロンプトの比較にも切り替えられる。

生成条件と採譜方法の対照実験は [docs/採譜の対照実験.md](docs/採譜の対照実験.md)。ローカルでは `npm run compare:serve` で `http://127.0.0.1:8899/` を開く。試聴は収録済みの音源だけを使い、生成APIやGPUを呼ばない。

## 動かし方

```bash
npm install
cp .env.example .env      # GEMINI_API_KEY を書く
npm run server            # 中継サーバー（:8787）。API キーはここだけが持つ
npm run dev               # 画面（http://127.0.0.1:5173）。/api と /ws は中継サーバーへ流れる
```

画面右上の設定にある API キー欄は空のままでよい。空なら中継サーバー経由で Gemini と Lyria を呼ぶ。キーを入れると、ブラウザから直接呼ぶ（開発用）。

中継サーバーの呼び出し先は、環境変数で選ぶ。

- `GEMINI_API_KEY`：AI Studio。Lyria 3.5、3 Clip、RealTime が使える
- `VERTEX_PROJECT`（と必要なら `VERTEX_LOCATION`、`VERTEX_GEMINI_MODEL`）：Vertex AI（Agent Platform）。ハッカソンの GCP クレジットはこちらに使える。Lyria は 3 Pro と 3 Clip で、3.5 の選択肢は 3 Pro になる。認証は Cloud Run ではサービスアカウント、手元では `gcloud auth print-access-token`
- 両方を設定すると、作曲と Gemini は Vertex、RealTime は AI Studio を使う
- `MUSCRIPTOR_URL`：muscriptor のサーバー（例 `http://127.0.0.1:8222`）。設定すると、画面右上の設定で「MuScriptor CPU」を選べる。サーバーは `~/src/muscriptor` で `uv run muscriptor serve --model small --device cpu --port 8222` で起動する（HuggingFace でライセンスに同意し、`hf auth login` 済みであること）

- `MUSCRIPTOR_A100_URL`：A100上のMuScriptorへの接続先。既定は `http://127.0.0.1:8223`。`npm run a100` で専用Colab A100・mediumモデル・非公開SSH転送を起動し、設定の「耳コピ」で「MuScriptor A100」を選ぶ。Colab CLIの認証と、Hugging Faceでのモデル利用条件への同意・ログインが必要。起動時に認証ファイルの転送を確認する。Ctrl+Cまたは60分でランタイムを停止する。`A100_MODEL=medium`、`A100_MINUTES=30` などで変更できる。
- 音源はMuScriptor公式配布のMuseScore General。フルート・ピアノ・マリンバ・ベース・ドラムの再生とWAV出力に使う。配布元とライセンスは [音源のライセンス](public/soundfonts/LICENSE-MuseScore-General.txt)。初回再生時に約38MBを読み込む。

- `?demo` を付けて開くと、事前に生成した2案をすぐ出すボタンが出る（実演で生成が遅れたとき用。`npm run make-demo` で作り直せる）。
- `npm run build` のあと `npm start` で、本番と同じ構成（中継サーバーが画面も配信する）で動く。

## 使い方

1. 生成先のトラックを選び、「どうしたいか」を日本語で書く（例:「ベースに寄り添う、少し切ないメロディ。最後の小節で上がって終わりたい」）。
2. 「生成開始の小節」と「生成する小節数」（1〜32）を指定し、Lyria のモデルを選び（既定は Lyria 3.5）、「生成する」を押す。既定は1案で、「生成数」で1〜4案、「同時生成数」で順次実行か最大4並列を選べる。待ち時間はモデルや生成内容によって変わる。3.5 と 3 Clip はテンポとキーを守らないことがあるので、耳コピのあとで曲のテンポとキーに合わせる。
3. 2案にした場合は案A／案Bを切り替えられる（キー1／2）。上部の「自分」は採用済みのノート、「＋提案」はゴーストもMIDIで重ねた音、「＋原音」はLyriaの原音を重ねた音。
4. ゴーストノートをクリックで1音ずつ採用、右クリックで消去。小節ごとのボタンでまとめて採用、Tab で全部採用。実線は確からしい音、点線は誤検出の可能性がある音。
5. Basic Pitchの提案では「拾う音の量」で整形の強さを変えられる（生成し直さない）。小節の頭がずれていれば「← 1/16」「1/16 →」で動かす。
6. 「理由を残して閉じる」で、意図、生成した案、どちらから何音採用したか、理由が「判断の記録」に残る。
7. 「MIDI に書き出す」で採用済みの音を .mid に、「WAV に書き出す」で2ループぶんを .wav にできる。

DAW としての操作：自分のノートはドラッグで移動、右端のドラッグで長さ変更、動かさずにクリックで削除。Cmd/Ctrl+Z で元に戻す、Shift+Cmd+Z か Ctrl+Y でやり直す。トラックごとに音色・音量・ソロ（S）・ミュート（M）を変えられる。曲全体の小節数は指定しない。右へ移動すると空の小節が続き、音符を置いた範囲に応じて曲が伸びる。「表示開始」「表示幅」で編集する範囲を選び、「表示範囲をループ」でその部分を繰り返せる。通常再生は内容の末尾を越えて続き、「ループ」を有効にしたときだけ繰り返す。入力グリッドは1/4〜1/128、三連符、自由配置から選ぶ。ドラムはKick・Snare・Hi-hat・Tom・Crash・Rideなど47種類の楽器名で表示し、縦にスクロールして入力する。

MuScriptorの発音時刻・音符の長さは16分音符に丸めず保持する。重なった連打も採用時に削除しない。生成結果は指定した小節位置へ配置する。生成音が指定の長さに届かない場合、音符を繰り返して埋めることはしない。

標準の採譜は常駐MuScriptor small（CPU）。このサーバーでは `ghostnotes-muscriptor.service` で起動している。別環境では `uvx muscriptor serve --model small --device cpu --port 8222` を起動する。画面は稼働状態を確認して採譜先を表示する。MuScriptorの結果から対象パートを選び、指定した既存トラックへ提案する。ほかの検出パートも楽器ごとのトラックに表示する。名前と音色はMuScriptorの分類に合わせ、無関係なデモのドラム・ベースは作らない。和音を単音にまとめない。各パートを採用・編集・再生し、MIDI／WAVへ書き出せる。採譜はジョブとして受け付け、画面には進捗を返す。A100は自動起動しない。楽器指定は音源分離ではなく、採譜モデルが出せる楽器の制限である。

原音の試聴は既定で自動再生しない。生成が完了した案を「試聴する案」で選び、音声プレーヤーで再生・一時停止・音量調整、「試聴を停止」で先頭へ戻せる。「自動試聴」は任意で有効にできる。小節位置は原音の拍検出を優先し、指定小節数を含む区間を選ぶ。音符が少ない場合は実際に音符のある小節数を表示する。

## 確かめ方

```bash
node scripts/smoke-comparison.mjs <試聴UIのURL>        # 試聴、切り替え、保存・書き出し、スマホ表示
node scripts/smoke-soundfont.mjs <URL>                # 音源の実出力とWAV出力
node scripts/smoke-timeline.mjs <URL>                # ドラム名、連打、三連符、自動延長、途中への生成配置
npm test                                            # 整形処理、MIDI 書き出し、ドラム検出の単体テスト
node --env-file=.env scripts/smoke.mjs <URL> out/x  # ブラウザで生成から記録までを通す（API を呼ぶ）
node scripts/smoke-demo.mjs <URL>                   # デモモードと MIDI 書き出しを通す（API を呼ばない）
node scripts/smoke-daw.mjs <URL>                    # 元に戻す・音色・音量・ソロ・WAV 書き出し（API を呼ばない）
node scripts/smoke-roll.mjs                         # ノートのドラッグ移動と長さ変更（:5319 で自分で Vite を立てる）
bash scripts/eval-l35.sh                            # Lyria 3.5 / 3 Clip がテンポ・キー・長さを守るかを測る
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
