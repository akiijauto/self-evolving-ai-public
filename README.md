# self-evolving-ai

AIツールの種類(Claude Code / GPT Codex / その他)に関わらず、同じ場所に同じ形式で
コンテキストが蓄積される基盤。詳細な設計・ロードマップは [要件定義.md](./要件定義.md) を参照。

## セットアップ

依存ライブラリなし。Python 3.8以上があれば動作する。

```bash
git clone <このリポジトリのURL>
cd self-evolving-ai
python --version   # 3.8+ であることを確認
```

環境変数は不要(外部APIを一切呼ばないため)。

## 使い方(Claude Code / Codex 共通)

どのAIツールでも、以下の3操作だけで共有コンテキストを扱える。

### 1. タスク開始時: 判断基準を読む

`context/criteria/CURRENT.md` を読み込み、その内容に従ってタスクを進める。

### 2. タスク中: イベントを記録する

決定・エラー・成功パターンがあれば都度追記する。

```bash
python scripts/append_event.py \
  --date 2026-07-28 \
  --actor claude-code \
  --type decision \
  --summary "○○という理由で△△を採用した"
```

`--actor` はツール名を入れる(`claude-code` / `gpt-codex` など)。
`--date` は必須(スクリプト側では現在日時を自動取得しない。呼び出し側のAIが
把握している日付を明示的に渡すこと)。

### 評価役(Critic): 成果物を客観的にチェックする

実行役が成果物を作った後、別の視点(可能なら別セッション/別レビュー)で
批判的に検証し、指摘を記録する。実行役の自己申告(`decision`/`error`イベント)
だけに頼らないための独立した工程。

```bash
python scripts/log_critic_finding.py \
  --date 2026-07-28 \
  --actor claude-code \
  --artifact "scripts/foo.py" \
  --finding "例外処理が漏れており不正な入力でクラッシュする" \
  --severity high \
  --verdict fail
```

`--severity` は `low` / `medium` / `high`、`--verdict` は `pass` / `fail`。
`severity: high` かつ `verdict: fail` の指摘は、判断基準の自動更新ループ
(`regenerate_criteria.py`)と振り返り自動生成(`generate_reflection.py`)の
両方で、実行役の自己申告とは別枠の材料として扱われる。

### 3. 週次(目安): 判断基準を見直す

```bash
# 1) 蓄積されたイベント/振り返りから候補を生成
python scripts/regenerate_criteria.py

# 2) 生成された context/criteria/PROPOSED.md を人間が確認

# 3) 承認する(対話的に y/N を聞かれる)
python scripts/approve_criteria.py

# スケジューラなど非対話実行の場合
python scripts/approve_criteria.py --yes
```

承認すると、旧バージョンは `context/criteria/history/` にタイムスタンプ付きで
退避され、`CURRENT.md` が更新される。この変更はgit commitでコミットし、
バージョン履歴として残すこと。

### 振り返りの記録(手動 / 自動生成)

手動なら `context/reflections/YYYY-MM-DD.md` に「やったこと」「課題と対策」
「次回に向けて」を記録する。

自動生成する場合は、その日のイベントを `events.jsonl` に記録した上で:

```bash
python scripts/generate_reflection.py --date 2026-07-28
```

`error` / `success` / `todo` タイプのイベント、需要収集が自動記録する
`demand_signal`(件数急減) / `demand_alert`(収集失敗・0件)、評価役(Critic)が記録した
`severity: high` かつ `verdict: fail` の指摘から3見出しの振り返りを自動生成する。
振り返りファイルが5の倍数に達すると `context/reflections/_review/REVIEW_<n>.md`
に直近5件の一覧を自動生成する(CLAUDE.mdの「5回ごとに全体を見直し」ルールと連動)。

### タスク実行前: プロンプトの自己レビュー

「目的・手段・アウトプット」が指示文に含まれているかを軽量にチェックする
(LLM呼び出しなし、判定はヒューリスティック)。

```bash
python scripts/prompt_self_review.py --text "目的は...手段は...アウトプットは..."
```

### 実験の記録(小さく試して採否を残す)

```bash
python scripts/log_experiment.py \
  --date 2026-07-28 --name "実験名" \
  --hypothesis "仮説" --result "結果" --verdict success --note "補足"
```

`context/experiments/log.jsonl`(追記ログ)と詳細メモ(`.md`)が生成される。

### スキル/MCPの棚卸し

