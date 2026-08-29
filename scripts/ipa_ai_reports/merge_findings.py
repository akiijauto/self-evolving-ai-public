#!/usr/bin/env python3
"""調査エージェントが実在確認した PDF 一覧を catalog.json に統合する。

入力: agent_found_pdfs.json  (title/pdf_url/published/source_page/domain ...)
既に catalog.json にある URL は触らず、新規分だけ追記する。
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"

# 除外: 会議事務資料など本文のない資料
EXCLUDE = [r"memberlist", r"議事次第", r"委員名簿"]

CATEGORY_RULES = [
    ("aisi", r"aisi\.go\.jp"),
    ("ai-guideline", r"/disc/committee/begoj9000000egny"),
    ("dx-hakusho", r"/publish/wp-dx/"),
    ("dx-trend", r"dx-trend|discussion-paper"),
    ("ny-dayori", r"ny-dayori|/chousa/trend/\d{4}/"),
    ("technicalwatch", r"/security/reports/technicalwatch/"),
    ("software-engineering", r"software-survey|software-modernization|sds-research|"
                             r"rules-and-softwareengineering|le4sds|ai-conformity|/kaihatsu/"),
    ("guideline", r"final_project|generative"),
    ("ai-portal", r"/digital/ai/"),
    ("chousa", r"/digital/chousa/"),
]


def categorize(url):
    for cat, pat in CATEGORY_RULES:
        if re.search(pat, url):
            return cat
    return "other"


def slugify(url, category, used):
    name = url.rsplit("/", 1)[-1].removesuffix(".pdf")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-").lower()
    if re.fullmatch(r"[\d_]+", name) or len(name) < 5:
        name = f"{category}-{name}"
    base, n = name, 2
    while name in used:
        name, n = f"{base}-{n}", n + 1
    used.add(name)
    return name


def main():
    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    found = json.loads((HERE / "agent_found_pdfs.json").read_text(encoding="utf-8"))

    have = {e["url"] for e in catalog}
    used = {e["id"] for e in catalog}
    added = 0
    for item in found:
        url = item["pdf_url"]
        title = item.get("title", "")
        if url in have or any(re.search(p, title + url) for p in EXCLUDE):
            continue
        cat = categorize(url)
        entry = {
            "title": title.strip(),
            "url": url,
            "source_page": item.get("source_page", ""),
            "source_title": "",
            "category": cat,
            "published": item.get("published", ""),
            "domain": item.get("domain", ""),
        }
        entry["id"] = slugify(url, cat, used)
        entry["pdf"] = f"pdf/{entry['id']}.pdf"
        catalog.append(entry)
        have.add(url)
        added += 1

    # 既存分にも domain を補完
    for e in catalog:
        e.setdefault("domain", "www.ipa.go.jp")

    catalog.sort(key=lambda e: (e["category"], e["id"]))
    (DATA / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"added {added} entries -> total {len(catalog)}")
    for cat in sorted({e["category"] for e in catalog}):
        print(f"  {cat}: {sum(1 for e in catalog if e['category'] == cat)}")


if __name__ == "__main__":
    main()
