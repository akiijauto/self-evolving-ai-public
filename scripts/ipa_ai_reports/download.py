#!/usr/bin/env python3
"""catalog.json に載っている IPA の AI 関連 PDF を data/ipa-ai-reports/pdf/ へ保存する。

ローカル PC で実行すればそのまま PDF 一式が手元に揃う:
    python3 scripts/ipa_ai_reports/download.py
既にダウンロード済みのファイルはスキップする。
"""
import hashlib
import json
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"
PDF_DIR = DATA / "pdf"
DELAY = 1.0  # IPA のサーバに負荷をかけないための待ち時間(秒)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "Mozilla/5.0 (compatible; ipa-ai-report-collector/1.0)"


def main():
    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    PDF_DIR.mkdir(parents=True, exist_ok=True)

    failed = []
    for i, entry in enumerate(catalog, 1):
        dest = DATA / entry["pdf"]
        if dest.exists() and dest.stat().st_size > 0:
            entry.setdefault("bytes", dest.stat().st_size)
            print(f"[{i}/{len(catalog)}] skip (already have) {dest.name}")
            continue
        try:
            r = SESSION.get(entry["url"], timeout=180)
            r.raise_for_status()
            if not r.content.startswith(b"%PDF"):
                raise ValueError(f"PDF ではない応答 ({r.headers.get('content-type')})")
            dest.write_bytes(r.content)
            entry["bytes"] = len(r.content)
            entry["sha256"] = hashlib.sha256(r.content).hexdigest()
            print(f"[{i}/{len(catalog)}] saved {dest.name} ({len(r.content)/1e6:.1f} MB)")
        except Exception as e:  # noqa: BLE001
            print(f"[{i}/{len(catalog)}] FAILED {entry['url']}: {e}", file=sys.stderr)
            failed.append({"url": entry["url"], "error": str(e)})
        time.sleep(DELAY)

    (DATA / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total = sum(e.get("bytes", 0) for e in catalog)
    print(f"\ndone: {len(catalog) - len(failed)}/{len(catalog)} files, {total/1e6:.1f} MB")
    if failed:
        print("failed:", json.dumps(failed, ensure_ascii=False, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()