使うたびに使用ログを記録し、閾値未満のものを棚卸しする。既定はレポートのみ
(dry-run)。実際にフォルダを移動するには `--apply` が必要。

```bash
python scripts/log_skill_usage.py --date 2026-07-28 --actor claude-code --skill-name <スキル名>

python scripts/skill_triage.py --skills-dir /path/to/skills --threshold 3
# レポートに納得したら実際に2軍フォルダへ移動
python scripts/skill_triage.py --skills-dir /path/to/skills --threshold 3 --apply
```

### CLAUDE.md / AGENT.MDの自己診断

対象ファイルは変更せず、行数・見出し構成・MCP言及数などのレポートのみ生成する。

```bash
python scripts/agent_md_diagnostic.py --path "C:/Users/<user>/AI開発/CLAUDE.md" --date 2026-07-28
```

### ローカルPCコンテキストのバックアップ(まずはこれだけ)

対象パスとバックアップ先(Google Driveのローカルフォルダ)を自動検出するので、
通常は日付を渡すだけでよい。

```bash
# 1) 確認(何も書き込まない)
python scripts/backup_run.py --date 2026-08-02

# 2) 内容に納得したら実行
python scripts/backup_run.py --date 2026-08-02 --apply
```

`backup_run.py` は「棚卸し → 同期(dry-run/実行) → 検証」を順に呼び出すだけの
ラッパー。個別に制御したいときは下記の各スクリプトを直接使う。

自動検出の内訳:

- **対象**: `~/AI開発`・`~/.claude/CLAUDE.md`・`~/.claude/skills` 等のうち実在するもの。
  セッションログ(`~/.claude/projects`)と `Documents` / `Desktop` は既定で対象外
  (巨大かつ秘密情報が残りやすいため。含めるなら `--include-all`)。
- **対象ディレクトリの中のセッションログ**も既定で除外する。
  `~/.codex` のように設定とセッションログが同じディレクトリに同居している場合、
  ディレクトリ単位で指定すると容量の大半がログになるため
  (`.codex/sessions` `.codex/log` `.claude/shell-snapshots` など)。
  任意のパターンを足すなら `--exclude "*/foo/bar"`、既定を無効にするなら
  `--no-default-excludes`。
- **バックアップ先**: `--dest` で明示するのが確実。省略時はGoogle Driveの
  ローカル実体(ミラーリング設定の場合)を探すが、下記の「マイ パソコン」構成では
  自動検出に頼らず `--dest` を渡す。

```bash
python scripts/backup_run.py --date 2026-08-03 --dest "C:/context-backup" --apply
```

実績(2026-08-03): 1433件 / 24.9MB を `C:\context-backup` へコピーし、
ハッシュ照合で全件一致を確認。除外パターンの調整で 7253件/192.4MB から約87%削減した
(削れたのはプラグインのキャッシュ・実行ファイル・モデルデータなど再取得可能なもの)。

### バックアップ対象の棚卸しだけを行う(フェーズA)

ローカルPCにしか無いコンテキスト(CLAUDE.md・スキル定義・ノート等)の
バックアップ対象を棚卸しする。**読み取り専用**で、コピー・移動・削除は行わない。

```bash
# 1) まず何がPCにあるかを調べる(推奨候補パスの存在確認だけ)
python scripts/backup_manifest.py --detect --date 2026-07-31

# 2) 対象を決めたら走査してmanifestを生成する
python scripts/backup_manifest.py --date 2026-07-31 \
  --source "C:/Users/<user>/AI開発" \
  --source "C:/Users/<user>/.claude/skills=A"
```

`--source` は `PATH` または `PATH=TIER`(TIERは A/B/C)。
出力は `context/backup/`(ローカル絶対パスを含むため `.gitignore` 対象)。
`.env` や `credentials*` 等の認証情報らしきファイルは中身を読まずに除外し、
除外件数だけレポートに出す。

### バックアップの実行と検証(フェーズB)

生成したmanifestに従ってGoogle Driveの同期フォルダへコピーし、
コピー後にハッシュ照合で「本当に復元できる状態か」を確認する。

```bash
# 3) まずdry-runで何が起きるか確認する(--applyが無い限り書き込まない)
python scripts/backup_sync.py --date 2026-07-31 --dest "G:/マイドライブ/context-backup"

# 4) 納得したら実行
python scripts/backup_sync.py --date 2026-07-31 --dest "G:/マイドライブ/context-backup" --apply

# 5) 復元可能かを検証(欠損・改変があれば終了コード1)
python scripts/backup_verify.py --date 2026-07-31 --dest "G:/マイドライブ/context-backup"
```

