# Ghostnotes

AIが生成したフレーズを聴き比べ，使いたい音を選んで曲にするブラウザDAW．GDGoC Japan Devfest 2026 Hackathonのテーマ「Own the Why, Build with Intent.」に合わせ，音を採用した理由も記録する．

[アプリを開く](https://ghostnotes-1007513721749.asia-northeast1.run.app/) · [デモを試す](https://ghostnotes-1007513721749.asia-northeast1.run.app/?demo)

公開版はAPIキーの入力が不要．デモでは事前生成した2案を読み込み，生成APIを呼ばずに採用・編集・書き出しを試せる．

## メンバー

- [@yi7242](https://github.com/yi7242)
- [@CompassSN](https://github.com/CompassSN)
- [@tetsugo02](https://github.com/tetsugo02)
- [@MrHate](https://github.com/MrHate)

## プロジェクト紹介

Geminiが日本語の指示と既存の音符を基に生成内容を組み立て，Lyriaがフレーズの音声を生成する．その音声を採譜し，ピアノロールに「ゴーストノート」として重ねる．利用者は原音と提案を聴き，使いたい音を採用・編集する．

| 機能 | 内容 |
|---|---|
| フレーズ生成 | 開始小節と長さ（1〜32小節）を指定して1〜4案を生成．同時生成数も1〜4から選べる |
| 比較・採用 | 原音と採譜結果を試聴し，音符単位・小節単位で採用 |
| 編集 | ノートの移動・長さ変更，音色・音量の調整，ソロ・ミュート，元に戻す・やり直す |
| 判断の記録 | 生成時の指示，採用した音数，選んだ理由を保存 |
| 書き出し | 採用済みの音をMIDI／WAVで保存 |

MuScriptorを起動していない環境では，ブラウザ側のBasic Pitchで採譜する．MuScriptorの稼働時はそちらを優先し，楽器ごとの採譜結果も取り込める．Lyriaが指定のテンポやキーを守らないことや，採譜で音を誤検出することがあるため，最後は聴いて採用する音を決める．

### 基本操作

1. 生成先のトラックを選び，「少し切ないメロディ」のように指示を書く．
2. 開始小節，小節数，生成数を指定して「生成する」を押す．既定は1案．
3. 「＋原音」「＋提案」で聴き比べ，ゴーストノートをクリックして採用する．
4. 採用した理由を書き，「理由を残して閉じる」を押す．
5. 必要に応じてノートを編集し，MIDI／WAVに書き出す．

## ローカルへの導入

Node.js 22系の新しいバージョンとnpm，Gemini APIのキーを用意する．キーは中継サーバーが持ち，画面のAPIキー欄は空のまま使う．

```bash
git clone https://github.com/Devfest-Hackathon-2026/df-2026-t105.git
cd df-2026-t105
npm ci
cp .env.example .env
```

`.env` にキーを設定する．Gemini APIを使う場合，`VERTEX_PROJECT` は設定しない．

```dotenv
GEMINI_API_KEY=your_api_key
```

ターミナルを2つ開き，それぞれ起動する．

```bash
# ターミナル1：中継サーバー
npm run server
```

```bash
# ターミナル2：開発画面
npm run dev
```

[http://127.0.0.1:5173/](http://127.0.0.1:5173/) を開く．APIを使わず画面を試す場合は，`npm run dev` だけを起動して [デモモード](http://127.0.0.1:5173/?demo) を開く．

ビルドした画面を中継サーバーから配信する場合は，次を実行して [http://localhost:8787/](http://localhost:8787/) を開く．

```bash
npm run build
npm run server
```

`npm run server` は `.env` を読み込む．`npm start` は読み込まないため，起動前に環境変数を設定する．

## Cloud Runへのデプロイ

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/deployment-dark.png">
  <img src="docs/images/deployment.png" alt="Ghostnotesのデプロイ構成．GitHubのmainからgcloudでCloud Buildへソースを送り，Artifact Registry経由でCloud Runへデプロイする．ブラウザはCloud Runへ接続する．図はGemini APIのキーを使っていたときの構成で，現在はVertex AIを使う．">
</picture>

実線は実行時の通信，破線はビルド・デプロイを示す．現在はGitHub Actionsからデプロイし，GeminiとLyriaはVertex AIで呼ぶ（図は更新前）．[図のHTMLソース](docs/images/deployment.html)も参照できる．

画面と中継サーバーを1つのコンテナにまとめる．公開版はGemini API（AI Studio）を使わず，Vertex AIだけでGeminiとLyriaを呼ぶ．Vertexへは実行用サービスアカウントの権限で接続するため，APIキーは持たない．Vertexでは Lyria 3.5 と RealTime が使えないので，「Lyria 3.5」を選ぶと Lyria 3 Pro で生成する．

サイトにはパスワード（Basic認証）をかける．パスワードはSecret Managerの `ghostnotes-app-password` に置き，実行時に環境変数 `APP_PASSWORD` として渡す．ブラウザで開くとパスワードを聞かれる．ユーザー名は何でもよい．

### GitHub Actions

`main` が更新されると，次の2つのワークフローが動く．

| ワークフロー | 内容 |
|---|---|
| [Deploy to Cloud Run](.github/workflows/deploy.yml) | テストとビルドのあと，`dev-fast-deadline-driven` のCloud Runへデプロイし，`/healthz` と認証が効いていることを確かめる．GCPへはWorkload Identity Federationで入る |
| [Mirror to submission repository](.github/workflows/mirror.yml) | 提出用リポジトリ（[Devfest-Hackathon-2026/df-2026-t105](https://github.com/Devfest-Hackathon-2026/df-2026-t105)）の `main` にpushする．早送りできないときは上書きせずに失敗する |

最初に1回だけ，GCPとGitHubの準備をする．

1. GCP：プロジェクトのオーナー権限を持つアカウントで `APP_PASSWORD=<サイトのパスワード> sh scripts/setup-gcp-ci.sh` を実行する．パスワードのシークレット，デプロイ用サービスアカウント `ghostnotes-deployer`，GitHub用のWorkload Identity Federationを作る．パスワードを変えるときも同じコマンドを実行し，そのあとデプロイし直す．
2. GitHub：`yi7242/ghostnotes` のSecretに `SUBMISSION_REPO_TOKEN` を登録する．提出用リポジトリへ書き込めるPAT（classicなら `repo` と `workflow`，fine-grainedなら Contents と Workflows の Read and write）を使う．

### 手動でデプロイする

リポジトリのルートで実行する．gcloudはローカル版でもDocker版でも使える．

```bash
gcloud run deploy ghostnotes \
  --project dev-fast-deadline-driven \
  --region asia-northeast1 \
  --source . \
  --service-account ghostnotes-runtime@dev-fast-deadline-driven.iam.gserviceaccount.com \
  --build-service-account projects/dev-fast-deadline-driven/serviceAccounts/ghostnotes-build@dev-fast-deadline-driven.iam.gserviceaccount.com \
  --set-env-vars VERTEX_PROJECT=dev-fast-deadline-driven,VERTEX_LOCATION=global \
  --set-secrets APP_PASSWORD=ghostnotes-app-password:latest \
  --timeout 300 --max-instances 2 --memory 512Mi
```

`--set-env-vars` と `--set-secrets` は既存の値を置き換えるので，以前の `GEMINI_API_KEY` はここで外れる．デプロイ後にパスワードを入れて `/api/config` を開き，`backend` が `vertex` になっていれば，Vertex AIを使う設定になっている．

## 検証と関連資料

```bash
npm test       # 単体テスト
npm run build  # 型チェックとビルド
```

画面操作を検証する場合は，開発サーバーを起動して次を実行する．これらのスモークテストは生成APIを呼ばない．

```bash
npx playwright install chromium
node scripts/smoke-demo.mjs http://127.0.0.1:5173
node scripts/smoke-daw.mjs http://127.0.0.1:5173
```

- [生成プロンプトと採譜経路の対照実験](docs/採譜の対照実験.md)
- 試聴比較UI：`npm run compare:serve` で起動し，`http://127.0.0.1:8899/` を開く．収録済みの音源を使うため，生成APIやGPUは不要．
- [アプリのライセンス](LICENSE)
- [MuseScore General音源のライセンス](public/soundfonts/LICENSE-MuseScore-General.txt)．初回再生時に約38MBの音源を読み込む．
