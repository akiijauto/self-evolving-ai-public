#!/usr/bin/env python3
"""Markdown を Notion-flavored Markdown に変換する。

Notion の表は標準 Markdown のパイプ記法ではなく XML 形式なので、そこだけ変換する。
見出し・太字・リンク・箇条書き・コードブロックはそのまま通る。

    python3 scripts/ipa_ai_reports/to_notion.py <input.md> [-o out.md]
"""
import argparse
import re
import sys
from pathlib import Path

SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def split_row(line: str):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def is_table_line(line: str) -> bool:
    return line.strip().startswith("|") and line.strip().endswith("|")


def render_table(rows, header: bool) -> str:
    out = [f'<table fit-page-width="true" header-row="{"true" if header else "false"}">']
    for cells in rows:
        out.append("\t<tr>")
        for c in cells:
            # セル内はリッチテキストのみ。改行は <br> に寄せる
            c = c.replace("<br>", "<br>").strip()
            out.append(f"\t\t<td>{c}</td>")
        out.append("\t</tr>")
    out.append("</table>")
    return "\n".join(out)


def convert(text: str) -> str:
    # YAML フロントマターは Notion のページプロパティで表すので落とす
    text = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S)

    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        if is_table_line(lines[i]):
            block = []
            while i < len(lines) and (is_table_line(lines[i]) or SEPARATOR_RE.match(lines[i])):
                block.append(lines[i])
                i += 1
            rows = [split_row(l) for l in block if not SEPARATOR_RE.match(l)]
            header = any(SEPARATOR_RE.match(l) for l in block)
            if rows:
                width = max(len(r) for r in rows)
                rows = [r + [""] * (width - len(r)) for r in rows]
                out.append(render_table(rows, header))
            continue
        out.append(lines[i])
        i += 1

    text = "\n".join(out)
    # Notion では H1 がページタイトル相当なので、本文の見出しを 1 段下げる
    text = re.sub(r"^# (?!#)", "## ", text, flags=re.M)
    return text.strip() + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    args = ap.parse_args()

    src = Path(args.input).read_text(encoding="utf-8")
    result = convert(src)
    if args.output:
        Path(args.output).write_text(result, encoding="utf-8")
        print(f"{args.output}: {len(result):,} 字 / 表 {result.count('<table')} 個",
              file=sys.stderr)
    else:
        sys.stdout.write(result)


if __name__ == "__main__":
    main()