安全のため、`backup_sync.py` は**削除を一切しない**(同期先の余分なファイルは
報告するだけ)。認証情報らしきファイルがコピー対象に混入していた場合は、
1件でもあればコピーせず中断する。

#### 正本(single source of truth)はローカルPC側

同期は **ローカルPC → バックアップ先の一方向のみ**。逆方向のコピーは実装していない。
バックアップ先(Google Drive)のファイルは編集しないこと。

バックアップ先には `_このフォルダはバックアップです.md` が自動生成され、
正本の絶対パスが書かれる。加えて `_backup_state.json` に前回書き込んだ内容の
ハッシュを記録しており、**バックアップ先が直接編集されていた場合は上書きせず
「要確認」として報告する**(終了コード1)。上書きしてよいと判断したときだけ:

```bash
python scripts/backup_sync.py --date 2026-07-31 --dest "..." --apply --force-overwrite
```

#### クラウド(Google Drive)への上げ方

**マイドライブのミラーリングは使わない。** ミラーリングはマイドライブ全体を
ローカルにダウンロードするため、マイドライブが大きい環境では割に合わない。

代わりに方向を逆にする。ローカルにバックアップ先を作って `backup_sync.py` は
そこへ書き、そのフォルダを Drive の**「マイ パソコン」区画**に登録してクラウドへ上げる。

```
正本(ローカル) --backup_sync.py--> C:\context-backup --Driveの「マイ パソコン」--> クラウド
```

登録手順: Google Drive の設定 → 左パネル「マイ パソコン」→ フォルダを追加 →
バックアップ先フォルダを選択 → 「Google ドライブと同期する」にチェック
(「Google フォトにバックアップ」はチェックしない)。

これで「ローカルの正本」「ローカルの複製」「クラウドの複製」の3コピーになる。

### 復元(フェーズD)

バックアップは「取れているか」ではなく「戻せるか」で価値が決まる。復元も
スクリプトで行い、復元後にsha256照合まで自動で走る。

```bash
# 何が復元されるか確認(書き込みなし)
python scripts/backup_restore.py --date 2026-08-03 \
  --dest "C:/context-backup" --to "C:/restore-work"

# 実行
python scripts/backup_restore.py --date 2026-08-03 \
  --dest "C:/context-backup" --to "C:/restore-work" --apply
```

**正本の場所へは直接書き戻さない。** 別ディレクトリへ展開し、中身を確認してから
人間が移す(`backup_sync.py` を一方向にしているのと同じ理由)。
復元先に既存ファイルがあれば上書きせずスキップする(`--overwrite` で上書き)。
`--only <ラベル>` で一部だけ復元することもできる。

手順の全体(新PCへの移行、除外したものの入れ直し、復元訓練)は
[復元手順.md](./復元手順.md) を参照。

### 定期実行(Windowsタスクスケジューラ)

バックアップ対象はローカルファイルなので、claude.aiのルーティン(クラウド実行)
からは読めない。Windowsのタスクスケジューラに登録する。

```powershell
# 何が登録されるか確認
powershell -ExecutionPolicy Bypass -File scripts\register_backup_task.ps1 -Dest "C:\context-backup" -WhatIf

# 毎日12:00に実行するよう登録
powershell -ExecutionPolicy Bypass -File scripts\register_backup_task.ps1 -Dest "C:\context-backup"

# 解除
powershell -ExecutionPolicy Bypass -File scripts\register_backup_task.ps1 -Unregister
```

自動実行しても意図しない消失は起きない(削除を一切行わず、バックアップ先が
直接編集されていた場合も上書きせずスキップするため)。

設計の全体像は
[コンテキストバックアップ設計.md](./コンテキストバックアップ設計.md) を参照。

### Discordへの通知

Webhook URLはリポジトリにもスクリプトにもハードコードしない
(`--webhook-url` 引数、または `DISCORD_WEBHOOK_URL` 環境変数で渡す)。

```bash
python scripts/notify_discord.py --webhook-url "https://discord.com/api/webhooks/..." --message "本文"
```

## 需要データ収集システム (demand/)

ECサイトの売れ筋・スキルマーケットの人気サービス・企業の求人動向を、
**各サイトの規約を守った手段でのみ**収集し、ランキング形式に正規化して
Notionへ蓄積するサブシステム。

