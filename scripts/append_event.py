#!/usr/bin/env python3
"""どのAIツールからでも呼び出せる、共有コンテキストへのイベント追記コマンド。

依存ライブラリなし(標準ライブラリのみ)。Claude Code / GPT Codex / その他どの
ツールからも `python scripts/append_event.py ...` で同じ形式のイベントを
context/events.jsonl に追記できる。

使い方:
    python scripts/append_event.py \
        --actor claude-code \
        --type decision \
        --summary "○○という理由で△△を採用した"

type は decision / error / success / todo / milestone のいずれかを推奨(自由記述可)。
"""
import argparse
import json
import pathlib
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parent.parent
EVENTS_FILE = ROOT / "context" / "events.jsonl"


def main():
    parser = argparse.ArgumentParser(description="共有コンテキストにイベントを1件追記する")
    parser.add_argument("--date", help="YYYY-MM-DD形式。省略時は呼び出し側が指定すること(スクリプト側ではDate.now()相当を使わない)")
    parser.add_argument("--actor", required=True, help="例: claude-code, gpt-codex, human")
    parser.add_argument("--type", required=True, help="decision / error / success / todo / milestone など")
    parser.add_argument("--summary", required=True, help="1〜2文の要約")
    args = parser.parse_args()

    if not args.date:
        print("エラー: --date は必須です(例: --date 2026-07-28)。実行環境の現在日付をAI自身が把握し指定してください。", file=sys.stderr)
        sys.exit(1)

    event = {
        "date": args.date,
        "actor": args.actor,
        "type": args.type,
        "summary": args.summary,
    }

    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with EVENTS_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

    print(f"追記しました: {EVENTS_FILE}")
    print(json.dumps(event, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
