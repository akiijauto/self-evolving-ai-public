# AI Agent一覧

## Speech Agent

音声認識担当

---

## Transcript Agent

議事録生成

---

## Requirement Agent

要件定義生成

---

## Issue Agent

課題抽出

---

## UI Agent

画面設計

---

## Claude Code Agent

コード生成

---

## Review Agent

レビュー

---

## Deploy Agent

デプロイ

---

## Memory Agent（将来）

Circleback

Notion

CRM

長期コンテキスト管理

---

# 共通契約

すべてのAgentは以下を守る。破った時点で疎結合が崩れる。

1. **入力はMarkdown、出力もMarkdown。** 他の形式でAgent間をまたがない。
2. **他のAgentを直接呼ばない。** 起動はOrchestratorのみが行う。
3. **自分が所有するファイルにのみ書き込む。** 他Agentの所有ファイルは読み取り専用。
4. **他Agentの存在を前提にしない。** 「Issue Agentが先に動いているはず」ではなく、`issues.md` が空なら空として扱う。
5. **冪等であること。** 同じ入力で2回実行しても、結果が二重に増えないこと。
6. **失敗時は例外を投げる。** 部分的な結果を書き込んだまま終了しない。

## ファイル所有者

| ファイル | 書き込み | 読み取り |
| --- | --- | --- |
| `meeting.md` | Orchestrator | 全Agent |
| `transcript.md` | Speech Agent | Transcript / Issue Agent |
| `issues.md` | Issue Agent | Requirement / UI Agent |
| `ideas.md` | Issue Agent | Requirement / UI Agent |
| `requirements.md` | Requirement Agent | UI / Claude Code / Review Agent |
| `ui.md` | UI Agent | Claude Code / Review Agent |
| `ai_instruction.md` | Orchestrator | Claude Code Agent |
| `review.md` | Review Agent | Claude Code Agent |
| `todo.md` | Transcript Agent | Memory Agent |
| `summary.md` | Transcript Agent | Memory Agent |
| `context.md` | Memory Agent | 全Agent(読み取りのみ) |
| 生成コード | Claude Code Agent | Review / Deploy Agent |

この表は**Agent同士の取り決め**である。1ファイル1書き手を守ることで、
どのAgentを止めても他が壊れない状態を保つ。

例外は入力アダプタ層(DATAFLOW.md)。音声以外の入力をMarkdownへ正規化する手前の層であり、
Agentではない。所有者以外のファイルへも書けるが、追記専用ファイルへは追記しかできない。

`meeting.md` の書き手は Orchestrator だが、Orchestrator は Sprint 5 で作る。
それまでは Gateway Server がセッションの開始・終了に合わせて代行する。

---

# Agent仕様

## Speech Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 音声ストリームを文字起こしし、確定テキストを `transcript.md` へ追記する |
| 入力 | 音声チャンク(Opus) |
| 出力 | `transcript.md`(追記専用) |
| 起動 | WebSocketの `start` 受信時、セッション中は常時稼働 |
| 使用API | Speech To Text API(`SpeechProvider` 経由) |
| 目標遅延 | 発話終了から3秒以内 |
| 失敗時 | `error` を通知して文字起こしを停止。音声はバッファせず破棄。手入力への切り替えを案内する |

- partialは `transcript.md` へ書かない。PWAへの即時表示のみに使う。
- 話者分離が利用できない場合も処理を継続する(話者ラベルを省略する)。
- **このAgentだけは常時稼働**であり、他Agentのようにジョブ単位では動かない。

## Transcript Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 文字起こしを最終サマリと商談後アクションへ整形する |
| 入力 | `transcript.md`, `issues.md`, `ideas.md` |
| 出力 | `summary.md`, `todo.md` |
| 起動 | セッション終了時。トリガー検出時(承認判断の材料として `summary.md` のみ更新)。および商談中の任意タイミング(手動) |
| 推奨モデル | `claude-sonnet-5` |
| 失敗時 | サマリ生成のみ失敗として扱う。`transcript.md` は残っているため商談価値は毀損しない |

- 議事録専用ファイル(`minutes.md`)は作らない。**`summary.md` に統合する**(ファイルを増やさない方針)。
- `todo.md` はセッション終了時にまとめて生成する。商談中に未確定の約束を顧客へ見せないため、リアルタイム更新はしない。

## Issue Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 会話から課題と解決アイデアを抽出する |
| 入力 | `transcript.md` の未処理差分 + `issues.md` / `ideas.md` の現在値 + `context.md` |
| 出力 | `issues.md`, `ideas.md` |
| 起動 | 60秒ごと、または文字起こしが一定量蓄積したとき |
| 推奨モデル | `claude-sonnet-5`(頻度が高いためコストを抑える) |
| 目標遅延 | 5秒以内にMarkdown更新 |
| 失敗時 | 次回の実行で未処理差分ごと再試行する。処理済み位置は進めない |

