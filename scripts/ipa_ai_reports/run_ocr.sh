#!/usr/bin/env bash
# OCR をまとめて流す。catalog.json の書き戻しが衝突しないよう直列に実行する。
# 途中で止まっても、済んだ資料は自動的に対象外になるので再実行すればよい。
set -u
cd "$(dirname "$0")/../.." || exit 1

# tesseract は 1 スレッドに固定してあるので、CPU 数ぶんのプロセス並列が最も速い
JOBS="${JOBS:-$(nproc)}"
# 1ページあたりの文字数がこれ未満なら図表主体とみなして OCR で補完する。
# 調査データ集はグラフ内の数値がテキストレイヤに入らず 500〜600 字/頁 になる
SUPPLEMENT_THRESHOLD="${SUPPLEMENT_THRESHOLD:-700}"

echo "=== [1/3] テキストレイヤ破損の再OCR ==="
python3 scripts/ipa_ai_reports/extract.py --jobs "$JOBS" --ocr-broken

echo "=== [2/3] 図表主体の資料のOCR補完 ==="
python3 scripts/ipa_ai_reports/extract.py --jobs "$JOBS" --ocr-supplement "$SUPPLEMENT_THRESHOLD"

echo "=== [3/3] Markdown と一覧の再生成 ==="
# crawl.py は掲載ページのリンク文字列をそのまま題名に使うので、
# 既知の誤記の修正と published の補完をここで毎回かけ直す（冪等）
python3 scripts/ipa_ai_reports/fix_catalog.py
python3 scripts/ipa_ai_reports/to_markdown.py
python3 scripts/ipa_ai_reports/auto_outline.py --force
python3 scripts/ipa_ai_reports/summary_queue.py
python3 scripts/ipa_ai_reports/make_index.py
echo "=== 完了 ==="
