#!/usr/bin/env python3
"""Google トレンド 急上昇ワードRSS からの収集。

検索需要そのものを日次で取れる、本システムで最も直接的な需要指標。

規約上の根拠: trends.google.com の robots.txt は全文5行で、禁止しているのは
/explore? と /trends/explore? のみ。/trending/rss はその対象に含まれない。
逆に pytrends 等の非公式ライブラリが叩くのは禁止対象の explore 系エンドポイント
であるため、本システムでは使用しない。

依存ライブラリなし(標準ライブラリのみ)。
"""
import re
import xml.etree.ElementTree as ET

from . import base
from .. import schema

# RSSの拡張名前空間(ht:approx_traffic, ht:picture など)
HT_NS = "https://trends.google.com/trending/rss"


def _text(item, tag, ns=None):
    node = item.find("{%s}%s" % (ns, tag) if ns else tag)
    return node.text.strip() if node is not None and node.text else None


def _parse_traffic(raw):
    """'500+' や '2,000+' といった推定検索ボリュームを整数に変換する。

    レンジ表記(下限値+)なので、そのまま下限値として扱う。値が読めない場合は
    無理に推定せず None を返す(欠測は欠測として残す)。
    """
    if not raw:
        return None
    digits = re.sub(r"[^0-9]", "", raw)
    return int(digits) if digits else None


@base.register("google_trends_rss")
def collect(source, captured_at):
    """設定された各国の急上昇ワードを順位付きで返す。"""
    records = []
    endpoint = source["endpoint"]

    for geo in source.get("geos", ["JP"]):
        body = base.fetch(endpoint.format(geo=geo), accept="application/rss+xml")
        try:
            root = ET.fromstring(body)
        except ET.ParseError as exc:
            raise base.CollectError("geo=%s のRSSを解釈できません: %s" % (geo, exc))

        items = root.findall(".//item")
        if not items:
            # 取得はできたが中身が空。無言で0件にせず、収集元の仕様変更に気づけるようにする。
            raise base.CollectError("geo=%s のRSSに item が1件もありません(仕様変更の可能性)" % geo)

        for rank, item in enumerate(items, 1):
            title = _text(item, "title")
            if not title:
                continue
            traffic = _parse_traffic(_text(item, "approx_traffic", HT_NS))
            records.append(schema.make_record(
                captured_at=captured_at,
                source="google_trends_rss",
                domain="trend",
                country=geo,
                category="急上昇ワード",
                rank=rank,
                title=title,
                # item の link はフィード自身を指しており個別ワードのページではない。
                # 誤ったリンクを載せるより、リンク無しのほうが正確。
                metrics={"approx_traffic_min": traffic} if traffic else None,
            ))

    return records
