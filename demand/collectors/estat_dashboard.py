#!/usr/bin/env python3
"""統計ダッシュボードAPI(総務省)からの収集。

日本国内の需要を公的統計で押さえるための収集元。他の収集元が
「検索された」「求人に載った」といった間接的なシグナルなのに対し、
これは実際に集計された公式の数字である点で性質が違う。

都道府県別の有効求人倍率をランキング化する。「どの地域で人手が
足りていないか」は、そのまま受託・人材需要の地域差を表す。

規約上の根拠: 公式ドキュメントに「本APIは利用登録不要で、誰でも
お使いいただけます」と明記されている(e-Stat本体のAPIとは別物で、
そちらはアプリケーションIDが必要)。ただし「短時間における大量の
アクセス」は禁止されているため、日次1回・必要な指標のみに絞る。

依存ライブラリなし(標準ライブラリのみ)。
"""
from . import base
from .. import schema

API_ROOT = "https://dashboard.e-stat.go.jp/api/1.0/Json"

# 全国は 00000、都道府県は 01000〜47000。
NATIONAL_REGION = "00000"
PREFECTURE_REGIONS = ["%02d000" % n for n in range(1, 48)]

# 月次。統計ダッシュボードの Cycle は 1=月次 / 4=年度。
CYCLE_MONTHLY = "1"

# 季節調整の区分。1=季節調整値 / 2=原数値。
# 地域間の比較には原数値を使う(季節調整は系列ごとに手法が異なるため)。
SEASONAL_RAW = "2"

# 統計ダッシュボードAPIは1回の応答が10万件を超えるとエラーを返すため、
# 「最新月を1回で特定してから、その月だけ全都道府県を取る」2段構えにしている。


def _get_stats(params):
    query = "&".join("%s=%s" % (k, v) for k, v in params.items())
    payload = base.fetch_json("%s/getData?%s" % (API_ROOT, query))
    stats = payload.get("GET_STATS") or {}
    result = stats.get("RESULT") or {}
    if result.get("status") != "0":
        raise base.CollectError(
            "統計ダッシュボードAPIがエラーを返しました: %s" % result.get("errorMsg", "詳細不明")
        )
    data = stats.get("STATISTICAL_DATA")
    if not data:
        raise base.CollectError("統計ダッシュボードAPIの応答にデータが含まれていません")
    return [obj["VALUE"] for obj in data["DATA_INF"]["DATA_OBJ"]]


def _latest_time(indicator_code):
    """全国系列を1回だけ引いて、その指標の最新時点(YYYYMM00)を返す。"""
    values = _get_stats({
        "Lang": "JP", "IndicatorCode": indicator_code,
        "RegionCode": NATIONAL_REGION, "Cycle": CYCLE_MONTHLY,
    })
    times = {v["@time"] for v in values}
    if not times:
        raise base.CollectError("指標 %s の時点が取得できませんでした" % indicator_code)
    return max(times)


def _prefecture_names():
    """都道府県コード -> 名称 の対応を取得する。"""
    query = "Lang=JP&RegionCode=%s" % ",".join(PREFECTURE_REGIONS)
    payload = base.fetch_json("%s/getRegionInfo?%s" % (API_ROOT, query))
    meta = payload.get("GET_META_REGION_INF") or {}
    if (meta.get("RESULT") or {}).get("status") != "0":
        raise base.CollectError("都道府県名の取得に失敗しました")

    objs = meta["METADATA_INF"]["CLASS_INF"]["CLASS_OBJ"]
    if isinstance(objs, dict):
        objs = [objs]

    names = {}
    for obj in objs:
        # 都道府県は親(全国)の CLASS 配下にぶら下がっている。
        for entry in obj.get("CLASS", []):
            names[entry["@regionCode"]] = entry["@name"]
    if not names:
        raise base.CollectError("都道府県名が1件も取得できませんでした")
    return names


def _format_month(time_code):
    """'20260600' を '2026年6月' に変換する。"""
    return "%s年%d月" % (time_code[:4], int(time_code[4:6]))


@base.register("estat_dashboard")
def collect(source, captured_at):
    """設定された指標について、都道府県別のランキングを返す。"""
    indicators = source.get("indicators") or []
    if not indicators:
        raise base.CollectError("sources.json に indicators が設定されていません")

    names = _prefecture_names()
    region_query = ",".join(PREFECTURE_REGIONS)
    records = []

    for indicator in indicators:
        code, label = indicator["code"], indicator["label"]
        latest = _latest_time(code)

        values = _get_stats({
            "Lang": "JP", "IndicatorCode": code, "RegionCode": region_query,
            "Cycle": CYCLE_MONTHLY, "Time": latest,
        })
        raw = [v for v in values if v.get("@isSeasonal") == SEASONAL_RAW]
        if not raw:
            raise base.CollectError("指標 %s の原数値が取得できませんでした" % code)

        ranked = sorted(raw, key=lambda v: float(v["$"]), reverse=True)
        for rank, value in enumerate(ranked, 1):
            region = value["@regionCode"]
            records.append(schema.make_record(
                captured_at=captured_at,
                source="estat_dashboard",
                domain=indicator.get("domain", "job"),
                country="JP",
                category=label,
                rank=rank,
                title=names.get(region, region),
                metrics={indicator.get("metric_key", "value"): float(value["$"])},
                note="集計月: %s" % _format_month(latest),
            ))

    return records
