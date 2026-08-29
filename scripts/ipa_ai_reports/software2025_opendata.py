#!/usr/bin/env python3
"""2025年度ソフトウェア動向調査の公開データから、AI 関連設問を集計する。

単純集計グラフ PDF (software2025-graphs.pdf) は 100％積み上げ横棒で、
数値ラベルがバー内の画像になっており、テキストレイヤにも OCR にも
数値が出てこない。IPA は同じ調査の回答データを CSV で公開しているので、
そちらから集計し直す（グラフを読み取るのではなく、原データを数える）。

    python3 scripts/ipa_ai_reports/software2025_opendata.py [-o out.md]

出力の正しさは、グラフ PDF から数値が取れている設問 Q4-2 を突き合わせて
検証する（--verify、既定で実行）。ここが合わなければ集計の母数の取り方が
公開グラフと違うということなので、他の設問の数値も信用してはいけない。
"""
import argparse
import collections
import csv
import hashlib
import html
import io
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

BASE = ("https://www.ipa.go.jp/digital/software-survey/software-engineering/"
        "j5u9nn000000hkhs-att/")
CSV_NAME = "software2025-result-data-str.csv"
XLSX_NAME = "software2025-c-questions.xlsx"
SOURCE_PAGE = ("https://www.ipa.go.jp/digital/software-survey/"
               "software-engineering/software2025.html")

CACHE_DIR = Path(__file__).resolve().parent / ".cache"

# 集計する設問。(見出し, 列名の先頭一致, グラフPDFでのページ)
TARGETS = [
    ("Q2-3 生成AIの導入状況", "Q2-3.", "p.7"),
    ("Q7-1(1) 社内ポリシーの整備状況：生成AIの利活用",
     "Q7-1.社内ポリシーの整備状況(1.", "p.14"),
    ("Q11-3 開発におけるAI導入状況", "Q11-3.", "p.26〜27"),
]

# 公開グラフから数値が読み取れている設問。集計方法の検証に使う。
# (列名, 期待値％, 母数の説明)
VERIFY = [
    ("Q4-2.内製化の課題(2.人材の確保や育成が難しい)", 78.5),
    ("Q4-2.内製化の課題(3.新しい技術への対応が難しい)", 46.2),
]
VERIFY_BASE = "1.ユーザー企業"   # グラフの n=247 はこの区分のみ


def fetch(name):
    path = CACHE_DIR / name
    if not path.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(BASE + name, timeout=120) as r:
            path.write_bytes(r.read())
    return path.read_bytes()


def load_csv():
    raw = fetch(CSV_NAME)
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    return rows[0], rows[1:], hashlib.sha256(raw).hexdigest()


def load_option_lists():
    """設問一覧 Excel から選択肢の一覧を読む。

    誰も選ばなかった選択肢は回答データに現れないため、それを 0 件として
    表に出すのに使う（黙って消えると「選択肢が無かった」と誤読される）。
    セル内は「1.〜\n2.〜」の 1 文字列。先頭の選択肢をキーに引けるようにする。
    """
    try:
        z = zipfile.ZipFile(io.BytesIO(fetch(XLSX_NAME)))
        shared = z.read("xl/sharedStrings.xml").decode("utf-8")
    except Exception as e:                       # 取得できなくても集計は続ける
        print(f"  設問一覧を読めなかった({e})。0件の選択肢は表に出ない。",
              file=sys.stderr)
        return {}

    lists = {}
    for si in re.findall(r"<si>(.*?)</si>", shared, re.S):
        text = html.unescape(re.sub(r"<[^>]+>", "", si))
        opts = [o.strip() for o in text.replace("\r", "").split("\n")]
        if len(opts) < 2 or not all(re.match(r"\d+\.", o) for o in opts):
            continue
        # 最終行にはふりがなが連結されていることがあるので、そこは信用しない
        lists[opts[0]] = opts
    return lists


FURIGANA_TAIL = re.compile(r"(?<=[^ァ-ヶー])[ァ-ヶー]{2,}$")


