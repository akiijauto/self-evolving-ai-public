#!/usr/bin/env python3
"""Wikimedia ページビューAPI からの収集。

Google トレンドが相対値しか返さないのに対し、こちらは絶対PV値が取れる。
両方を並べることで「関心が伸びている」ことの裏取りができる。

規約上の根拠: 認証不要の公式API。ただし Wikimedia の User-Agent Policy が
連絡先入りUAを要求しているため、base.USER_AGENT でリポジトリURLを明示している。

依存ライブラリなし(標準ライブラリのみ)。
"""
import datetime

from . import base
from .. import schema

# 集計対象外のメタページ。需要シグナルとして意味を持たないため除外する。
EXCLUDED_PREFIXES = (
    "特別:", "Special:", "メインページ", "Main_Page",
    "Wikipedia:", "Portal:", "ノート:", "Talk:", "ファイル:", "File:",
    "カテゴリ:", "Category:", "Help:", "Template:", "テンプレート:",
)

# APIは前日分までしか確定しない。当日を指定すると404になるため1日戻す。
LAG_DAYS = 1

TOP_N = 50


def _is_meaningful(article):
    return not any(article.startswith(prefix) for prefix in EXCLUDED_PREFIXES)


@base.register("wikimedia_pageviews")
def collect(source, captured_at):
    """各プロジェクトの日次閲覧数トップを順位付きで返す。"""
    target = datetime.date.fromisoformat(captured_at) - datetime.timedelta(days=LAG_DAYS)
    records = []

    for project in source.get("projects", ["ja.wikipedia"]):
        url = source["endpoint"].format(
            project=project,
            year="%04d" % target.year,
            month="%02d" % target.month,
            day="%02d" % target.day,
        )
        payload = base.fetch_json(url)
        items = payload.get("items") or []
        if not items:
            raise base.CollectError("%s の応答に items がありません" % project)

        articles = items[0].get("articles") or []
        if not articles:
            raise base.CollectError("%s の応答に articles がありません" % project)

        country = "JP" if project.startswith("ja") else "WW"
        rank = 0
        for entry in articles:
            article = entry.get("article", "")
            if not article or not _is_meaningful(article):
                continue
            rank += 1
            if rank > TOP_N:
                break
            records.append(schema.make_record(
                captured_at=captured_at,
                source="wikimedia_pageviews",
                domain="trend",
                country=country,
                category=project,
                rank=rank,
                title=article.replace("_", " "),
                url="https://%s.org/wiki/%s" % (project.replace(".", "."), article),
                metrics={"views": entry.get("views")},
                note="集計対象日: %s" % target.isoformat(),
            ))

    return records
