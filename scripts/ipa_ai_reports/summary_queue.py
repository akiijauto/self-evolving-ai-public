#!/usr/bin/env python3
"""Opus で要約整形する資料の優先キューを作る。

自動生成版(generated: auto)しか無い資料を、
  1. 公開年が新しい順
  2. 同じ年なら優先カテゴリ（AI白書 / DX白書 / DX動向）
  3. さらに同じなら文字数が多い順（＝要約の効果が大きい）
の順に並べ、data/ipa-ai-reports/SUMMARY_QUEUE.md を更新する。

    python3 scripts/ipa_ai_reports/summary_queue.py [--next N]

--next を付けると、次に処理すべき N 件の id を空白区切りで標準出力に出す
（定期実行のバッチ投入用）。
"""
import argparse
import functools
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"
MD_DIR = DATA / "markdown"

# 数字が小さいほど優先
CATEGORY_PRIORITY = {
    "ai-hakusho": 0,
    "dx-hakusho": 0,
    "dx-trend": 0,
    "ai-guideline": 1,
    "aisi": 1,
    "guideline": 1,
    "technicalwatch": 2,
    "ai-security": 2,
    "ai-portal": 2,
    "software-engineering": 3,
    "ny-dayori": 3,
    "chousa": 3,
    "ai-workshop": 4,
    "other": 5,
}

# 1 バッチあたりの文書量の上限。モデルの利用上限に当たらないよう、
# 4 時間に 1 バッチのペースでこの分量までを処理する。
DEFAULT_BUDGET = 400_000   # 文字
DEFAULT_MAX_DOCS = 6       # 文字数が小さい資料ばかりのときの件数上限


TEXT_DIR = DATA / "text"
# 文字起こしの方が要約より新しいと判定するまでの猶予（clone 直後の mtime 差を無視する）
STALE_MARGIN_SEC = 60


@functools.lru_cache(maxsize=1)
def commit_times():
    """追跡ファイルごとの「最後にコミットされた時刻」を得る。

    mtime は git の checkout/clone/rebase で一斉に書き換わるので、
    「文字起こしと要約のどちらが新しいか」の判定には使えない
    （コンテナを作り直すたびに要約済みの資料が再要約対象に戻ってしまう）。
    コミット時刻なら作業した順序がそのまま残る。
    """
    try:
        out = subprocess.run(
            ["git", "log", "--format=%ct", "--name-only", "--no-renames",
             "--", "data/ipa-ai-reports/text", "data/ipa-ai-reports/markdown"],
            cwd=DATA.parents[1], capture_output=True, text=True, timeout=120)
    except Exception:
        return {}
    times, now = {}, 0
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.isdigit():
            now = int(line)
        else:
            times.setdefault(line, now)   # --format 順なので初出が最新
    return times


def newer_than(path_a, path_b) -> bool:
    """path_a が path_b より後に作られたか。コミット時刻を優先する。"""
    times = commit_times()
    root = DATA.parents[1]
    ka, kb = (str(p.relative_to(root)) for p in (path_a, path_b))
    if ka in times and kb in times:
        return times[ka] > times[kb]
    # 未コミットのものが混ざるときだけ mtime に落ちる
    return path_a.stat().st_mtime > path_b.stat().st_mtime + STALE_MARGIN_SEC


def is_stale(entry) -> bool:
    """OCR で本文を取り直した後に、要約がまだ作り直されていないか。

    「文字起こしが OCR 取り直し版であること」と「文字起こしの方が後に
    コミットされていること」の両方が揃ったときだけ作り直す。
    """
    md = MD_DIR / f"{entry['id']}.md"
    txt = TEXT_DIR / f"{entry['id']}.txt"
    if not (md.exists() and txt.exists()):
        return False
    if "テキストレイヤ破損のため" not in txt.read_text(
            encoding="utf-8", errors="replace")[:400]:
        return False
    return newer_than(txt, md)


YEAR_RE = re.compile(r"(19|20)\d{2}")


def pub_year(entry) -> int:
    """公開年を推定する。新しいものから着手するための並び替えに使う。

    catalog の published が空の資料が多いので、タイトル・id・掲載元 URL の
    順に年らしき数字を探す（例: press20260716, 250331_..., /chousa/trend/2018/）。
    どこからも取れなければ 0（＝最後に回す）。
    """
    published = entry.get("published", "")
    if published[:4].isdigit():
        return int(published[:4])

    m = YEAR_RE.search(entry.get("title", ""))
    if m:
        return int(m.group(0))

    ident = entry.get("id", "")
    m = re.search(r"(?:^|[^0-9])((?:19|20)\d{2})[01]\d[0-3]\d", ident)
    if m:
        return int(m.group(1))
    m = re.match(r"(\d{2})[01]\d[0-3]\d[_-]", ident)  # 250331_... = 2025-03-31
    if m:
        return 2000 + int(m.group(1))

    m = YEAR_RE.search(entry.get("source_page", ""))
    return int(m.group(0)) if m else 0


