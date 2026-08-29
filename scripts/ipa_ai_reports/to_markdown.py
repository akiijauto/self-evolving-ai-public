#!/usr/bin/env python3
"""文字起こしテキストを Markdown の全文書き起こしに変換する。

data/ipa-ai-reports/text/<id>.txt を機械的に整形して
data/ipa-ai-reports/transcript/<id>.md を作る。全 PDF について必ず 1 ファイル作る。

やっていること:
- catalog.json のメタ情報を YAML フロントマターに出す
- ページ区切りを `## p.N` 見出しにする
- pdftotext -layout 由来の過剰な空白・空行・ハイフン改行を整える
- 表組みらしい行(空白が3つ以上続く行)はコードブロックに入れて桁を保つ

要約や解釈は一切しない(原文の情報を落とさないことを優先する)。
読みやすく再構成した資料は markdown/<id>.md 側に置く。
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"
OUT_DIR = DATA / "transcript"

PAGE_BREAK = "\f"
OCR_PAGE_RE = re.compile(r"^=== \[page (\d+)\] ===$")
# 3 個以上の連続空白で列が分かれている行は表・図の可能性が高い
TABULAR_RE = re.compile(r"\S {3,}\S")


def clean_line(line: str) -> str:
    line = line.replace("　", " ").rstrip()
    line = re.sub(r"[ \t]{2,}", "  ", line) if not TABULAR_RE.search(line) else line
    return line


def render_page(lines):
    """1 ページ分の行を Markdown に整形する。"""
    out, buf = [], []

    def flush(block_is_table):
        if not buf:
            return
        if block_is_table:
            out.append("```text")
            out.extend(buf)
            out.append("```")
        else:
            out.append("\n".join(buf))
        buf.clear()

    table_mode = False
    for raw in lines:
        line = clean_line(raw)
        if not line.strip():
            flush(table_mode)
            table_mode = False
            out.append("")
            continue
        is_tab = bool(TABULAR_RE.search(line))
        if is_tab != table_mode and buf:
            flush(table_mode)
        table_mode = is_tab
        buf.append(line if is_tab else line.strip())
    flush(table_mode)

    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def split_pages(body: str):
    """pdftotext の改ページ(\\f)か OCR のページ見出しでページに分ける。"""
    if PAGE_BREAK in body:
        return list(enumerate(body.split(PAGE_BREAK), 1))
    pages, current, num = [], [], None
    for line in body.splitlines():
        m = OCR_PAGE_RE.match(line.strip())
        if m:
            if num is not None:
                pages.append((num, "\n".join(current)))
            num, current = int(m.group(1)), []
        else:
            current.append(line)
    if num is not None:
        pages.append((num, "\n".join(current)))
    return pages or [(1, body)]


def front_matter(entry, source_txt):
    fields = {
        "id": entry["id"],
        "title": entry.get("title", "").replace('"', "'"),
        "category": entry.get("category", ""),
        "published": entry.get("published", ""),
        "pages": entry.get("pages", ""),
        "domain": entry.get("domain", ""),
        "source_pdf": entry.get("url", ""),
        "source_page": entry.get("source_page", ""),
        "extraction": entry.get("extract", ""),
        "transcript_of": source_txt,
    }
    body = "\n".join(f'{k}: "{v}"' for k, v in fields.items())
    return f"---\n{body}\n---\n"


def convert(entry):
    src = DATA / "text" / f"{entry['id']}.txt"
    if not src.exists():
        return None
    raw = src.read_text(encoding="utf-8", errors="replace")
    # extract.py が付けた 5 行のヘッダを落とす
    body = raw.split("-" * 72, 1)[-1]

    chunks = [front_matter(entry, f"text/{entry['id']}.txt"),
              f"\n# {entry['title']}\n"]
    chunks.append(
        f"\n> PDF: {entry.get('url', '')}  \n"
        f"> 掲載ページ: {entry.get('source_page', '')}  \n"
        f"> 抽出方法: {entry.get('extract', '')}"
        + (f" ＋ OCR補完 (`text/{entry['id']}.ocr.txt`)"
           if entry.get("ocr_supplement") else "")
        + "\n\nPDF 本文をページ順にそのまま書き起こしたものです"
          "（要約・解釈はしていません）。\n"
    )
    for num, page in split_pages(body):
        text = render_page(page.splitlines())
        if not text:
            continue
        chunks.append(f"\n## p.{num}\n\n{text}\n")

    out = OUT_DIR / f"{entry['id']}.md"
    out.write_text("".join(chunks), encoding="utf-8")
    return out


def main():
    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    made = 0
    for entry in catalog:
        if convert(entry):
            made += 1
    print(f"transcript markdown: {made}/{len(catalog)} files")


if __name__ == "__main__":
    main()
