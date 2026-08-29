#!/usr/bin/env python3
"""収集した需要データを、Notionへそのまま貼れるMarkdownに整形する。

設計上の判断: 収集元ごとにランキングの算出基準(販売数/閲覧数/掲載数)が
異なり、その基準は多くの場合非公開である。したがって収集元をまたいだ
単純な合算・統合ランキングは作らない。収集元ごとに並べたうえで、
「複数の収集元に同時に現れた語」だけを横断シグナルとして別途抽出する。

依存ライブラリなし(標準ライブラリのみ)。
"""
import collections

from . import registry, store

# 需要の種類ごとの見出し。表示順もこの順序に従う。
DOMAIN_HEADINGS = [
    ("trend", "関心・検索需要"),
    ("job", "企業の求人・スキル需要"),
    ("service", "受託・スキルマーケット需要"),
    ("ec", "EC・商品需要"),
]

TOP_N_PER_SOURCE = 20


# metrics のキーを日本語ラベルに読み替える表。収集モジュールが新しいキーを
# 足したらここにも足す(足し忘れると Notion に生のキー名がそのまま出る)。
METRIC_LABELS = {
    "approx_traffic_min": "推定検索数",
    "views": "閲覧数",
    "downloads_last_week": "週間DL数",
    "job_count": "求人数",
    "share_pct": "求人比率(%)",
    "ratio": "倍率",
    "ai_share_pct": "AI関連求人比率(%)",
    "postings_index_sa": "求人数指数",
    "peak_in_game": "同時接続ピーク",
    "sales_count": "販売数",
    "displayed_rank": "サイト表示順位",
}


def _metric_summary(record):
    """metrics を人が読める1行にまとめる。"""
    metrics = record.get("metrics") or {}
    parts = []
    for key, value in metrics.items():
        if value is None:
            continue
        label = METRIC_LABELS.get(key, key)
        parts.append("%s %s" % (label, "{:,}".format(value) if isinstance(value, int) else value))
    return " / ".join(parts) or "—"


def _rank_change(record, previous_ranks):
    """前回収集日からの順位変動を矢印付きで返す。"""
    key = (record["source"], record["country"], record["category"], record["title"])
    before = previous_ranks.get(key)
    if before is None:
        return "🆕 新規"
    delta = before - record["rank"]
    if delta > 0:
        return "▲ +%d" % delta
    if delta < 0:
        return "▼ %d" % delta
    return "— 0"


def _cross_source_signals(records):
    """複数の収集元に同時に現れた語を抽出する。

    収集元ごとに基準が違うため順位の合算はしない。代わりに「別々の
    データ源が同じものを指している」という一致だけを取り出す。
    これは単一ソースのノイズに強い、数少ない横断シグナル。
    """
    by_title = collections.defaultdict(set)
    for record in records:
        by_title[record["title"].strip().lower()].add(record["source"])
    overlapped = {t: s for t, s in by_title.items() if len(s) >= 2}
    return sorted(overlapped.items(), key=lambda kv: (-len(kv[1]), kv[0]))


def build(captured_at, data_dir=None):
    """指定日の需要データからNotion用Markdownを組み立てて返す。"""
    records = store.load(captured_at, data_dir)
    sources = registry.load_sources()

    previous_date = store.previous_date(captured_at, data_dir)
    previous_ranks = {}
    if previous_date:
        for record in store.load(previous_date, data_dir):
            previous_ranks[(record["source"], record["country"], record["category"],
                            record["title"])] = record["rank"]

    lines = []
    if not records:
        lines.append("この日の需要データは収集されていません。")
        return "\n".join(lines)

    by_source = collections.defaultdict(list)
    for record in records:
        by_source[record["source"]].append(record)

    lines.append("収集日: **%s** / 総レコード数: **%d件** / 収集元: **%d件**"
                 % (captured_at, len(records), len(by_source)))
    if previous_date:
        lines.append("順位変動の比較対象: %s" % previous_date)
    else:
        lines.append("順位変動の比較対象: なし(初回収集)")
    lines.append("")

    # 需要の種類ごとにまとめる
    for domain, heading in DOMAIN_HEADINGS:
        domain_sources = [s for s in by_source if sources.get(s, {}).get("domain") == domain]
        if not domain_sources:
            continue
        lines.append("## %s" % heading)
        lines.append("")

        for source_name in sorted(domain_sources, key=lambda s: sources[s].get("priority", 999)):
            source = sources[source_name]
            lines.append("### %s" % source["display_name"])
            lines.append("")

            # 国やカテゴリが違うものは別々のランキングなので、混ぜて並べない。
            # (例: 日本の1位と米国の1位は比較可能な数字ではない)
            groups = collections.defaultdict(list)
            for record in by_source[source_name]:
                groups[(record["country"], record["category"])].append(record)

            caveats = source.get("category_caveats") or {}
            for (country, category), rows in sorted(groups.items()):
                if len(groups) > 1:
                    lines.append("**%s / %s**" % (country, category))
                    lines.append("")
                # 解釈を誤ると危険な指標には、表の直前に注意書きを必ず出す。
                # 注記を人間の記憶に委ねると、数字だけが独り歩きするため。
                if category in caveats:
                    lines.append("> ⚠️ %s" % caveats[category])
                    lines.append("")
                lines.append("| 順位 | 前回比 | 名称 | 指標 |")
                lines.append("|---|---|---|---|")
                for record in sorted(rows, key=lambda r: r["rank"])[:TOP_N_PER_SOURCE]:
                    title = record["title"].replace("|", "\\|")
                    if record.get("url"):
                        title = "[%s](%s)" % (title, record["url"])
                    lines.append("| %d | %s | %s | %s |" % (
                        record["rank"], _rank_change(record, previous_ranks),
                        title, _metric_summary(record),
                    ))
                lines.append("")

            if source.get("attribution"):
                lines.append("> %s" % source["attribution"])
                lines.append("")

    # 横断シグナル
    signals = _cross_source_signals(records)
    if signals:
        lines.append("## 複数の収集元に同時に現れたもの")
        lines.append("")
        lines.append("収集元ごとにランキングの算出基準が異なるため順位は合算していません。"
                     "ここに出るのは「別々のデータ源が同じものを指している」という一致のみです。")
        lines.append("")
        lines.append("| 名称 | 現れた収集元 |")
        lines.append("|---|---|")
        for title, source_names in signals[:15]:
            lines.append("| %s | %s |" % (title, ", ".join(sorted(source_names))))
        lines.append("")

    # 規約遵守の証跡
    lines.append("## 収集元と規約上の根拠")
    lines.append("")
    lines.append("| 収集元 | 手段 | Tier | 準拠を確認した規約 |")
    lines.append("|---|---|---|---|")
    for source_name in sorted(by_source, key=lambda s: sources[s].get("priority", 999)):
        source = sources[source_name]
        lines.append("| %s | %s | %d | %s |" % (
            source["display_name"], source["collect_method"],
            source["tier"], source["terms_url"],
        ))
    lines.append("")

    rejected = [s for s in sources.values() if s.get("status") == registry.STATUS_REJECTED]
    if rejected:
        lines.append("収集しなかった主なサービス(規約またはrobots.txtで自動収集が禁止されているため): %s"
                     % ", ".join(sorted(s["display_name"] for s in rejected)))
        lines.append("")

    return "\n".join(lines)
