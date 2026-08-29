#!/usr/bin/env python3
"""AGENT.MD自己診断レポート(アイデア5)。

指定したCLAUDE.md/AGENT.MD相当のファイルを読み込み、行数・見出し構成・
MCP/スキルへの言及数などを棚卸しし、レポートを生成する。

重要: このスクリプトは対象ファイルを一切変更しない(読み取り専用)。
変更が必要かどうかの判断・実施は人間(または別タスクのAI)に委ねる。

使い方:
    python scripts/agent_md_diagnostic.py --path "C:/Users/<user>/AI開発/CLAUDE.md" --date 2026-07-28
"""
import argparse
import pathlib
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPORTS_DIR = ROOT / "context" / "reports"

LINE_LIMIT = 200  # CLAUDE.mdの運用ルールで定めている上限


def analyze(text: str):
    lines = text.splitlines()
    headings = [l for l in lines if re.match(r"^#{1,6}\s", l)]
    mcp_mentions = re.findall(r"mcp__[\w\-]+", text)
    skill_mentions = re.findall(r"/[a-zA-Z][\w\-]*", text)  # スラッシュコマンド/スキル呼び出しの粗い検出
    todo_like = [l for l in lines if re.search(r"TODO|未着手|未実装", l)]

    return {
        "line_count": len(lines),
        "over_limit": len(lines) > LINE_LIMIT,
        "heading_count": len(headings),
        "headings": headings,
        "unique_mcp_mentions": sorted(set(mcp_mentions)),
        "mcp_mention_count": len(mcp_mentions),
        "slash_like_mention_count": len(set(skill_mentions)),
        "todo_like_lines": todo_like,
    }


def build_report(path, date, result):
    lines = [
        f"# AGENT.MD自己診断レポート ({date})",
        "",
        f"- 対象ファイル: {path}",
        f"- 行数: {result['line_count']} (上限目安: {LINE_LIMIT}行)",
        f"- 上限超過: {'はい' if result['over_limit'] else 'いいえ'}",
        f"- 見出し数: {result['heading_count']}",
        f"- MCPツールへの言及数(ユニーク): {len(result['unique_mcp_mentions'])} "
        f"(延べ {result['mcp_mention_count']}件)",
        "",
    ]
    if result["unique_mcp_mentions"]:
        lines.append("## 言及されているMCPツール")
        lines.append("")
        for m in result["unique_mcp_mentions"]:
            lines.append(f"- {m}")
        lines.append("")

    if result["todo_like_lines"]:
        lines.append("## TODO/未着手/未実装らしき記述")
        lines.append("")
        for l in result["todo_like_lines"]:
            lines.append(f"- {l.strip()}")
        lines.append("")

    lines.append("## 見出し一覧")
    lines.append("")
    for h in result["headings"]:
        lines.append(f"- {h.strip()}")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("(このレポートは読み取り専用の棚卸しです。対象ファイルへの変更は行っていません。"
                 "変更が必要かどうかは人間が判断してください。)")

    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="CLAUDE.md/AGENT.MD相当のファイルを棚卸しし、レポートのみ生成する(対象ファイルは変更しない)")
    parser.add_argument("--path", required=True, help="診断対象ファイルのパス")
    parser.add_argument("--date", required=True, help="レポートファイル名に使うYYYY-MM-DD")
    args = parser.parse_args()

    target = pathlib.Path(args.path).expanduser()
    if not target.is_file():
        print(f"エラー: ファイルが見つかりません: {target}", file=sys.stderr)
        sys.exit(1)

    text = target.read_text(encoding="utf-8")
    result = analyze(text)
    report = build_report(target, args.date, result)

    print(report)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORTS_DIR / f"agent_md_diagnostic_{args.date}.md"
    report_path.write_text(report, encoding="utf-8")
    print(f"レポートを保存しました: {report_path}")


if __name__ == "__main__":
    main()
