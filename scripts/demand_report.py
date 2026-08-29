#!/usr/bin/env python3
"""収集済みの需要データからNotion用のMarkdownレポートを生成する。

生成物は context/reports/demand_<日付>.md。Notionへの反映は
このMarkdownをそのまま子ページの本文として貼るだけで済むようにしてある。

使い方:
    python scripts/demand_report.py --date 2026-08-02
    python scripts/demand_report.py --date 2026-08-02 --stdout

依存ライブラリなし(標準ライブラリのみ)。
"""
import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from demand import report  # noqa: E402

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPORT_DIR = ROOT / "context" / "reports"


def main():
    parser = argparse.ArgumentParser(description="需要データのMarkdownレポートを生成する")
    parser.add_argument("--date", required=True, help="対象日(YYYY-MM-DD)")
    parser.add_argument("--stdout", action="store_true", help="ファイルに書かず標準出力に出す")
    args = parser.parse_args()

    body = report.build(args.date)

    if args.stdout:
        print(body)
        return 0

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / ("demand_%s.md" % args.date)
    path.write_text("# %s 需要ランキング\n\n%s" % (args.date, body), encoding="utf-8")
    print("生成しました: %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
