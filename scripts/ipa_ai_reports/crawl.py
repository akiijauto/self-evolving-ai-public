#!/usr/bin/env python3
"""IPA サイトから AI 関連 PDF のリンクを収集する。"""
import json
import re
import sys
import time
from collections import deque
from urllib.parse import urljoin, urldefrag, urlparse

import requests
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (compatible; research-collector/1.0)"
SESSION = requests.Session()
SESSION.headers["User-Agent"] = UA

SEEDS = [
    "https://www.ipa.go.jp/digital/ai/index.html",
    "https://www.ipa.go.jp/digital/ai/trend.html",
    "https://www.ipa.go.jp/digital/ai/transformation.html",
    "https://www.ipa.go.jp/digital/ai/data.html",
    "https://www.ipa.go.jp/digital/ai/software-engineering.html",
    "https://www.ipa.go.jp/digital/ai/hr.html",
    "https://www.ipa.go.jp/digital/ai/document.html",
    "https://www.ipa.go.jp/digital/ai/security/index.html",
    "https://www.ipa.go.jp/digital/ai/security/ai_security_tips.html",
    "https://www.ipa.go.jp/digital/ai/security/ai-security-bulletin.html",
    "https://www.ipa.go.jp/digital/chousa/trend/ai-technologies/index.html",
    "https://www.ipa.go.jp/digital/chousa/trend/ai-technologies/ai.html",
    "https://www.ipa.go.jp/publish/wp-ai/index.html",
    "https://www.ipa.go.jp/publish/wp-ai/ai2017.html",
    "https://www.ipa.go.jp/publish/wp-ai/ai2019.html",
    "https://www.ipa.go.jp/publish/wp-ai/ai2020.html",
    "https://www.ipa.go.jp/jinzai/ics/core_human_resource/final_project/2022/AI-handbook.html",
    "https://www.ipa.go.jp/jinzai/ics/core_human_resource/final_project/2024/generative-ai-guideline.html",
    "https://www.ipa.go.jp/digital/kaihatsu/sds-column/ai-agent.html",
]

# AI 関連判定用キーワード（リンク文字列・URL・ページタイトルに対して）
AI_WORDS = [
    "ai", "生成ai", "人工知能", "機械学習", "ディープラーニング", "深層学習",
    "llm", "大規模言語モデル", "aiセーフティ", "aiセキュリティ", "aiエージェント",
    "genai", "machine-learning", "deeplearning",
]

MAX_DEPTH = 2
DELAY = 0.7


def is_ai_related(*texts):
    blob = " ".join(t for t in texts if t).lower()
    if re.search(r"(^|[^a-z])ai([^a-z]|$)", blob):
        return True
    return any(w in blob for w in AI_WORDS if w != "ai")


def norm(url):
    url, _ = urldefrag(url)
    return url


def fetch(url):
    r = SESSION.get(url, timeout=45)
    r.raise_for_status()
    # IPA は charset を返さないページがあり、requests の既定 (ISO-8859-1) だと
    # 日本語リンク文字列が文字化けするため実体から判定させる
    if "charset" not in r.headers.get("content-type", "").lower():
        r.encoding = r.apparent_encoding or "utf-8"
    return r


def main():
    seen_pages = set()
    pdfs = {}
    queue = deque((s, 0) for s in SEEDS)

    while queue:
        url, depth = queue.popleft()
        url = norm(url)
        if url in seen_pages:
            continue
        seen_pages.add(url)
        try:
            r = fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"[skip] {url}: {e}", file=sys.stderr)
            continue
        time.sleep(DELAY)
        ctype = r.headers.get("content-type", "")
        if "html" not in ctype:
            continue
        # 途中経過を随時保存（中断しても結果が残るように）
        if len(seen_pages) % 20 == 0:
            with open("pdf_links.json", "w", encoding="utf-8") as f:
                json.dump(sorted(pdfs.values(), key=lambda d: d["url"]),
                          f, ensure_ascii=False, indent=2)

        soup = BeautifulSoup(r.text, "lxml")
        page_title = (soup.title.get_text(strip=True) if soup.title else "")
        print(f"[page d{depth}] {url}  {page_title[:60]}", file=sys.stderr)

        for a in soup.find_all("a", href=True):
            href = norm(urljoin(url, a["href"]))
            p = urlparse(href)
            if p.netloc not in ("www.ipa.go.jp", "ipa.go.jp"):
                continue
            text = a.get_text(" ", strip=True)
            if p.path.lower().endswith(".pdf"):
                if href not in pdfs:
                    pdfs[href] = {
                        "url": href,
                        "link_text": text,
                        "source_page": url,
                        "source_title": page_title,
                        "ai_related": bool(
                            is_ai_related(text, href, page_title)
                        ),
                    }
                continue
            if depth < MAX_DEPTH and p.path.lower().endswith((".html", "/")):
                # リンク文字列か URL 自体が AI 関連のものだけ辿る
                # （親ページのタイトルは判定に使わない。使うと AI ページ上の
                #   無関係リンクまで全部辿ってしまう）
                if is_ai_related(text, href) or "/digital/ai/" in href:
                    queue.append((href, depth + 1))

    out = sorted(pdfs.values(), key=lambda d: d["url"])
    with open("pdf_links.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    n_ai = sum(1 for d in out if d["ai_related"])
    print(f"\npages crawled: {len(seen_pages)}  pdfs: {len(out)}  ai-related: {n_ai}")


if __name__ == "__main__":
    main()
