#!/usr/bin/env python3
"""PDF から本文テキストを取り出す。

テキストレイヤがある PDF は pdftotext で抽出し、スキャン画像だけの PDF は
300dpi でレンダリングして tesseract(jpn+eng) で OCR する。
結果は data/ipa-ai-reports/text/<id>.txt に保存し、
どちらの方法を使ったかを catalog.json に書き戻す。

    python3 scripts/ipa_ai_reports/extract.py [--jobs N] [--only ID ...]

必要なもの: poppler-utils (pdftotext, pdftoppm), tesseract-ocr + tesseract-ocr-jpn
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"
TEXT_DIR = DATA / "text"

# 1 ページあたりこの文字数を下回るならテキストレイヤが無い(=スキャン)とみなす
MIN_CHARS_PER_PAGE = 60
OCR_DPI = 300
OCR_LANG = "jpn+eng"


def page_count(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    return 0


def pdftotext(pdf: Path) -> str:
    r = subprocess.run(
        ["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), "-"],
        capture_output=True, text=True, timeout=600,
    )
    return r.stdout


# tesseract は既定で OpenMP により 1 プロセスあたり CPU 数ぶんのスレッドを使う。
# プロセス並列と併用すると CPU を奪い合って 1 ページに数分かかりタイムアウトする
# （4CPU の環境でワーカー6本 × 各4スレッド = 24スレッドが競合していた）。
# プロセス並列側で並べるので、tesseract 自身は 1 スレッドに固定する。
OCR_ENV = {**os.environ, "OMP_THREAD_LIMIT": "1"}


def ocr(pdf: Path, pages: int) -> str:
    """ページごとに画像化して OCR する。

    1 ページの失敗で資料全体を落とさないよう、ページ単位で例外を握りつぶす。
    密度の高い図面ページは tesseract が極端に遅くなることがあるため、
    タイムアウトしたら解像度を落として一度だけ再試行する。
    """
    chunks = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for p in range(1, pages + 1):
            note, text = "", ""
            for dpi, limit in ((OCR_DPI, 240), (150, 180)):
                for stale in tmp.glob("page*.png"):
                    stale.unlink()
                try:
                    subprocess.run(
                        ["pdftoppm", "-r", str(dpi), "-png", "-f", str(p), "-l", str(p),
                         str(pdf), str(tmp / "page")],
                        check=True, capture_output=True, timeout=180,
                    )
                    img = next(tmp.glob("page*.png"), None)
                    if img is None:
                        note = "（画像化できず)"
                        break
                    r = subprocess.run(
                        ["tesseract", str(img), "-", "-l", OCR_LANG, "--psm", "3"],
                        capture_output=True, text=True, timeout=limit, env=OCR_ENV,
                    )
                    text = r.stdout.strip()
                    if dpi != OCR_DPI:
                        note = f"（{dpi}dpi で再試行）"
                    break
                except subprocess.TimeoutExpired:
                    note = "（OCR タイムアウト）"
                except subprocess.SubprocessError as e:  # noqa: PERF203
                    note = f"（OCR 失敗: {type(e).__name__}）"
                    break
            chunks.append(f"\n\n=== [page {p}] ==={note}\n{text}")
            for img in tmp.glob("page*.png"):
                img.unlink()
    return "".join(chunks)


JP_RE = re.compile(r"[ぁ-ゟ゠-ヿ一-鿿]")
WORD_RE = re.compile(r"[A-Za-z]{3,}")
TOKEN_RE = re.compile(r"\S+")


def text_profile(body: str):
    """日本語文字比率と英単語比率を返す。"""
    tokens = TOKEN_RE.findall(body)
    return (len(JP_RE.findall(body)) / max(len(body), 1),
            len(WORD_RE.findall(body)) / max(len(tokens), 1))


def has_broken_jp_layer(entry, jp_max=0.10, en_max=0.50) -> bool:
    """日本語資料なのに日本語が抽出できていない(テキストレイヤ破損)かを判定する。

    IPA の一部の PDF は ToUnicode が壊れており、pdftotext では日本語が
    ほとんど取り出せない。純粋な英語資料と区別するため、英単語比率も見る
    （英語資料は 80% 前後、破損した日本語資料は 30% 未満になる）。
    """
    if not JP_RE.search(entry.get("title", "")):
        return False
    if entry.get("ocr_retry_failed"):
        # 一度 OCR して元テキストに及ばなかった資料は毎回やり直しても同じ
        return False
    src = TEXT_DIR / f"{entry['id']}.txt"
    if not src.exists():
        return False
    body = src.read_text(encoding="utf-8", errors="replace").split("-" * 72, 1)[-1]
    jp_ratio, en_ratio = text_profile(body)
    return jp_ratio < jp_max and en_ratio < en_max


def process_ocr_broken(entry):
    """テキストレイヤが壊れた資料を OCR し直し、本文テキストを差し替える。

    OCR が失敗した場合に元のテキストを空の結果で潰さないよう、
    日本語が実際に増えたときだけ差し替える。
    """
    pdf = DATA / entry["pdf"]
    if not pdf.exists():
        return {**entry, "extract": "missing-pdf"}
    pages = entry.get("pages") or page_count(pdf)
    text = ocr(pdf, pages)

    out = TEXT_DIR / f"{entry['id']}.txt"
    old_jp = 0
    if out.exists():
        old_body = out.read_text(encoding="utf-8", errors="replace").split("-" * 72, 1)[-1]
        old_jp = len(JP_RE.findall(old_body))
    new_jp = len(JP_RE.findall(text))
    if new_jp <= old_jp:
        # OCR が元より日本語を拾えていない → 差し替えず失敗として記録する
        return {**entry, "ocr_retry_failed": True,
                "ocr_retry_jp_chars": new_jp}

    # 壊れたテキストレイヤにもグラフの数値だけは残っていることがあり
    # (図中文字が取れず数値だけ取れる)、OCR 側はその逆になりやすい。
    # 上書きで失わないよう、元のテキストを退避しておく。
    keep = TEXT_DIR / f"{entry['id']}.textlayer.txt"
    if out.exists() and not keep.exists():
        keep.write_text(out.read_text(encoding="utf-8", errors="replace"),
                        encoding="utf-8")

    out.write_text(
        f"# {entry['title']}\n# source: {entry['url']}\n"
        f"# page: {entry['source_page']}\n"
        f"# pages: {pages} / extraction: ocr "
        f"(テキストレイヤ破損のため tesseract {OCR_LANG} {OCR_DPI}dpi で再取得)\n"
        f"{'-' * 72}\n" + text,
        encoding="utf-8",
    )
    res = {**entry, "pages": pages, "extract": "ocr-broken-layer",
           "chars": len(text.strip()), "text": f"text/{entry['id']}.txt"}
    md = DATA / "markdown" / f"{entry['id']}.md"
    if md.exists() and 'generated: "auto"' not in md.read_text(
            encoding="utf-8", errors="replace")[:600]:
        # 壊れたテキストを元に作った要約は作り直しが必要
        res["needs_resummary"] = True
    return res


def process_ocr_supplement(entry):
    """図表主体でテキスト密度が低い資料を OCR し、<id>.ocr.txt として補完保存する。

    スライド資料は図の中の文字がテキストレイヤに入らないため、OCR を併記すると
    文字起こしの取りこぼしが減る。
    """
    pdf = DATA / entry["pdf"]
    if not pdf.exists():
        return {**entry, "ocr_supplement": "missing-pdf"}
    pages = entry.get("pages") or page_count(pdf)
    text = ocr(pdf, pages)
    out = TEXT_DIR / f"{entry['id']}.ocr.txt"
    out.write_text(
        f"# {entry['title']}\n# source: {entry['url']}\n"
        f"# pages: {pages} / extraction: ocr (tesseract {OCR_LANG}, {OCR_DPI}dpi)\n"
        f"{'-' * 72}\n" + text,
        encoding="utf-8",
    )
    return {**entry, "ocr_supplement": f"text/{entry['id']}.ocr.txt",
            "ocr_chars": len(text.strip())}


def process(entry):
    pdf = DATA / entry["pdf"]
    out = TEXT_DIR / f"{entry['id']}.txt"
    if not pdf.exists():
        return {**entry, "extract": "missing-pdf"}

    pages = page_count(pdf)
    text = pdftotext(pdf)
    method = "text-layer"
    if pages and len(text.strip()) < MIN_CHARS_PER_PAGE * pages:
        # テキストレイヤが薄い/無い → OCR にフォールバック
        ocr_text = ocr(pdf, pages)
        if len(ocr_text.strip()) > len(text.strip()):
            text, method = ocr_text, "ocr"

    header = (
        f"# {entry['title']}\n"
        f"# source: {entry['url']}\n"
        f"# page: {entry['source_page']}\n"
        f"# pages: {pages} / extraction: {method}\n"
        f"{'-' * 72}\n"
    )
    out.write_text(header + text, encoding="utf-8")
    return {**entry, "pages": pages, "extract": method, "chars": len(text.strip()),
            "text": f"text/{entry['id']}.txt"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--ocr-supplement", type=float, metavar="CHARS_PER_PAGE",
                    help="1ページあたり文字数がこの値未満の資料を OCR で補完する")
    ap.add_argument("--ocr-broken", action="store_true",
                    help="テキストレイヤが壊れた日本語資料を OCR で取り直す")
    args = ap.parse_args()

    for tool in ("pdftotext", "pdfinfo", "pdftoppm", "tesseract"):
        if not shutil.which(tool):
            sys.exit(f"{tool} が見つかりません。poppler-utils と tesseract-ocr(+jpn) を入れてください。")

    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    TEXT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [e for e in catalog if not args.only or e["id"] in args.only]
    worker, results = process, {}

    if args.ocr_broken:
        worker = process_ocr_broken
        targets = [e for e in targets if has_broken_jp_layer(e)]
        # ページ数の少ないものから片付ける(途中で止まっても成果が残る)
        targets.sort(key=lambda e: e.get("pages", 0))
        print(f"テキストレイヤ破損の再OCR対象: {len(targets)} 件 "
              f"({sum(e.get('pages', 0) for e in targets)} ページ)")
    elif args.ocr_supplement is not None:
        worker = process_ocr_supplement
        targets = [e for e in targets
                   if e.get("pages")
                   and e.get("chars", 0) / e["pages"] < args.ocr_supplement
                   and not (TEXT_DIR / f"{e['id']}.ocr.txt").exists()]
        targets.sort(key=lambda e: e.get("pages", 0))
        print(f"OCR 補完対象: {len(targets)} 件 "
              f"({sum(e['pages'] for e in targets)} ページ)")

    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        for res in pool.map(worker, targets):
            results[res["id"]] = res
            if worker is process_ocr_supplement:
                print(f"ocr補完 {res.get('ocr_chars', 0):>8,} chars  {res['id']}")
            else:
                print(f"{res.get('extract', ''):16s} {res.get('chars', 0):>8,} chars"
                      f"  {res['id']}")

    merged = [results.get(e["id"], e) for e in catalog]
    (DATA / "catalog.json").write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    n_ocr = sum(1 for r in results.values() if r.get("extract") == "ocr"
                or r.get("ocr_supplement"))
    print(f"\ndone: {len(results)} files (OCR: {n_ocr})")


if __name__ == "__main__":
    main()
