#!/usr/bin/env python3
"""需要ランキングのMarkdownを、Notionの親ページ配下に子ページとして作成する。

GitHub Actions から呼ばれる想定。認証情報は環境変数からのみ受け取り、
リポジトリにもコマンド履歴にも残さない。

必要な環境変数:
    NOTION_TOKEN           Notion内部インテグレーションのトークン
    NOTION_PARENT_PAGE_ID  子ページを作る親ページのID

使い方:
    python scripts/demand_publish_notion.py --date 2026-08-02

依存ライブラリなし(標準ライブラリのみ)。
"""
import argparse
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from demand import report  # noqa: E402

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

API_ROOT = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"

# Notion APIの制約。1リクエストで送れるブロック数と、1テキスト要素の文字数上限。
MAX_BLOCKS_PER_REQUEST = 100
MAX_TEXT_LENGTH = 2000

BOLD_PATTERN = re.compile(r"\*\*(.+?)\*\*")
LINK_PATTERN = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def _request(token, method, path, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        API_ROOT + path, data=data, method=method,
        headers={
            "Authorization": "Bearer %s" % token,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit("Notion API エラー (HTTP %s): %s" % (exc.code, detail))


def rich_text(line):
    """Markdownの装飾(太字・リンク)をNotionのrich_textに変換する。"""
    segments, cursor = [], 0
    pattern = re.compile(r"\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)")
    for match in pattern.finditer(line):
        if match.start() > cursor:
            segments.append((line[cursor:match.start()], False, None))
        if match.group(1) is not None:
            segments.append((match.group(1), True, None))
        else:
            segments.append((match.group(2), False, match.group(3)))
        cursor = match.end()
    if cursor < len(line):
        segments.append((line[cursor:], False, None))
    if not segments:
        segments = [("", False, None)]

    result = []
    for text, bold, href in segments:
        if not text:
            continue
        text = text[:MAX_TEXT_LENGTH]
        item = {"type": "text", "text": {"content": text}, "annotations": {"bold": bold}}
        if href:
            item["text"]["link"] = {"url": href}
        result.append(item)
    return result or [{"type": "text", "text": {"content": ""}}]


def _split_row(line):
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def markdown_to_blocks(markdown):
    """Markdownを、この用途に必要な範囲でNotionブロックへ変換する。

    対応: 見出し(##/###)、表、引用(>)、箇条書き(-)、段落。
    汎用のMarkdown変換器ではなく、demand/report.py が生成する形に絞っている。
    """
    blocks = []
    lines = markdown.split("\n")
    index = 0

    while index < len(lines):
        line = lines[index].rstrip()

        if not line.strip():
            index += 1
            continue

        # 表: ヘッダ行 + 区切り行 + データ行
        if line.startswith("|") and index + 1 < len(lines) and set(lines[index + 1].replace("|", "").strip()) <= {"-", ":", " "}:
            header = _split_row(line)
            rows, index = [], index + 2
            while index < len(lines) and lines[index].startswith("|"):
                rows.append(_split_row(lines[index]))
                index += 1
            width = len(header)
            children = [{
                "type": "table_row",
                "table_row": {"cells": [rich_text(cell) for cell in header]},
            }]
            for row in rows:
                # 列数が揃っていない行があるとNotionが400を返すため合わせる。
                cells = (row + [""] * width)[:width]
                children.append({
                    "type": "table_row",
                    "table_row": {"cells": [rich_text(cell) for cell in cells]},
                })
            blocks.append({
                "object": "block", "type": "table",
                "table": {"table_width": width, "has_column_header": True,
                          "has_row_header": False, "children": children},
            })
            continue

        if line.startswith("### "):
            blocks.append({"object": "block", "type": "heading_3",
                           "heading_3": {"rich_text": rich_text(line[4:])}})
        elif line.startswith("## "):
            blocks.append({"object": "block", "type": "heading_2",
                           "heading_2": {"rich_text": rich_text(line[3:])}})
        elif line.startswith("# "):
            blocks.append({"object": "block", "type": "heading_1",
                           "heading_1": {"rich_text": rich_text(line[2:])}})
        elif line.startswith("> "):
            blocks.append({"object": "block", "type": "quote",
                           "quote": {"rich_text": rich_text(line[2:])}})
        elif line.startswith("- "):
            blocks.append({"object": "block", "type": "bulleted_list_item",
                           "bulleted_list_item": {"rich_text": rich_text(line[2:])}})
        else:
            blocks.append({"object": "block", "type": "paragraph",
                           "paragraph": {"rich_text": rich_text(line)}})
        index += 1

    return blocks


def find_existing_page(token, parent, title):
    """親ページ直下から、同じタイトルの子ページを探して返す。無ければ None。

    同じ日に2回実行したときに子ページが増えていくのを防ぐために使う。
    収集側が store.replace_source() で冪等なのと同じ考え方をNotion側にも通す。
    """
    cursor = None
    while True:
        path = "/blocks/%s/children?page_size=100" % parent
        if cursor:
            path += "&start_cursor=%s" % cursor
        payload = _request(token, "GET", path)
        for block in payload.get("results", []):
            if block.get("type") != "child_page":
                continue
            if block["child_page"].get("title") == title:
                return block["id"]
        if not payload.get("has_more"):
            return None
        cursor = payload.get("next_cursor")


def clear_page(token, page_id):
    """ページ直下のブロックを全て削除する。中身を入れ替えるための前処理。"""
    while True:
        payload = _request(token, "GET", "/blocks/%s/children?page_size=100" % page_id)
        results = payload.get("results", [])
        if not results:
            return
        for block in results:
            _request(token, "DELETE", "/blocks/%s" % block["id"])
        if not payload.get("has_more"):
            return


def main():
    parser = argparse.ArgumentParser(description="需要ランキングをNotionの子ページとして作成する")
    parser.add_argument("--date", required=True, help="対象日(YYYY-MM-DD)")
    parser.add_argument("--parent", help="親ページID。省略時は NOTION_PARENT_PAGE_ID")
    parser.add_argument(
        "--if-exists", choices=("skip", "replace"), default="skip",
        help="同じ日の子ページが既にある場合の扱い。skip=何もしない(既定) / "
             "replace=中身を入れ替える。既定を skip にしているのは、"
             "人が書き足したメモを黙って消さないため。")
    args = parser.parse_args()

    token = os.environ.get("NOTION_TOKEN")
    if not token:
        print("エラー: 環境変数 NOTION_TOKEN が設定されていません。", file=sys.stderr)
        return 1
    parent = args.parent or os.environ.get("NOTION_PARENT_PAGE_ID")
    if not parent:
        print("エラー: 親ページIDが指定されていません(--parent または NOTION_PARENT_PAGE_ID)。",
              file=sys.stderr)
        return 1

    blocks = markdown_to_blocks(report.build(args.date))
    if not blocks:
        print("この日のデータがないため、Notionページは作成しませんでした。")
        return 0

    title = "%s 需要ランキング" % args.date
    existing = find_existing_page(token, parent, title)

    if existing and args.if_exists == "skip":
        print("同じ日の子ページが既にあるため作成しませんでした(%s)。"
              "作り直すには --if-exists replace を付けてください。" % existing)
        return 0

    if existing:
        clear_page(token, existing)
        page = {"id": existing}
        rest = blocks
        action = "更新"
    else:
        page = _request(token, "POST", "/pages", {
            "parent": {"page_id": parent},
            "icon": {"type": "emoji", "emoji": "📊"},
            "properties": {
                "title": [{"type": "text", "text": {"content": title}}]
            },
            # 1リクエストの上限があるため、最初の分だけ渡し残りは追記する。
            "children": blocks[:MAX_BLOCKS_PER_REQUEST],
        })
        rest = blocks[MAX_BLOCKS_PER_REQUEST:]
        action = "作成"

    for start in range(0, len(rest), MAX_BLOCKS_PER_REQUEST):
        _request(token, "PATCH", "/blocks/%s/children" % page["id"],
                 {"children": rest[start:start + MAX_BLOCKS_PER_REQUEST]})

    print("Notionページを%sしました: %s" % (action, page.get("url", page["id"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
