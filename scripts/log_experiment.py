#!/usr/bin/env python3
"""小さく試して採否を記録する実験フロー(アイデア8)。

新しい技術・やり方を「サンドボックスで小さく試す」→「採否を記録する」を
軽量に支える。実験そのものの実行はこのスクリプトの外(呼び出し側のAI)が行い、
このスクリプトは結果の記録だけを担う。

記録先: context/experiments/log.jsonl(追記専用)
      + context/experiments/<slug>.md(実験の詳細メモ、任意)

使い方:
    python scripts/log_experiment.py \
        --date 2026-07-28 \
        --name "新しいプロンプトキャッシュ手法の検証" \
        --hypothesis "cache_prefixを分割すればヒット率が上がるはず" \
        --result "ヒット率が実際に10%改善した" \
        --verdict success \
        --note "call_claude_jsonに組み込み予定"

--verdict は success / failure / inconclusive のいずれかを推奨(自由記述可)。
"""
import argparse
import json
import pathlib
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXPERIMENTS_DIR = ROOT / "context" / "experiments"
LOG_FILE = EXPERIMENTS_DIR / "log.jsonl"


def slugify(name: str) -> str:
    slug = re.sub(r"[^\w\-]+", "_", name.strip(), flags=re.UNICODE)
    return slug.strip("_")[:60] or "experiment"


def main():
    parser = argparse.ArgumentParser(description="実験の採否を記録する")
    parser.add_argument("--date", required=True, help="YYYY-MM-DD形式")
    parser.add_argument("--name", required=True, help="実験名")
    parser.add_argument("--hypothesis", required=True, help="試した仮説")
    parser.add_argument("--result", required=True, help="実際に得られた結果")
    parser.add_argument("--verdict", required=True, help="success / failure / inconclusive など")
    parser.add_argument("--note", default="", help="補足(次にどうするか等)")
    args = parser.parse_args()

    EXPERIMENTS_DIR.mkdir(parents=True, exist_ok=True)

    entry = {
        "date": args.date,
        "name": args.name,
        "hypothesis": args.hypothesis,
        "result": args.result,
        "verdict": args.verdict,
        "note": args.note,
    }

    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"追記しました: {LOG_FILE}")

    slug = slugify(args.name)
    detail_path = EXPERIMENTS_DIR / f"{args.date}_{slug}.md"
    lines = [
        f"# 実験: {args.name}",
        "",
        f"- 日付: {args.date}",
        f"- 仮説: {args.hypothesis}",
        f"- 結果: {args.result}",
        f"- 採否: {args.verdict}",
    ]
    if args.note:
        lines.append(f"- 補足: {args.note}")
    detail_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"詳細メモを作成しました: {detail_path}")


if __name__ == "__main__":
    main()
