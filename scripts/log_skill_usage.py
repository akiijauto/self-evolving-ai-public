#!/usr/bin/env python3
"""スキル/MCP自己整理スクリプト(アイデア3)の使用頻度ログ記録用コマンド。

どのAIツールでも、スキル/MCPを使うたびに1行追記する。
`skill_triage.py` がこのログを集計して閾値以下のものを2軍フォルダへ移動する。
"""
import argparse
import json
import pathlib
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
USAGE_LOG = ROOT / "context" / "skill_usage.jsonl"


def main():
    parser = argparse.ArgumentParser(description="スキル/MCPの使用ログを1件追記する")
    parser.add_argument("--date", required=True, help="YYYY-MM-DD形式")
    parser.add_argument("--actor", required=True, help="例: claude-code, gpt-codex")
    parser.add_argument("--skill-name", required=True, help="スキル/MCP名(ディレクトリ名と一致させる)")
    args = parser.parse_args()

    USAGE_LOG.parent.mkdir(parents=True, exist_ok=True)
    entry = {"date": args.date, "actor": args.actor, "skill_name": args.skill_name}
    with USAGE_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"追記しました: {USAGE_LOG}")


if __name__ == "__main__":
    main()
