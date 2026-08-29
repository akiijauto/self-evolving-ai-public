#!/usr/bin/env python3
"""クロール結果から AI 関連 PDF を選別してカタログ(catalog.json)を作る。

入力: raw_pdf_links.json  (crawl.py の出力を整形したもの)
出力: ../../data/ipa-ai-reports/catalog.json
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"

# AI と無関係、または本文が名簿・様式のみで文字起こしの価値が薄いもの
EXCLUDE_URL_PATTERNS = [
    r"/de\d+-memberlist\.pdf$",        # デジタルエコシステム検討会 構成員名簿
    r"/de\d+-summary\.pdf$",           # 同 議事要旨(AI 特化ではない)
    r"software-modernization-comittee",  # ソフトウェアモダナイゼーション委員会報告書
    r"syllabus_ip_ver6_2\.pdf$",       # IT パスポート試験シラバス本体(AI 章のみ関連)
]

# カタログ上の分類。先に一致したものが採用される
CATEGORY_RULES = [
    ("ai-hakusho", r"/publish/wp-ai/"),
    ("ai-security", r"/digital/ai/security/"),
    ("technicalwatch", r"/security/reports/technicalwatch/"),
    ("ai-workshop", r"aiws\d|AI_WS|ai_ws"),
    ("ai-portal", r"/digital/ai/"),
    ("dx-trend", r"dx-trend|press20260716|dx2025_digital_talent"),
    ("guideline", r"final_project|generative-ai|AI-handbook|generativeai"),
    ("chousa", r"/digital/chousa/|/archive/digital/chousa/"),
]


def slugify(entry, used):
    """URL 末尾のファイル名からわかりやすい ID を作る。"""
    name = entry["url"].rsplit("/", 1)[-1].removesuffix(".pdf")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-").lower()
    if re.fullmatch(r"\d+", name) or len(name) < 4:
        # 000082705.pdf のような無名ファイルは分類名を前置して区別する
        name = f"{entry['category']}-{name}"
    base, n = name, 2
    while name in used:
        name, n = f"{base}-{n}", n + 1
    used.add(name)
    return name


def categorize(url):
    for cat, pat in CATEGORY_RULES:
        if re.search(pat, url):
            return cat
    return "other"


def main():
    raw = json.loads((HERE / "raw_pdf_links.json").read_text(encoding="utf-8"))

    entries, used = [], set()
    for item in raw:
        url = item["url"]
        if any(re.search(p, url) for p in EXCLUDE_URL_PATTERNS):
            continue
        entry = {
            "title": re.sub(r"\(PDF:[^)]*\)|\[[\d.]+ ?[MK]B\]", "", item["link_text"]).strip(),
            "url": url,
            "source_page": item["source_page"],
            "source_title": item.get("source_title", ""),
            "category": categorize(url),
        }
        entry["id"] = slugify(entry, used)
        entry["pdf"] = f"pdf/{entry['id']}.pdf"
        entries.append(entry)

    entries.sort(key=lambda e: (e["category"], e["id"]))
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "catalog.json").write_text(
        json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"catalog entries: {len(entries)} (excluded {len(raw) - len(entries)})")
    for cat in sorted({e["category"] for e in entries}):
        print(f"  {cat}: {sum(1 for e in entries if e['category'] == cat)}")


if __name__ == "__main__":
    main()