- 既出の課題は新規追加せず、既存項目の根拠へ追記する(冪等性の担保)。
- **商談中に画面共有される前提**で書くこと。顧客が読んで違和感のない日本語にする。

## Requirement Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 課題とアイデアから要件定義を生成する |
| 入力 | `issues.md`, `ideas.md`, `transcript.md`, `context.md` |
| 出力 | `requirements.md` |
| 起動 | トリガー検出後、Orchestratorから1回 |
| 推奨モデル | `claude-opus-5` |
| 失敗時 | 生成ジョブ全体を失敗とする。`issues.md` までを成果物として提示する |

- **スコープを1〜3画面に抑えること。** ここで要件を膨らませると後続のコード生成が破綻する。
- 「対象外」セクションを必ず書く。何を作らないかの明示が生成物の品質を決める。

## UI Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 要件定義から画面構成を設計する |
| 入力 | `requirements.md`, `issues.md` |
| 出力 | `ui.md` |
| 起動 | Requirement Agentの完了後 |
| 推奨モデル | `claude-sonnet-5` |
| 失敗時 | `ui.md` なしで Claude Code Agent を実行する(必須入力ではない) |

- 画面数は `requirements.md` の記載を超えないこと。
- 装飾ではなく構造を書く。配色やフォントの指定はしない。

## Claude Code Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 要件定義と画面設計から、動作するWebアプリのソースコードを生成する |
| 入力 | `requirements.md`, `ui.md`, `ai_instruction.md`, (差し戻し時) `review.md` |
| 出力 | ソースコード一式(`FileMap`) |
| 起動 | UI Agentの完了後。Review Agentからの差し戻し時は再実行(既定3回、`CODE_ATTEMPTS` で減らせる) |
| 使用API | `CodeProvider` 経由(既定は雛形からの組み立て。要件から形を4種類で選び分ける。LLM実装も選べる) |
| 失敗時 | 上限まで失敗した場合、要件定義とUI設計までを成果物として提示し、生成失敗を明示する |

- 生成物は**ビルド工程を持たないこと**を完了条件とする(`ai_instruction.md`)。
  商談中に `npm install` を走らせない。ブラウザがそのまま解釈できる形に限る。
- 外部APIを呼ぶコードを生成しない(`ai_instruction.md` の制約)。
- APIキー等のシークレットを生成コードに含めない。

## Review Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 生成コードが要件を満たしているかを検証する |
| 入力 | 生成コード, `requirements.md`, `ui.md` |
| 出力 | `review.md` |
| 起動 | Claude Code Agentの完了後 |
| 推奨モデル | `claude-opus-5` |
| 失敗時 | レビューをスキップしてデプロイへ進む(レビュー失敗でデモを止めない) |

- 判定は `pass` / `needs_fix` の2値。
- **規則で判定できるもの(外部参照・サーバーサイド実行・シークレット)はLLMに委ねない。**
  検証層が必ず先に見る。Review Agent の指摘はその上に積む。
- `[BLOCK]` は要件違反または動作不能。`[WARN]` は改善提案。**`[BLOCK]` のみが差し戻しの対象。**
- 商談中の時間制約があるため、細かな指摘で差し戻しを繰り返さないこと。

## Deploy Agent

| 項目 | 内容 |
| --- | --- |
| 責務 | 生成コードを静的SPAとしてビルドし、Gateway Serverから配信可能にする |
| 入力 | 生成コード |
| 出力 | Preview URL(セッショントークン付き), 有効期限 |
| 起動 | Review Agentが `pass` を返した後 |
| 使用API | `DeployProvider`(既定実装はGateway Server自身によるローカル配信) |
| 目標時間 | 承認から10分以内に配信開始 |
| 失敗時 | 生成コードをZIPでダウンロード可能にし、URLの代わりに提示する |

- **外部ホスティングへはデプロイしない。** ビルド成果物をセッション用ディレクトリへ配置し、Gateway Serverが静的配信する。
- URLはセッショントークンを含む。トークンなしのアクセスは `401` を返す。
- URLはQRコードでも提示する。**このURLは合言葉そのもので、知っている人は誰でも開ける**
  (送信元ネットワークやIPは見ていない)。ただし開けるのは生成された試作品だけで、
  議事録や文字起こしは読めない — プレビュー用トークンは操作用と別の値にしてある。
- **QRの読み手は営業担当自身の2台目の端末とする(現時点の運用)。**
  顧客の端末へURLを渡すことは保留にしてある。「相手の手元で動く」ほうが体験は強いが、
  URLは渡した先の履歴に残り、転送もできる。解禁するかは運用の判断であり、
  実装側は既に分離できている(`previewToken`)ので、判断が変わっても変更は要らない。
- 配信はセッションの有効期間中のみ。セッション失効と同時に配信を停止する。
- `DeployProvider` インターフェースは維持する。将来、外部公開が必要になった時点で実装を差し替えるだけで済むようにする。