### 中心にある考え方: 規約遵守をコードで強制する

規約確認を運用ルール(人間の心がけ)に委ねると、収集元が増えたときに必ず抜ける。
そのため `demand/sources.json` に規約確認の証跡が残っている収集元しか
実行できない構造にしている。

収集手段は規約リスクで4段階に格付けする。

| Tier | 手段 | 扱い |
|---|---|---|
| 1 | 公式API | 実行可 |
| 2 | 公式RSS/公開フィード/公的オープンデータ | 実行可 |
| 3 | robots.txt が許可し、規約にも禁止条項がないページの低頻度取得 | `--allow-tier3` の明示指定が必要 |
| 4 | 規約またはrobots.txtで禁止された取得 | **常に拒否**(フラグを付けても実行されない) |

robots.txt が ClaudeBot / GPTBot 等のAIクローラーを拒否しているサイトは、
User-Agent を変えれば技術的に取得できても `rejected` として扱う。
UAを変えて拒否を回避する行為はサイト運営者の意思表示に反するため。

### 使い方

```bash
# 何が実行され、何がなぜスキップされるかを確認する(通信しない)
python scripts/demand_collect.py --date 2026-08-02 --dry-run

# 収集して context/demand/<日付>.jsonl に保存
python scripts/demand_collect.py --date 2026-08-02

# Notionへ貼れるMarkdownを生成(context/reports/demand_<日付>.md)
python scripts/demand_report.py --date 2026-08-02

# 収集元のrobots.txtを実際に取得して許可状況を確認
python scripts/demand_check_robots.py --date 2026-08-02
```

Notionへの自動反映は `scripts/demand_publish_notion.py`。認証情報は
環境変数(`NOTION_TOKEN` / `NOTION_PARENT_PAGE_ID`)からのみ受け取り、
リポジトリには一切残さない。

日次実行は `.github/workflows/demand-collect.yml`(毎日 7:10 JST)。
`NOTION_TOKEN` が未設定の場合、Notion反映だけがスキップされ、
Markdown生成とコミットまでは動く。

### 収集元を追加する手順

1. `scripts/demand_check_robots.py --url <対象URL>` で robots.txt を確認する
2. 対象サイトの利用規約に自動収集の禁止条項がないか確認する
3. `demand/sources.json` に規約URL・確認日・Tier を記載する
4. `demand/collectors/<収集元名>.py` に `@base.register` 付きの
   `collect(source, captured_at)` を実装する
5. `demand/collectors/__init__.py` に import を1行足す

## 定期報告の自動化(日次ルーティン)

claude.aiの「ルーティン」機能(`RemoteTrigger`)で、毎日0:00 UTC(9:00 JST)に
以下を自動実行している(設定はclaude.ai側で管理、リポジトリ内には無い):

1. `generate_reflection.py` でその日の振り返りを生成
2. `regenerate_criteria.py` で判断基準候補(PROPOSED.md)を更新
3. 変更があれば commit & push
4. その日の要約と判断基準候補の有無を GitHub Issue として作成
5. 同じ内容を `notify_discord.py` でDiscordの専用チャンネルにも通知

判断基準の`CURRENT.md`への反映(`approve_criteria.py`)は自動実行されない
(必ず人間の承認を経る運用ルールをそのまま維持)。

## ディレクトリ構成・フォーマット詳細

[要件定義.md](./要件定義.md) を参照。

## 役割構成(5役モデル)

「実行役/評価役/省察・記憶役/長期記憶/メタ司令役」という5役構成に照らした
現在の対応関係は [要件定義.md](./要件定義.md) の「役割構成」を参照。

## 今後の展望

8つの自己発展アイデアのうち、7つ(1・2・3・4・5・6・8)を実装済み。
残る「7. 外部トレンド自動トリアージ」は外部サービス連携が前提となるため未着手
(詳細は [要件定義.md](./要件定義.md) を参照)。

---

## この公開版について

本リポジトリは開発リポジトリから**コードとドキュメントのみ**を抽出した公開版です。
以下は含まれません:

- `data/` — 収集した外部資料（IPA白書等の第三者著作物のため）
- `context/` — 運用中に蓄積した判断基準・イベント・需要データの実体
- 投資スクリーニング関連のサブプロジェクト

そのため `context/` を参照するコマンド例は、そのままでは動きません。
`scripts/` と `demand/` のコードは初期状態から実行可能です。
