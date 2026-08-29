# server — Gateway Server (Sprint 1〜6)

WebSocket中継・セッション管理・文字起こし・Markdown保存・AI連携・
コード生成・生成MVPの配信を担当するサーバー。

現在のスコープは **Sprint 6: MVP生成 + 配信・URL表示** まで。

ARCHITECTURE.md の通り、このサーバーは **中継・保存・呼び出し・配信しか行わない**。
推論も音声処理もすべて外部APIへ委譲するため、CPU最小構成 / メモリ2GB で足りる。

## セットアップ

```bash
npm install          # リポジトリのルートで1回
npm run dev          # tsx watch。http://localhost:8787
```

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー(ファイル変更で再起動) |
| `npm start` | 起動 |
| `npm run typecheck` | 型チェック |
| `npm test` | 単体 + 結合テスト(実際にHTTP/WebSocketを立てる) |

ビルド手順は無い。`tsx` が TypeScript を直接実行する。
中継が主業務でCPUを使わないため、事前コンパイルの利点が小さい。

## 設定(環境変数)

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `PORT` | `8787` | 待ち受けポート |
| `HOST` | `0.0.0.0` | 待ち受けアドレス |
| `SESSION_TTL_MS` | 4時間 | セッションの有効期間。超えたトークンは 4401 |
| `SILENCE_TIMEOUT_MS` | 10分 | 無音での自動終了(REQUIREMENTS.md FR-8) |
| `STATS_INTERVAL_MS` | 5秒 | `session.stats` の送出間隔 |
| `CHUNK_LOG_INTERVAL_MS` | 10秒 | 音声受信ログの出力間隔 |
| `MAX_SESSION_BYTES` | 512MB | 1セッションの受信上限。超えたら 4429 |
| `CORS_ORIGINS` | `localhost:5173` 等 | 開発時にPWAからのアクセスを許可するオリジン |
| `SPEECH_PROVIDER` | `mock` | `mock` / `deepgram` |
| `SPEECH_LANGUAGE` | `ja` | 認識対象の言語 |
| `SPEECH_DIARIZE` | `true` | 話者分離を要求するか |
| `SPEECH_FAIL` | `false` | モックを必ず失敗させる。縮退動作の確認用 |
| `DEEPGRAM_API_KEY` | (空) | `SPEECH_PROVIDER=deepgram` のとき必須 |
| `DEEPGRAM_MODEL` | `nova-2` | 認識モデル |
| `DATA_DIR` | `data` | Markdownの保存先。配下に `sessions/{sessionId}/` を掘る。セッションのメタ情報(トークン含む)は `session-meta/{sessionId}.json` に置き、再起動後も読み戻す |
| `LOG_DIR` | `data/logs` | 全イベントの時系列保存先(`events-YYYY-MM-DD.jsonl`) |
| `DOCUMENT_RETENTION_MS` | 30日 | Markdownとセッション記録の保持期間 |
| `SESSION_CREATE_LIMIT` | `30` | `POST /sessions` の回数制限(サーバー全体・1窓あたり)。`0` で無制限 |
| `SESSION_CREATE_WINDOW_MS` | 1時間 | 上記の窓の長さ。超過は 429 + `Retry-After` |
| `TRIGGER_COOLDOWN_MS` | 3分 | 確認UIを出したあと、次のトリガー検出を無視する時間。`0` で無効 |
| `LLM_PROVIDER` | `mock` | `mock` / `anthropic` |
| `LLM_MODEL` | `claude-sonnet-5` | 既定モデル。Agentごとの指定が優先される |
| `LLM_FAIL` | `false` | モックを必ず失敗させる。縮退動作の確認用 |
| `LLM_LATENCY_MS` | `0` | モックの応答遅延。実APIの待ち時間の再現 |
| `ISSUE_INTERVAL_MS` | 60秒 | Issue Agent の実行間隔 |
| `ISSUE_THRESHOLD_CHARS` | `400` | 未処理がこの量を超えたら間隔を待たずに回す |
| `CODE_PROVIDER` | `template` | `template`(雛形) / `llm` |
| `CODE_MODEL` | `claude-opus-5` | `CODE_PROVIDER=llm` のときのモデル |
| `TRIGGER_DISABLED` | `false` | トリガーキーワードの検出を止める |
| `ANTHROPIC_API_KEY` | (空) | `LLM_PROVIDER=anthropic` のとき必須 |
| `ANTHROPIC_BASE_URL` | 公式 | 差し替え用 |

