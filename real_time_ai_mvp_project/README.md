# RealTime AI MVP Generator

## 概要

本プロジェクトは

会話をリアルタイム解析し

・議事録
・課題抽出
・要件定義
・MVP生成

まで自動実行する営業支援システムである。

営業資料を見せるのではなく

「その場でアプリが完成する」

という体験を提供することを目的とする。

---

## 開発方針

入力方法には依存しない。

全データをMarkdownへ正規化し、
各AIエージェントがMarkdownのみを処理する。

---

## MVP

Phase1

リアルタイム文字起こし

↓

Markdown

↓

MVP生成

ここまでを最初の完成形とする。

---

## ドキュメント

| ファイル | 読むべきタイミング |
| --- | --- |
| [PROJECT.md](./PROJECT.md) | 何を作るのか / なぜ作るのかを知りたいとき |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 機能・非機能・スコープ外を確認するとき |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 実装に入るとき(構成図・API一覧・WebSocket仕様) |
| [DATAFLOW.md](./DATAFLOW.md) | Markdownスキーマとデータの流れを確認するとき |
| [AGENTS.md](./AGENTS.md) | 各AIエージェントを実装・改修するとき |
| [ROADMAP.md](./ROADMAP.md) | 次に何を作るかを決めるとき |
| [RETROSPECTIVE.md](./RETROSPECTIVE.md) | なぜこの方針になったかを遡るとき |

AIエージェント(Claude Code等)が実装に入る場合は、
**ARCHITECTURE.md → AGENTS.md → DATAFLOW.md** の順に読むこと。

---

## 現在の状態

**Sprint 1〜7を実装済み。** マイク入力 / 音声ストリーミング / リアルタイム文字起こし /
Markdown生成 / オーケストレーター / MVP生成・配信・URL提示 / 運用と本番構築。

```
real_time_ai_mvp_project/
├── *.md          設計ドキュメント(この一覧)+ DEPLOY.md / OPERATIONS.md
├── scripts/      構築(setup-vps / setup-nginx / update)と検証(preflight / verify-llm)
├── protocol/     クライアントとサーバーで共有する通信プロトコルの型
├── app/          PWA
└── server/       Gateway Server
```

```bash
npm install                       # ルートで1回(npm workspaces)
npm test                          # 全ワークスペースのテスト
npm run dev --workspace server    # :8787
npm run dev --workspace app       # :5173
```

セットアップの詳細は [app/README.md](./app/README.md) と [server/README.md](./server/README.md) を参照。

音声認識もLLMもコード生成も、既定でモック/雛形を使う。実APIの資格情報は未設定。
**資格情報なしで、音声 → 文字起こし → 課題抽出 → 要件定義 → 画面設計 → コード生成 →
配信URL まで通して動く。** 生成されたアプリはブラウザで実際に操作できる。

商談のMarkdownと生成物は `server/data/sessions/{sessionId}/` に溜まる(リポジトリには入れない)。

残っている確認は、いずれも**実APIキーか実機が要るもの**:
実STT APIでの話者分離精度、実LLM APIでの抽出品質とコスト、
実機スマートフォンでのPWAインストールとQR読み取り。

本番への構築は [DEPLOY.md](./DEPLOY.md)、営業担当の操作は [OPERATIONS.md](./OPERATIONS.md)。
進捗と完了条件は [ROADMAP.md](./ROADMAP.md) を参照。

---

## 用語

| 用語 | 意味 |
| --- | --- |
| セッション | 1回の商談。開始から終了までを1単位とする |
| 正規化 | 任意の入力をMarkdownの規定スキーマへ変換すること |
| オーケストレーター | Markdownを読み、各エージェントの実行順序を決める中核 |
| トリガーキーワード | MVP生成を開始する発話(「この内容でアプリ作って」等) |
| 生成MVP | セッション中に自動生成される、デモ用のWebアプリ |