def is_fresh(entry) -> bool:
    """要約が文字起こしより後に作られているか。"""
    md = MD_DIR / f"{entry['id']}.md"
    txt = TEXT_DIR / f"{entry['id']}.txt"
    if not (md.exists() and txt.exists()):
        return False
    return newer_than(md, txt)


def pending(catalog):
    """まだ Opus 要約が無い資料を優先順に返す。"""
    out = []
    for e in catalog:
        path = MD_DIR / f"{e['id']}.md"
        # catalog の needs_resummary は OCR 時に立てたきり消えないので、
        # 要約が文字起こしより新しければ作り直し済みとみなす
        redo = is_stale(e) or (e.get("needs_resummary") and not is_fresh(e))
        if path.exists() and not redo:
            head = path.read_text(encoding="utf-8", errors="replace")[:600]
            if 'generated: "auto"' not in head:
                continue  # 要約済み
        # needs_resummary は、壊れたテキストを元に要約を作ってしまった資料。
        # OCR で本文を取り直したので作り直す
        out.append(e)
    out.sort(key=lambda e: (-pub_year(e),
                            CATEGORY_PRIORITY.get(e["category"], 9),
                            -e.get("chars", 0)))
    return out


def take_batch(todo, budget=DEFAULT_BUDGET, max_docs=DEFAULT_MAX_DOCS):
    """1 回の実行で扱う資料を「文書量」で決める。

    先頭から文字数を積み上げ、budget を超えたら打ち切る。
    大部の白書(100万字級)は 1 件だけで budget を使い切るので自動的に
    「4 時間に 1 本」のペースになり、小さい資料はまとめて処理される。
    先頭の 1 件は budget を超えていても必ず含める(でないと前に進まない)。
    """
    batch, used = [], 0
    for e in todo:
        chars = e.get("chars", 0)
        if batch and (used + chars > budget or len(batch) >= max_docs):
            break
        batch.append(e)
        used += chars
    return batch, used


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--next", type=int, metavar="N",
                    help="次に処理する N 件の id を出力する（件数指定）")
    ap.add_argument("--next-batch", action="store_true",
                    help="次のバッチの id を出力する（文書量で自動決定）")
    ap.add_argument("--show-batch", action="store_true",
                    help="次のバッチの内訳を人間向けに表示する")
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET,
                    help=f"1バッチで扱う文字数の上限（既定 {DEFAULT_BUDGET:,}）")
    ap.add_argument("--max-docs", type=int, default=DEFAULT_MAX_DOCS,
                    help=f"1バッチの最大件数（既定 {DEFAULT_MAX_DOCS}）")
    args = ap.parse_args()

    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    todo = pending(catalog)

    if args.next:
        print(" ".join(e["id"] for e in todo[: args.next]))
        return

    if args.next_batch or args.show_batch:
        batch, used = take_batch(todo, args.budget, args.max_docs)
        if args.next_batch:
            print(" ".join(e["id"] for e in batch))
            return
        print(f"次のバッチ: {len(batch)} 件 / {used:,} 字 "
              f"(上限 {args.budget:,} 字, 残り {len(todo)} 件)")
        for e in batch:
            print(f"  {e.get('chars', 0):>9,}字  [{e['category']}] {e['title'][:50]}")
        return

    lines = [
        "# 要約整形の優先キュー",
        "",
        f"Opus による要約整形がまだの資料 **{len(todo)}件**を、"
        "公開年が新しい順 → 優先カテゴリ（AI白書・DX白書・DX動向）→ "
        "文字数の多い順 に並べたもの。",
        "自動生成の抽出版はすべての資料に既にある（[INDEX.md](INDEX.md) 参照）。",
        "公開年は catalog の published が空の資料についてはタイトル・id・"
        "掲載元 URL から推定している（不明は末尾）。",
        "",
        "| # | 公開年 | 資料 | 分類 | 文字数 | 頁 | id |",
        "| ---: | ---: | --- | --- | ---: | ---: | --- |",
    ]
    for i, e in enumerate(todo, 1):
        year = pub_year(e) or "不明"
        lines.append(
            f"| {i} | {year} | {e['title']} | {e['category']} | {e.get('chars', 0):,} "
            f"| {e.get('pages', '')} | `{e['id']}` |"
        )
    (DATA / "SUMMARY_QUEUE.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"SUMMARY_QUEUE.md: 未要約 {len(todo)} 件")
    for e in todo[:10]:
        print(f"  {pub_year(e) or '不明'}  {e.get('chars', 0):>9,}字  "
              f"[{e['category']}] {e['title'][:40]}")


if __name__ == "__main__":
    main()