APIキーやデプロイトークンは環境変数のみで管理する。
リポジトリにも生成物にも含めない。

## 構成

```
src/
├── main.ts               起動とシャットダウン
├── config.ts             環境変数
├── log.ts                構造化ログ(JSON Lines)
├── http/api.ts           HTTP API
├── sessions/store.ts     セッション管理(メモリ)
├── markdown/
│   ├── documents.ts              ドキュメント登録簿(所有者・追記/置換)
│   ├── format.ts                 Markdownスキーマの整形(純粋関数)
│   ├── items.ts                  issues / ideas のマージ規則
│   ├── store.ts                  ファイル入出力・アトミック置換・差分カーソル
│   └── sessionDocuments.ts       セッションの出来事をMarkdownへ落とす層
├── llm/
│   ├── types.ts                  LLMProvider の抽象
│   ├── mockLLMProvider.ts        規則ベースのモック(既定)
│   ├── anthropicLLMProvider.ts   Claude API 実装(接続未検証)
│   └── index.ts                  設定からプロバイダを選ぶ
├── agents/
│   ├── kinds.ts                  Agentの種類
│   ├── prompts.ts                各Agentの指示と推奨モデル
│   ├── trigger.ts                トリガーキーワードの検出
│   ├── orchestrator.ts           起動条件・差分の切り出し・マージ・生成ジョブ
│   └── history.ts                Agent実行履歴(JSON Lines)
├── codegen/
│   ├── types.ts                  CodeProvider の抽象
│   ├── templateCodeProvider.ts   雛形からの組み立て(既定)
│   ├── llmCodeProvider.ts        LLMによる生成(接続未検証)
│   └── validate.ts               生成物の検証(規則で必ず弾く)
├── deploy/
│   └── localStaticDeployProvider.ts  Gateway自身による静的配信
├── http/
│   ├── preview.ts                /preview/... の配信とトークン検証
│   └── zip.ts                    持ち帰り用のZIP
├── speech/
│   ├── types.ts                  SpeechProvider の抽象
│   ├── mockSpeechProvider.ts     台本ベースのモック(既定)
│   ├── deepgramSpeechProvider.ts 実API実装(接続未検証)
│   ├── sttProxy.ts               中継・確定/未確定の整理・再接続
│   └── index.ts                  設定からプロバイダを選ぶ
└── ws/gateway.ts         WebSocketゲートウェイ
```

### 設計方針

- **セッションの状態遷移は `sessions/store.ts` に閉じ込める。**
  HTTPとWebSocketのどちらから触っても同じ規則が効く。
- **Markdownのスキーマを知っているのは `markdown/` の中だけ。**
  ゲートウェイもHTTP APIも、書式には触らない。
- **トークン比較は `timingSafeEqual`。** クエリ文字列に載るため、
  総当たりのタイミング差を作らない。

## 動作確認

`/api/v1/sessions` を作る以外は `Authorization: Bearer <token>` が要る。
トークンはセッション作成のレスポンスに入っている。

```bash
# セッションを作る
curl -sX POST localhost:8787/api/v1/sessions \
  -H 'content-type: application/json' -d '{"title":"テスト"}'

T=<token>; S=<sessionId>

# 状態を見る(受信した音声の統計が入る)
curl -s -H "authorization: Bearer $T" localhost:8787/api/v1/sessions/$S

# Markdownの一覧と本文
curl -s -H "authorization: Bearer $T" localhost:8787/api/v1/sessions/$S/documents
curl -s -H "authorization: Bearer $T" localhost:8787/api/v1/sessions/$S/documents/transcript.md

# 終了する
curl -sX POST localhost:8787/api/v1/sessions/$S/end \
  -H "authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"reason":"button"}'
```