## Memory Agent(将来)

| 項目 | 内容 |
| --- | --- |
| 責務 | 外部サービスとの長期コンテキストの読み書き |
| 入力 | `summary.md`, `todo.md`(書き出し時) |
| 出力 | `context.md`(読み込み時) |
| 起動 | セッション開始前(pull)、セッション終了後(push) |
| 接続先 | Circleback / Notion / CRM |
| 失敗時 | `context.md` なしでセッションを開始する。リアルタイム経路には影響させない |

- **リアルタイム経路には一切割り込まない。** 外部サービスの遅延や障害が商談中の体験に影響してはならない。
- 取得した内容は必ずMarkdownへ正規化してから `context.md` に格納する。

---

# 実行順序

```
[常時] Speech Agent

[60秒ごと] Issue Agent

[トリガー検出後]
  Requirement Agent
    ↓
  UI Agent
    ↓
  Claude Code Agent ⇄ Review Agent (最大3往復)
    ↓
  Deploy Agent

[セッション終了時]
  Transcript Agent
    ↓
  Memory Agent (将来)
```

Orchestratorはこの順序と条件のみを知っている。
各Agentは自分の前後に何が動くかを知らない。

「トリガー検出後」に進むのは**営業担当が承認したときだけ**で、検出だけでは
Transcript Agent(`summary.md` のみ)しか動かない。確認UIを一度出したあとは
既定3分間、次の検出を無視する(`TRIGGER_COOLDOWN_MS`)。会話が同じ話題へ戻るたびに
確認が出ると商談が途切れ、そのたびに議事録の作り直しでLLMを呼ぶことになる。

## 承認からURLまでの時間予算

Deploy Agent の目標は「承認から10分以内に配信開始」。**すべて実APIでの計測値**
(`scripts/verify-llm.mjs` と `scripts/verify-codegen.mts`):

| 段階 | モデル | 実測 |
| --- | --- | --- |
| requirement | Opus 5 | 33.3秒(2,211トークン出力) |
| ui | Sonnet 5 | 約22秒 |
| code | Opus 5 | **44.4秒**(4ファイル / 10,262文字) |
| review | Opus 5 | **24.0秒** |

| 経路 | 承認→URL |
| --- | --- |
| `CODE_PROVIDER=template` | 約75秒 |
| `CODE_PROVIDER=llm`・差し戻しなし | **約2分** |
| `CODE_PROVIDER=llm`・1回差し戻し | **約3分20秒** |
| `CODE_PROVIDER=llm`・3往復(上限) | **約4分20秒** |

**上限まで回っても10分の予算に5分以上残る。** よって `CODE_ATTEMPTS` は既定の3のまま使う。
上限に達したときに出るのは要件定義とUI設計までで**動くものは出ない**ため、
往復を削る判断は「試作品が出ない」確率を上げるだけになる。
`CODE_ATTEMPTS` を下げるのは、実測がこの表から大きく外れたときに限る。

`code` を軽いモデルへ落とす案は採らない。生成コードの品質低下が差し戻しを増やし、
往復が増えれば時間も費用も悪化する。

**`CODE_PROVIDER=llm` にする前に `scripts/verify-codegen.mts` を通すこと。**
LLMの応答は期待した形で返るとは限らない(ファイルを取り出せない・`index.html` が無い・
外部CDNを参照する)。商談中にそれが起きると、そこで試作品が出せなくなる。

**雛形(既定)では差し戻しても意味がない。** `TemplateCodeProvider` は `review.md` を
読まないため、やり直すと**必ず同じ出力**になる。Orchestrator は前回と同じ生成物を
指紋で検出してその場で打ち切る(`code.unchanged`)。気づかずに回すと Review Agent
(Opus 5)を2回余計に呼び、商談中の40秒を捨てたうえで同じ結論に辿り着く。

## 1商談あたりの費用

30分の商談、Issue Agent が60秒間隔で実効25回、`CODE_PROVIDER=template` の場合で
**およそ $0.6(約90円)**。`CODE_PROVIDER=llm` では差し戻しなしで約 $0.85、
3往復で約 $1.45。支配的なのは Issue Agent の累積(`issues.md` と `ideas.md` を毎回同梱するため
入力が伸びる)と、Opus 5 で走る requirement / code / review。

費用は制約にならない。**制約になるのは時間のほう。**

---

# 新しいAgentを追加するとき

1. 責務を1行で書けるか確認する。書けないなら分割する。
2. 入力Markdownと出力Markdownを決める。出力ファイルの所有者は自分だけにする。
3. 上のファイル所有者表と実行順序に追記する。
4. Orchestratorに起動条件を追加する。**他Agentのコードは一切変更しないこと。**
5. 変更が他Agentに波及したなら、それは責務の切り方が間違っている。