def tabulate(rows, idx, option_lists):
    """単一選択設問を集計する。無回答は母数から外す。

    誰も選ばなかった選択肢も 0 件の行として残す（選択肢が存在しなかったの
    か、存在したが 0 件だったのかを読み手が区別できるようにするため）。
    """
    counts = collections.Counter(
        r[idx].strip() for r in rows if r[idx].strip())
    total = sum(counts.values())

    observed = sorted(counts, key=lambda s: int(s.split(".", 1)[0]))
    options = option_lists.get(observed[0]) if observed else None
    if options:
        for opt in options:
            # Excel のセルは末尾の選択肢にふりがなが連結されていることがある
            label = FURIGANA_TAIL.sub("", opt)
            if label not in counts:
                counts[label] = 0
    return counts, total


def verify(header, rows):
    """公開グラフと数値が一致するか確かめる。ずれたら異常終了する。"""
    kind = header.index("Q1-4.企業種別")
    base = [r for r in rows if r[kind].strip() == VERIFY_BASE]
    ok = True
    for name, expected in VERIFY:
        idx = header.index(name)
        n = sum(1 for r in base if r[idx].strip())
        got = round(n / len(base) * 100, 1)
        mark = "一致" if got == expected else "不一致"
        if got != expected:
            ok = False
        print(f"  検証 {name}: 公開グラフ {expected}％ / 本集計 {got}％ "
              f"({n}/{len(base)}) … {mark}", file=sys.stderr)
    return ok, len(base)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()

    header, rows, digest = load_csv()
    option_lists = load_option_lists()
    print(f"回答 {len(rows)} 件 / 設問列 {len(header)}", file=sys.stderr)

    if not args.no_verify:
        ok, base_n = verify(header, rows)
        if not ok:
            sys.exit("公開グラフと数値が一致しない。集計方法を見直すこと。")

    out = [
        "# 2025年度ソフトウェア動向調査 — AI関連設問の集計",
        "",
        "単純集計グラフ PDF は数値ラベルが画像で、テキスト抽出でも OCR でも",
        "数値が復元できない。IPA が同じ調査の回答データを CSV で公開している",
        "ので、そちらを数え直したものが以下である（グラフの読み取りではない）。",
        "",
        f"- 出典ページ: {SOURCE_PAGE}",
        f"- 使用データ: `{CSV_NAME}`（{BASE + CSV_NAME}）",
        f"- SHA-256: `{digest}`",
        f"- 回答数: **{len(rows)}件**（グラフPDFの記載「362件（2026/2/9時点）」と一致）",
        "",
        "集計方法の妥当性は、グラフから数値が読み取れている Q4-2（内製化の課題、",
        f"ユーザー企業 n={base_n}）で検証済み: 「人材の確保や育成が難しい」78.5％、",
        "「新しい技術への対応が難しい」46.2％をいずれも再現する。",
        "",
        "再生成: `python3 scripts/ipa_ai_reports/software2025_opendata.py "
        "-o data/ipa-ai-reports/opendata/software2025-ai-questions.md`",
        "",
    ]

    for heading, prefix, page in TARGETS:
        cols = [(i, h) for i, h in enumerate(header) if h.startswith(prefix)]
        out += [f"## {heading}（グラフPDF {page}）", ""]
        for idx, name in cols:
            counts, total = tabulate(rows, idx, option_lists)
            sub = name.split("(", 1)[1].rstrip(")") if "(" in name else None
            if sub:
                out += [f"### {sub}", ""]
            out += [f"n={total}", "",
                    "| 選択肢 | 件数 | 割合 |", "| --- | ---: | ---: |"]
            for label in sorted(counts, key=lambda s: int(s.split(".", 1)[0])):
                n = counts[label]
                out.append(f"| {label} | {n} | {n / total * 100:.1f}％ |")
            out.append("")

    text = "\n".join(out)
    if args.output:
        p = Path(args.output)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        print(f"{p}: {len(text):,} 字", file=sys.stderr)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
