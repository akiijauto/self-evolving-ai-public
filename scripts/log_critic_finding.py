#!/usr/bin/env python3
"""評価役(Critic)の指摘を記録するコマンド。

5役構成(実行役/評価役/省察・記憶役/長期記憶/メタ司令役)のうち、
これまで欠けていた「評価役」を独立した記録として持てるようにする。

運用の考え方:
- 実行役(Generator)が成果物を作ったら、それとは別に「批判的に検証する視点」で
  レビューを行う(同じAIが視点を変えて見直す/別セッションでレビューする、
  いずれでも良い。このスクリプトはその結果を記録する部分だけを担う)。
- 指摘(finding)は severity(重大度)付きで `context/critic_findings.jsonl` に
  追記専用で記録する。
- `high` severity の指摘は `regenerate_criteria.py` が判断基準候補の材料として
  拾い上げる(= 評価役の指摘が省察・記憶役/長期記憶/メタ司令役の更新ループに
  つながる)。

使い方:
    python scripts/log_critic_finding.py \
        --date 2026-07-29 \
        --actor claude-code \
        --artifact "scripts/foo.py" \
        --finding "例外処理が漏れており、不正な入力でクラッシュする" \
        --severity high \
        --verdict fail
"""
import argparse
import json
import pathlib
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
FINDINGS_FILE = ROOT / "context" / "critic_findings.jsonl"

VALID_SEVERITIES = ("low", "medium", "high")
VALID_VERDICTS = ("pass", "fail")


def main():
    parser = argparse.ArgumentParser(description="評価役(Critic)の指摘を1件追記する")
    parser.add_argument("--date", required=True, help="YYYY-MM-DD形式")
    parser.add_argument("--actor", required=True, help="評価を行った主体。例: claude-code, gpt-codex, human")
    parser.add_argument("--artifact", required=True, help="評価対象(ファイルパス・PR・出力内容の説明など)")
    parser.add_argument("--finding", required=True, help="指摘内容(何が問題か)")
    parser.add_argument("--severity", required=True, choices=VALID_SEVERITIES, help="low / medium / high")
    parser.add_argument("--verdict", required=True, choices=VALID_VERDICTS, help="pass(問題なし) / fail(要修正)")
    args = parser.parse_args()

    entry = {
        "date": args.date,
        "actor": args.actor,
        "artifact": args.artifact,
        "finding": args.finding,
        "severity": args.severity,
        "verdict": args.verdict,
    }

    FINDINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with FINDINGS_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"追記しました: {FINDINGS_FILE}")
    print(json.dumps(entry, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
