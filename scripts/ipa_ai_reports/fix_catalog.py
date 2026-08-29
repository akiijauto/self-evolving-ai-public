#!/usr/bin/env python3
"""catalog.json の題名の誤りを直し、空の published を埋める。

crawl.py は掲載ページのリンク文字列をそのまま題名に使うため、
IPA 側の表記ゆれや誤記がそのまま入る。また掲載ページに公開日の
記載が無い資料は published が空のまま残る（215 件中 86 件）。

このスクリプトは冪等で、何度流しても同じ結果になる。

    python3 scripts/ipa_ai_reports/fix_catalog.py [--dry-run]

published_basis で「その日付をどこから取ったか」を必ず残す:
    crawl        crawl.py が掲載ページから取得したもの（既存 129 件）
    changelog    掲載ページの「更新履歴」から人手で確認したもの
    page         掲載ページの本文記述から人手で確認したもの
    document     PDF 本体の記載（改訂履歴など）から確認したもの
    inferred:*   id / 題名 / 掲載ページ URL の数字からの推定（年のみ）
"""
import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[1] / "data" / "ipa-ai-reports" / "catalog.json"

sys.path.insert(0, str(HERE))
from summary_queue import pub_year  # noqa: E402


# 掲載ページのリンク文字列が原典と食い違っている資料。
# 原典（PDF 本体）の表記を正とし、掲載ページ側の表記を title_on_page に残す。
TITLE_FIXES = {
    "le4sds-research-report": {
        "title": "別冊1 ルールと技術の統合的運用としての「法」— LE4SDSの構築に向けて",
        "title_on_page": "別冊1 ルールと技術の総合的運用としての「法」— LE4SDSの構築に向けて",
        "title_note": "掲載ページのリンク文字列は「総合的運用」だが、"
                      "PDF の表紙・奥付・本文はいずれも「統合的運用」。原典の表記を採用した。",
    },
}

# 掲載ページの更新履歴などから人手で確認した公開日。
# （推定に落とす前に、確認できるものは確認して入れる）
PUBLISHED_FIXES = {
    # ページ公開 2026年4月2日（ai_security_tips.html 更新履歴）
    "ai-security-1-1": ("2026-04", "changelog"),
    # 第1回 申込受付開始 2025年2月21日（ai_ws.html 更新履歴）
    "ai_ws_leaflet": ("2025-02", "changelog"),
    # 第2回 申込受付開始 2025年4月18日（ai_ws2.html 更新履歴）
    "bgu0b10000006sew": ("2025-04", "changelog"),
    # 第3回 申込受付開始 2025年7月18日（ai_ws3.html 更新履歴。
    # 現行 PDF は 2025年9月4日 の差し替え版）
    "ai_ws3_leaflet": ("2025-07", "changelog"),
    # 第4回 申込受付開始 2025年10月21日（ai_ws4.html 更新履歴）
    "ai_ws4_leaflet": ("2025-10", "changelog"),
    # 「2024年10月29日公開の『CEATEC2024講演資料』」（document.html 更新履歴）
    "ceatec2024-current-status-and-initiative-of-ai-in-japan": ("2024-10", "changelog"),
    "ceatec2024-data-infrastructure-and-ecosystem-for-an-ai-society": ("2024-10", "changelog"),
    "ceatec2024-how-to-walk-in-ai-society": ("2024-10", "changelog"),
    # 掲載ページに公開日の記載が無い。PDF 末尾の改訂履歴が「2022/8/4 P.3 図2 修正」
    # なので、初版はそれ以前。年のみ 2022 とする。
    "chousa-000098829": ("2022", "document"),
}


def infer(entry):
    """published が空の資料の公開年を推定する。(値, 根拠) を返す。"""
    if re.search(r"(?:^|[^0-9])((?:19|20)\d{2})[01]\d[0-3]\d", entry.get("id", "")) \
            or re.match(r"\d{2}[01]\d[0-3]\d[_-]", entry.get("id", "")):
        basis = "inferred:id"
    elif re.search(r"(19|20)\d{2}", entry.get("title", "")):
        basis = "inferred:title"
    else:
        basis = "inferred:source_page"

    year = pub_year(entry)
    return (str(year), basis) if year else ("", "")


def apply_fixes(catalog):
    stats = {"title": 0, "published": 0, "unresolved": []}
    for e in catalog:
        fix = TITLE_FIXES.get(e["id"])
        if fix and e["title"] != fix["title"]:
            e.update(fix)
            stats["title"] += 1

        if e.get("published"):
            e.setdefault("published_basis", "crawl")
            continue

        if e["id"] in PUBLISHED_FIXES:
            value, basis = PUBLISHED_FIXES[e["id"]]
        else:
            value, basis = infer(e)

        if not value:
            stats["unresolved"].append(e["id"])
            continue
        e["published"], e["published_basis"] = value, basis
        stats["published"] += 1
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    stats = apply_fixes(catalog)

    print(f"題名を修正: {stats['title']} 件")
    print(f"published を補完: {stats['published']} 件")
    if stats["unresolved"]:
        print(f"公開年を特定できず: {len(stats['unresolved'])} 件 "
              f"({', '.join(stats['unresolved'])})")

    if args.dry_run:
        print("(--dry-run のため書き込みなし)")
        return
    CATALOG.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{CATALOG} を更新した")


if __name__ == "__main__":
    main()
