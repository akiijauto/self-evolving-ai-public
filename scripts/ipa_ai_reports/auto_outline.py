#!/usr/bin/env python3
"""文字起こしから「整理版 Markdown」の自動生成版を作る。

Opus による要約整形が未着手の資料について、機械的に取り出せる範囲
（見出し構造・目次・冒頭の要旨・図表キャプション・統計）で
data/ipa-ai-reports/markdown/<id>.md を用意する。

既にファイルがある資料は上書きしない（Opus 整形版を保護する）。
--force を付けると自動生成版(generated: auto)のみ作り直す。

    python3 scripts/ipa_ai_reports/auto_outline.py [--force]
"""
import argparse
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"
TEXT_DIR = DATA / "text"
OUT_DIR = DATA / "markdown"

# 見出しらしい行
HEADING_PATTERNS = [
    re.compile(r"^\s*(第\s*[0-9０-９一二三四五六七八九十]+\s*[章節部編](?:\s|　).*)$"),
    re.compile(r"^\s*([0-9]+(?:[.\-][0-9]+){0,3}[.\s　]+\S.{2,60})$"),
    re.compile(r"^\s*[■●◆▼]\s*(\S.{2,60})$"),
    re.compile(r"^\s*【(\S.{1,58})】\s*$"),
]
# 目次行（リーダー付き）
TOC_RE = re.compile(r"^(.{3,70}?)[.．・…]{3,}\s*([0-9]{1,4})\s*$")
# 図表キャプション
FIGURE_RE = re.compile(r"^\s*((?:図表?|表|Figure|Fig\.|Table)\s*[0-9０-９][^\s]{0,12}[\s　]+\S.{2,70})$")

NOISE_RE = re.compile(r"^[\s\d\-—・|]*$")
# 「2022 年度、…である。」のような本文の書き出しを見出しと誤認しないための除外条件
BODY_LIKE_RE = re.compile(r"[。、％%]|^[0-9０-９]+\s*年")


def looks_like_heading(title: str) -> bool:
    title = title.strip()
    return bool(title) and len(title) <= 45 and not BODY_LIKE_RE.search(title)


def load_pages(text_path: Path):
    raw = text_path.read_text(encoding="utf-8", errors="replace")
    body = raw.split("-" * 72, 1)[-1]
    if "\f" in body:
        return list(enumerate(body.split("\f"), 1))
    return [(1, body)]


def collect(pages):
    """見出し・目次・図表キャプションをページ番号付きで集める。"""
    headings, toc, figures = [], [], []
    for num, page in pages:
        for line in page.splitlines():
            line = line.replace("　", " ").strip()
            if not line or NOISE_RE.match(line) or len(line) > 90:
                continue
            m = TOC_RE.match(line)
            if m:
                toc.append((m.group(1).strip(), m.group(2)))
                continue
            m = FIGURE_RE.match(line)
            if m:
                figures.append((m.group(1).strip(), num))
                continue
            for pat in HEADING_PATTERNS:
                m = pat.match(line)
                if m and looks_like_heading(m.group(1)):
                    headings.append((m.group(1).strip(), num))
                    break
    return headings, toc, figures


def lead_text(pages, limit=700):
    """本文冒頭のまとまった文を要旨がわりに拾う。"""
    out = []
    for _, page in pages[:6]:
        for para in re.split(r"\n\s*\n", page):
            para = " ".join(para.split())
            if len(para) < 40 or NOISE_RE.match(para):
                continue
            out.append(para)
            if sum(len(p) for p in out) > limit:
                return out
    return out


def dedupe(items, key=lambda x: x[0], cap=120):
    seen, out = set(), []
    for it in items:
        k = re.sub(r"\s+", "", key(it))
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
        if len(out) >= cap:
            break
    return out


def build(entry) -> str:
    src = TEXT_DIR / f"{entry['id']}.txt"
    pages = load_pages(src)
    headings, toc, figures = collect(pages)
    headings, toc, figures = dedupe(headings), dedupe(toc), dedupe(figures, cap=80)

    fm = {
        "id": entry["id"],
        "title": entry.get("title", "").replace('"', "'"),
        "category": entry.get("category", ""),
        "published": entry.get("published", ""),
        "pages": entry.get("pages", ""),
        "source_pdf": entry.get("url", ""),
        "source_page": entry.get("source_page", ""),
        "extraction": entry.get("extract", ""),
        "generated": "auto",
    }
    md = ["---"] + [f'{k}: "{v}"' for k, v in fm.items()] + ["---", ""]
    md += [f"# {entry['title']}", ""]
    md += [
        "> **この資料は自動生成の整理版です。** 文字起こしから見出し・目次・図表"
        "キャプションを機械的に抽出したもので、要約や解釈は含みません。",
        f"> 本文全体は [`transcript/{entry['id']}.md`](../transcript/{entry['id']}.md)、"
        f"生の文字起こしは [`text/{entry['id']}.txt`](../text/{entry['id']}.txt) にあります。",
        "",
    ]

    md += ["## 冒頭", ""]
    lead = lead_text(pages)
    md += ([f"{p}\n" for p in lead] if lead else ["（本文冒頭を抽出できませんでした）\n"])

    if toc:
        md += ["## 目次（原文の目次から抽出）", ""]
        md += [f"- {title} … p.{page}" for title, page in toc] + [""]

    if headings:
        md += ["## 見出し構成（本文から抽出）", ""]
        md += [f"- {title}（p.{page}）" for title, page in headings] + [""]

    if figures:
        md += ["## 図表", ""]
        md += [f"- {cap}（p.{page}）" for cap, page in figures] + [""]

    md += [
        "## 資料情報",
        "",
        f"- ページ数: {entry.get('pages', '')}",
        f"- 文字起こし文字数: {entry.get('chars', 0):,}",
        f"- 抽出方法: {entry.get('extract', '')}"
        + ("（＋OCR補完）" if entry.get("ocr_supplement") else ""),
        f"- 分類: {entry.get('category', '')}",
        "",
        "## 出典",
        "",
        f"- PDF: {entry.get('url', '')}",
        f"- 掲載ページ: {entry.get('source_page', '')}",
        f"- 文字起こし元: `text/{entry['id']}.txt`",
        "",
    ]
    return "\n".join(md)


def is_auto(path: Path) -> bool:
    head = path.read_text(encoding="utf-8", errors="replace")[:600]
    return 'generated: "auto"' in head


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="自動生成版を作り直す（Opus整形版は保護）")
    args = ap.parse_args()

    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    made = skipped = 0
    for entry in catalog:
        out = OUT_DIR / f"{entry['id']}.md"
        if out.exists() and not (args.force and is_auto(out)):
            skipped += 1
            continue
        if not (TEXT_DIR / f"{entry['id']}.txt").exists():
            continue
        out.write_text(build(entry), encoding="utf-8")
        made += 1

    print(f"自動生成: {made} 件 / 既存を保持: {skipped} 件")


if __name__ == "__main__":
    main()