音声が届いているかは、ログの `ws.audio` イベント(既定10秒間隔)か、
`GET /api/v1/sessions/{id}` の `audio.chunks` で確認する。

## 音声認識(Sprint 3)

既定は `MockSpeechProvider`。台本を持ち、受け取った音声の量に応じて
partial → final を進める。**資格情報なしで文字起こしの経路を通せる。**

実APIを使う場合:

```bash
SPEECH_PROVIDER=deepgram DEEPGRAM_API_KEY=... npm run dev
```

⚠️ `DeepgramSpeechProvider` は**実接続を確認していない**。
資格情報が用意できた時点で検証する(ROADMAP.md の Sprint 3 参照)。

縮退動作(音声認識が落ちても録音は続く)を確かめるには:

```bash
SPEECH_FAIL=true npm run dev
```

### WebMヘッダの保持

MediaRecorder が作るWebMは、**最初のチャンクにだけヘッダが入る**。
2つ目以降を単体で認識APIへ送っても解釈できない。

`SttProxy` は最初のチャンクを保持し、上流を張り直すたびに先頭へ差し込む。
これを外すと、STTが一度でも切れた瞬間から文字起こしが無音になる。

### STT Proxy の寿命

STT Proxy はセッションに1つ。**クライアントのWebSocket接続とは寿命が違う。**
クライアントが切断・再接続しても上流は維持され、切断中に確定した分は
再接続時に `transcript.backlog` でまとめて返す。

## Markdown Store(Sprint 4)

セッションを作ると `{DATA_DIR}/sessions/{sessionId}/` ができ、
`meeting.md` と空の `transcript.md` が置かれる。確定した文字起こしは
`transcript.md` へ追記され、セッション終了時に `meeting.md` が確定する。

書き込みの可否は `markdown/documents.ts` の登録簿が決める。
AGENTS.md のファイル所有者表をそのまま写したもので、**所有者以外は書けない**。
登録簿に無い名前はファイルシステムへ届かない(パスの検証を兼ねる)。

| 種類 | ファイル | 書き方 |
| --- | --- | --- |
| 追記専用 | `transcript.md` | 末尾へ追記のみ。`PUT` は `409` |
| 全文置換 | それ以外 | 一時ファイルへ書いてリネーム |

手で直すとき:

```bash
# 全文置換ファイルの上書き
curl -sX PUT localhost:8787/api/v1/sessions/$S/documents/requirements.md \
  -H "authorization: Bearer $T" -H 'content-type: text/markdown' \
  --data-binary '# Requirements

## 目的
在庫の可視化
'

# 会話への補足(transcript.md へ1発話として追記される)
curl -sX POST localhost:8787/api/v1/sessions/$S/inputs \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"source":"manual","payload":"補足: 拠点は3つある"}'
```

### 差分処理のカーソル

`transcript.md` の処理済みバイト位置をメモリに持つ(DATAFLOW.md の Realtime Cache)。
`readUnprocessed()` が未処理範囲を返し、`advanceCursor()` で進める。
**失敗したら進めない。** 次回に同じ範囲ごと再試行させるため。
使うのは Sprint 5 の Orchestrator。

### 既知の制約

サーバーを再起動するとセッションのトークンが失われる。
Markdownは残るが、読み出す手段が無くなる。
セッションのメタ情報の永続化は Sprint 5 以降に持ち越した。

## AI Orchestrator(Sprint 5)

既定は `MockLLMProvider`。推論はせず、決まった規則で入力からMarkdownを組み立てる。
**資格情報なしで Orchestrator → Agent → Markdown の経路を最後まで通せる。**

実APIを使う場合:

```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run dev
```

⚠️ `AnthropicLLMProvider` は**実接続を確認していない**(ROADMAP.md の Sprint 5 参照)。

縮退動作(AIが落ちても文字起こしは続く)を確かめるには:

```bash
LLM_FAIL=true npm run dev
```

### 起動条件

| Agent | いつ動くか | 出力 |
| --- | --- | --- |
| Issue | 60秒ごと、または未処理が400字を超えたとき | `issues.md` / `ideas.md` |
| Requirement | `POST /generate`(`confirm: true` 必須) | `requirements.md` |
| UI | Requirement の完了後 | `ui.md` |
| Transcript | セッション終了時 | `summary.md` / `todo.md` |

`POST /generate` は Sprint 6 でトリガー検出と明示承認UIに繋ぐ。
今は手動で叩く口として先に作ってある。

```bash
curl -sX POST localhost:8787/api/v1/sessions/$S/generate \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"confirm":true}'

curl -s -H "authorization: Bearer $T" localhost:8787/api/v1/sessions/$S/jobs/<jobId>
```

### 差分だけを投入する

Issue Agent へ渡すのは `transcript.md` の**未処理分**だけ(DATAFLOW.md の差分処理の規約)。
`issues.md` / `ideas.md` は全文を渡し、マージはこちら側で行う。

- 突き合わせは**見出し**で行う。IDはこちらで採番する
  (LLMに任せると実行のたびに番号が入れ替わる)
- 失敗したらカーソルを進めない。次回に同じ差分ごと再試行する
- 実行が重なっても同じ差分を二度処理しない

### 実行履歴

`{DATA_DIR}/sessions/{sessionId}/agent_runs.jsonl` に1実行1行で追記する。
入力・出力・所要時間・モデル・使用量(トークン)を残す。
Markdownの登録簿には載せないため `GET /documents` には出てこない。

使用量を残しているのは、RETROSPECTIVE.md の未解決の論点
「商談終了時の差分再生成」をコストの実測で決めると置いているため。

## MVP生成と配信(Sprint 6)

### トリガーから承認まで

文字起こしの確定テキストにトリガーキーワードが出ると `trigger.detected` を送る。
**この時点では何も始まっていない。** `confirm_generate` が届くまでLLMもコード生成も呼ばない
(RETROSPECTIVE.md「誤トリガーは明示承認で防ぐ」)。

検出が煩わしい場面では `TRIGGER_DISABLED=true` で止められる。

### 生成の段階

```
Issue(直前の会話を反映) → Requirement → UI → Code ⇄ Review(最大3回) → Deploy
```

`[BLOCK]` が残っているあいだは差し戻して作り直す。3回とも駄目なら、
**要件定義と画面設計までを成果物として提示して失敗させる**(AGENTS.md)。

### 生成物の検証

`codegen/validate.ts` が**必ず**走る。LLMのレビューとは別に、規則で弾く。

| 見るもの | 判定 |
| --- | --- |
| `index.html` が無い | BLOCK |
| 外部への参照(CDN・Webフォント・外部API) | BLOCK |
| サーバーサイド実行(`process.env` / `require()` / SSR) | BLOCK |
| シークレットらしき文字列 | BLOCK |
| 配信ディレクトリの外へ出るパス | BLOCK |

**事故を止めるのは規則であって、LLMの判断ではない。** Review Agent が落ちても効く。

### 配信

```
GET /preview/{sessionId}/{buildId}/*
```

初回は `?t=<token>` を付けて開き、以降はCookieで通す。
トークンが無い・合わない・期限切れなら `401`。**外部へ公開しない。**

古いビルドは新しいビルドができた時点で消す。
セッションが保持期間を過ぎたら、Markdownと一緒に生成物も消える。

### 持ち帰り

```
GET /api/v1/sessions/{id}/export.zip
```

Markdownをまとめて返す。生成に失敗していても、そこまでの成果物は持ち帰れる。

## 音声データの扱い

**受信した音声はメモリ上を通過するだけで、ディスクにもログにも書かない。**
記録するのはチャンク数とバイト数のみ(REQUIREMENTS.md のプライバシー要件)。
Markdown Store に書くのも文字起こし結果のテキストだけで、音声は含まない。
