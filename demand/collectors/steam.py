#!/usr/bin/env python3
"""Steam の公式フィード/APIからの収集。

本システムで唯一、**売上金額ベース**であることが提供元によって明記されている
ランキング。他の収集元がダウンロード数・閲覧数・掲載数といった代理指標なのに
対し、これは実際に動いた金額の順位である点で質が違う。

フィードの description 原文:
  "The top ten products on Steam by revenue for the week, updated every Tuesday."

規約上の根拠: robots.txt は全303バイトで、Disallow は /share/ /login/ /join/
/email/ /widget/ など限られたパスのみ。/charts/ も /feeds/ も対象外で、
AIクローラーへの個別指定は一切ない。

依存ライブラリなし(標準ライブラリのみ)。
"""
import re
import xml.etree.ElementTree as ET

from . import base
from .. import schema

# フィードは RSS 1.0 (RDF) 形式で、item は channel の子ではなく兄弟にある。
RSS10_NS = "{http://purl.org/rss/1.0/}"

# 同時接続プレイヤー数のAPI。APIキー不要で公開集計値を返す。
MOST_PLAYED_URL = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/"

TOP_PLAYED_N = 25


def _strip_tags(text):
    """タイトルに紛れ込むHTMLタグを落とす。"""
    return re.sub(r"<[^>]+>", "", text or "").strip()


@base.register("steam")
def collect(source, captured_at):
    """週次の売上トップと、同時接続プレイヤー数トップを返す。"""
    records = []

    # 1) 売上金額ベースの週次トップセラー(公式RSS)
    body = base.fetch(source["endpoint"], accept="application/xml")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise base.CollectError("Steam の週次トップセラーRSSを解釈できません: %s" % exc)

    items = root.findall("%sitem" % RSS10_NS)
    if not items:
        raise base.CollectError("Steam のRSSに item が1件もありません(仕様変更の可能性)")

    channel = root.find("%schannel" % RSS10_NS)
    published = channel.findtext("pubDate") if channel is not None else None

    for rank, item in enumerate(items, 1):
        title = _strip_tags(item.findtext("%stitle" % RSS10_NS))
        if not title:
            continue
        records.append(schema.make_record(
            captured_at=captured_at,
            source="steam",
            domain="ec",
            country="WW",
            category="週間売上トップ(売上金額ベース)",
            rank=rank,
            title=title,
            url=item.findtext("%slink" % RSS10_NS),
            note=("集計週: %s" % published) if published else None,
        ))

    # 2) 同時接続プレイヤー数トップ(公式Web API、キー不要)
    # 売上が「買われた量」なのに対し、こちらは「実際に遊ばれている量」。
    # 買われても遊ばれていないタイトルを見分けるために併せて取る。
    try:
        payload = base.fetch_json(MOST_PLAYED_URL)
    except base.CollectError as exc:
        # 売上側が取れていれば全体は失敗にしない。
        records[-1]["note"] = (records[-1].get("note") or "") + " / プレイ数の取得に失敗: %s" % exc
        return records

    ranks = (payload.get("response") or {}).get("ranks") or []
    for entry in ranks[:TOP_PLAYED_N]:
        rank, appid = entry.get("rank"), entry.get("appid")
        if not rank or not appid:
            continue
        peak = entry.get("peak_in_game")
        last_week = entry.get("last_week_rank")
        records.append(schema.make_record(
            captured_at=captured_at,
            source="steam",
            domain="trend",
            country="WW",
            category="同時接続プレイヤー数トップ",
            rank=rank,
            # このAPIはタイトル名を返さずappidのみを返すため、appidをそのまま識別子にする。
            # 名前を別APIで引くと呼び出し回数が跳ね上がるので、ここでは引かない。
            title="appid:%s" % appid,
            url="https://store.steampowered.com/app/%s/" % appid,
            metrics={"peak_in_game": peak} if peak else None,
            note=("前週順位: %s" % last_week) if last_week else None,
        ))

    return records
