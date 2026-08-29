#!/usr/bin/env python3
"""蓄積した需要データから、判断材料になる切り口を抽出する。

demand_report.py が「その日に何が上位だったか」を並べるのに対し、
こちらは「そこから何が言えるか」を出す。日々のランキングを眺めるだけでは
気づけない構造(順位ではなく指標同士の関係)を見るための補助ツール。

使い方:
    python scripts/demand_insight.py --date 2026-08-03

依存ライブラリなし(標準ライブラリのみ)。
"""
import argparse
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from demand import store  # noqa: E402

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# 検索・閲覧トレンドに商業的な意味があるかを大まかに見るための語。
# 網羅が目的ではなく「ほぼ含まれない」ことを確かめるための粗い目安。
COMMERCIAL_HINT = re.compile(
    r"(iphone|playstation|android|apple|amazon|google|microsoft|tesla|nintendo|"
    r"openai|anthropic|claude|chatgpt|保険|税|給付|補助金|年金|控除|求人|転職|副業|通販)",
    re.I,
)


def _metric(record, key):
    return (record.get("metrics") or {}).get(key)


def prefecture_gap(records):
    """有効求人倍率と新規求人倍率の比から、地域の需給構造を見る。

    新規/有効 が高い = 求人が次々出るが早く埋まる(人が動いている)
    低い = 出た求人が埋まらず滞留している(構造的に人が足りない)
    """
    effective = {r["title"]: _metric(r, "ratio")
                 for r in records if r["category"] == "都道府県別 有効求人倍率"}
    fresh = {r["title"]: _metric(r, "ratio")
             for r in records if r["category"] == "都道府県別 新規求人倍率"}
    common = [k for k in effective if k in fresh and effective[k]]
    if not common:
        return None
    ranked = sorted(((k, fresh[k], effective[k], fresh[k] / effective[k]) for k in common),
                    key=lambda row: row[3], reverse=True)
    undersupplied = sorted((k for k in effective if effective[k] < 1.0),
                           key=lambda k: effective[k])
    return {"ranked": ranked, "undersupplied": undersupplied, "effective": effective}


def skill_divergence(records):
    """複数の求人ボードで、スキル需要の分布がどれだけ違うかを見る。

    重なりが小さいほど、片方だけを見て「これが世の中の需要だ」と
    判断するのが危ういことを意味する。
    """
    boards = collections.defaultdict(set)
    for record in records:
        if record["domain"] == "job" and _metric(record, "share_pct") is not None:
            boards[record["source"]].add(record["title"])
    if len(boards) < 2:
        return None
    names = sorted(boards)
    shared = set.intersection(*(boards[n] for n in names))
    return {"boards": {n: boards[n] for n in names}, "shared": shared}


def trend_commercial_ratio(records):
    """検索・閲覧トレンドのうち、商業的な語を含む割合を返す。"""
    trend = [r for r in records if r["source"] in ("google_trends_rss", "wikimedia_pageviews")]
    if not trend:
        return None
    hits = [r for r in trend if COMMERCIAL_HINT.search(r["title"])]
    return {"total": len(trend), "hits": hits}


def main():
    parser = argparse.ArgumentParser(description="需要データから判断材料になる切り口を抽出する")
    parser.add_argument("--date", required=True, help="対象日(YYYY-MM-DD)")
    args = parser.parse_args()

    records = store.load(args.date)
    if not records:
        print("%s の需要データがありません。" % args.date)
        return 1

    print("== %s の需要データ %d件から ==" % (args.date, len(records)))
    print()

    gap = prefecture_gap(records)
    if gap:
        print("[地域の需給構造] 新規求人倍率 ÷ 有効求人倍率")
        print("  比が高い(求人が早く埋まる):")
        for name, fresh, effective, ratio in gap["ranked"][:5]:
            print("    %-6s 新規%.2f 有効%.2f  比%.2f" % (name, fresh, effective, ratio))
        print("  比が低い(求人が滞留している=構造的な人手不足):")
        for name, fresh, effective, ratio in gap["ranked"][-5:]:
            print("    %-6s 新規%.2f 有効%.2f  比%.2f" % (name, fresh, effective, ratio))
        if gap["undersupplied"]:
            print("  有効求人倍率が1.0未満(求職者のほうが多い): %s"
                  % ", ".join(gap["undersupplied"]))
        print()

    divergence = skill_divergence(records)
    if divergence:
        names = sorted(divergence["boards"])
        print("[求人ボード間のスキル需要の食い違い]")
        for name in names:
            print("    %-12s %d項目" % (name, len(divergence["boards"][name])))
        print("    共通して現れた項目: %d件 %s"
              % (len(divergence["shared"]), sorted(divergence["shared"]) or ""))
        print("    → 重なりが小さいほど、1つの求人ボードだけを根拠に")
        print("       「世の中の需要」を語るのは危うい。")
        print()

    commercial = trend_commercial_ratio(records)
    if commercial:
        total, hits = commercial["total"], commercial["hits"]
        print("[検索・閲覧トレンドの商業シグナル]")
        print("    %d件中 %d件 (%.1f%%) しか商業的な語を含まない"
              % (total, len(hits), 100 * len(hits) / total))
        print("    → 急上昇ワードと閲覧数上位は芸能・スポーツ・ニュースが大半で、")
        print("       受託や人材の需要把握には直接は効かない。")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
