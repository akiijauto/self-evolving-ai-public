#!/usr/bin/env bash
# 要約整形バッチを 1 本まわす（ローカル PC 用）。
#
#   ./scripts/ipa_ai_reports/run_summary_batch.sh            # 1バッチ実行
#   ./scripts/ipa_ai_reports/run_summary_batch.sh --dry-run  # 対象の確認だけ
#   BUDGET=200000 ./scripts/ipa_ai_reports/run_summary_batch.sh
#
# 必要なもの: Claude Code CLI (`claude`)、python3
# 処理量は文書量で決まる。大部の白書なら1件、小さい資料ならまとめて数件。
set -euo pipefail
cd "$(dirname "$0")/../.."

BUDGET="${BUDGET:-400000}"
MAX_DOCS="${MAX_DOCS:-6}"
MODEL="${MODEL:-opus}"
QUEUE=scripts/ipa_ai_reports/summary_queue.py

python3 "$QUEUE" --show-batch --budget "$BUDGET" --max-docs "$MAX_DOCS"
IDS=$(python3 "$QUEUE" --next-batch --budget "$BUDGET" --max-docs "$MAX_DOCS")

if [ -z "$IDS" ]; then
  echo "未要約の資料はありません。完了です。"
  exit 0
fi
if [ "${1:-}" = "--dry-run" ]; then
  exit 0
fi

read -r -d '' PROMPT <<EOF || true
data/ipa-ai-reports/TEMPLATE.md を読み、そのフォーマットとルールを厳守して、
次の資料の要約整形版を作成してください。

対象id: $IDS

- 入力 data/ipa-ai-reports/text/<id>.txt → 出力 data/ipa-ai-reports/markdown/<id>.md
  （既存の自動生成版は上書きしてよい）
- メタ情報は data/ipa-ai-reports/catalog.json から該当idだけ python3 -c で引く（全文Readはしない）
- 1件ずつ「必要な範囲を読む→すぐ書く」を繰り返す。全件読んでから書き始めない
- 大部の資料（白書全文・合本など）は全文書き起こしをせず、目次・構成・各章の要点を
  俯瞰するインデックス的な整理にし、その方針を「## 本文の整理」冒頭に明記する。
  読むのは目次・各章冒頭・章末まとめ・図表キャプション・主要数値に絞り、全文通読はしない
- 調査データ集・集計表・調査票はMarkdownの表に忠実に起こすことを優先し、
  n数・選択肢・割合は原文の値のまま残す
- 文字起こしが tesseract の OCR 版（ヘッダに「テキストレイヤ破損のため」とある、
  または ページ区切りが === [page N] === 形式）の場合、OCR 特有の誤認識がある。
  文脈から明らかな誤りは補ってよいが、判断できない箇所は（判読不能）と明記し、
  グラフの数値は合計から逆算した値を書かない
- <id>.textlayer.txt がある資料は、OCR 前のテキストにグラフの数値だけ残っている
  ことがある。両方を突き合わせて使うこと
- <id>.ocr.txt がある資料は図中文字の補完版。突き合わせて取りこぼしを減らす
- 原文にない事実を書かない。数値・固有名詞は原文どおり
- 書き込みは data/ipa-ai-reports/markdown/ 配下の対象ファイルのみ。git操作はしない
EOF

echo "=== 要約整形を開始します（model=$MODEL） ==="
claude --model "$MODEL" --permission-mode acceptEdits -p "$PROMPT"

echo "=== 一覧を更新します ==="
python3 "$QUEUE" | head -5
python3 scripts/ipa_ai_reports/make_index.py

git add -A data/ipa-ai-reports
if git diff --cached --quiet; then
  echo "更新はありませんでした。"
else
  git commit -m "IPA AIレポートの要約整形バッチを追加"
  git push origin "$(git branch --show-current)"
fi
