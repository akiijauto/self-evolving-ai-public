#!/usr/bin/env python3
"""Apple の公式RSSフィードからの収集。

本システムの当初の目的である「世界中で何が売れているか」に、現時点で
最も直接的に答える収集元。有料アプリ・有料書籍のランキングは、閲覧数や
検索数ではなく実際に金銭が動いた結果の順位である点で、他の収集元と質が違う。

規約上の根拠: Apple が公式に提供するRSSフィード。認証情報は不要で、
apps.apple.com の robots.txt が禁止しているパスとも別ホスト。
フィード自体に著作権表記が含まれるため、出典として併記する。

注意: ホストは rss.applemarketingtools.com から rss.marketingtools.apple.com へ
移転している(旧ホストは301)。新ホストを直接指定している。

依存ライブラリなし(標準ライブラリのみ)。
"""
from . import base
from .. import schema

# ストアフロントごとに独立したランキングなので、country を分割軸として使う。
# (日本の1位と米国の1位は別のランキングであり、混ぜてはいけない)


@base.register("apple_rss")
def collect(source, captured_at):
    """設定されたストアフロント×フィードの組み合わせを順位付きで返す。"""
    feeds = source.get("feeds") or []
    storefronts = source.get("storefronts") or []
    if not feeds or not storefronts:
        raise base.CollectError("sources.json に feeds / storefronts が設定されていません")

    limit = source.get("limit", 25)
    records, failures = [], []

    for storefront in storefronts:
        for feed in feeds:
            url = source["endpoint"].format(
                storefront=storefront, media=feed["media"],
                feed=feed["feed"], limit=limit, kind=feed["kind"],
            )
            try:
                payload = base.fetch_json(url)
            except base.CollectError as exc:
                # 国によって提供されないフィードがある(例: 一部ストアの top-grossing)。
                # 1つの欠落で全体を落とさず、何が取れなかったかは残す。
                failures.append("%s/%s/%s (%s)" % (storefront, feed["media"], feed["feed"], exc))
                continue

            results = (payload.get("feed") or {}).get("results") or []
            if not results:
                failures.append("%s/%s/%s (結果が空)" % (storefront, feed["media"], feed["feed"]))
                continue

            for rank, entry in enumerate(results, 1):
                name = entry.get("name")
                if not name:
                    continue
                artist = entry.get("artistName")
                records.append(schema.make_record(
                    captured_at=captured_at,
                    source="apple_rss",
                    domain=feed.get("domain", "ec"),
                    country=storefront.upper(),
                    category=feed["label"],
                    rank=rank,
                    title=name,
                    url=entry.get("url"),
                    note=("提供元: %s" % artist) if artist else None,
                ))

    if not records:
        raise base.CollectError(
            "Apple RSS から1件も取得できませんでした: %s" % "; ".join(failures[:3])
        )
    return records
