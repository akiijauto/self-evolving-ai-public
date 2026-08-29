#!/usr/bin/env python3
"""Indeed Hiring Lab の公開データセットからの収集。

Indeed本体のサイトは規約で自動収集が禁止されているが、同社の研究部門
Hiring Lab が求人データの集計値を GitHub 上で CC BY 4.0 で公開している。
「禁止されている一次データの、公開が許された集計値を使う」という形で、
規約を守ったまま実際の求人動向を得られる数少ない経路。

2系統を収集する:
  - AI関連求人の比率(国別)    … 企業がAIスキルをどれだけ求めているか
  - 求人数指数(国別、2020/2/1=100) … 採用そのものの活況度

依存ライブラリなし(標準ライブラリのみ)。
"""
import csv
import io

from . import base
from .. import schema

RAW_ROOT = "https://raw.githubusercontent.com/hiring-lab"

AI_TRACKER_URL = "%s/ai-tracker/main/AI_posting.csv" % RAW_ROOT
POSTINGS_URL = "%s/job_postings_tracker/master/%%s/aggregate_job_postings_%%s.csv" % RAW_ROOT

# 求人数指数のうち、どの系列を使うか。
# total postings は「掲載中の求人総数」で、採用需要の水準を表す。
POSTINGS_VARIABLE = "total postings"

# 国コードは順位を振る「対象」であって、ランキングを分ける軸ではない。
# そのためレコードの country は WW(全世界横断)にし、国名は title に入れる。
COUNTRY_NAMES = {
    "AU": "オーストラリア", "CA": "カナダ", "DE": "ドイツ", "ES": "スペイン",
    "FR": "フランス", "GB": "イギリス", "IE": "アイルランド", "IT": "イタリア",
    "NL": "オランダ", "US": "アメリカ",
}


def _country_label(code):
    name = COUNTRY_NAMES.get(code)
    return "%s (%s)" % (name, code) if name else code


def _read_csv(url):
    body = base.fetch(url, accept="text/csv")
    rows = list(csv.DictReader(io.StringIO(body)))
    if not rows:
        raise base.CollectError("%s の中身が空です" % url)
    return rows


def _latest_by_country(rows, date_key, country_key, value_key, row_filter=None):
    """国ごとに最新日の値を取り出す。

    国によって最終更新日がずれるため、全体の最大日で足切りすると特定の国が
    丸ごと欠落する。そのため国ごとに最新日を取る。
    """
    latest = {}
    for row in rows:
        if row_filter and not row_filter(row):
            continue
        country, date = row.get(country_key), row.get(date_key)
        raw_value = row.get(value_key)
        if not country or not date or raw_value in (None, ""):
            continue
        try:
            value = float(raw_value)
        except ValueError:
            continue
        if country not in latest or date > latest[country][0]:
            latest[country] = (date, value)
    return latest


@base.register("indeed_hiring_lab")
def collect(source, captured_at):
    """AI求人比率と求人数指数を、それぞれ国別ランキングとして返す。"""
    records = []

    # 1) AI関連求人の比率
    ai_rows = _read_csv(AI_TRACKER_URL)
    ai_latest = _latest_by_country(ai_rows, "date", "jobcountry", "AI_share_postings")
    if not ai_latest:
        raise base.CollectError("AI求人比率を1件も抽出できませんでした(列名の変更の可能性)")

    ordered = sorted(ai_latest.items(), key=lambda kv: kv[1][1], reverse=True)
    for rank, (country, (date, share)) in enumerate(ordered, 1):
        records.append(schema.make_record(
            captured_at=captured_at,
            source="indeed_hiring_lab",
            domain="job",
            country="WW",
            category="AI関連求人の比率",
            rank=rank,
            title=_country_label(country),
            metrics={"ai_share_pct": round(share, 3)},
            note="集計日: %s" % date,
        ))

    # 2) 求人数指数。国ごとに別ファイルなので、取れた国だけを対象にする。
    countries = sorted(ai_latest)
    postings, missing = {}, []
    for country in countries:
        url = POSTINGS_URL % (country, country)
        try:
            rows = _read_csv(url)
        except base.CollectError:
            # 国によってはファイルが存在しない。全体を落とさず記録だけ残す。
            missing.append(country)
            continue
        latest = _latest_by_country(
            rows, "date", "jobcountry", "indeed_job_postings_index_SA",
            row_filter=lambda r: r.get("variable") == POSTINGS_VARIABLE,
        )
        if country in latest:
            postings[country] = latest[country]
        else:
            missing.append(country)

    if postings:
        note_suffix = (" / 取得できなかった国: %s" % ", ".join(missing)) if missing else ""
        ordered = sorted(postings.items(), key=lambda kv: kv[1][1], reverse=True)
        for rank, (country, (date, index)) in enumerate(ordered, 1):
            records.append(schema.make_record(
                captured_at=captured_at,
                source="indeed_hiring_lab",
                domain="job",
                country="WW",
                category="求人数指数(2020年2月=100)",
                rank=rank,
                title=_country_label(country),
                metrics={"postings_index_sa": index},
                note="集計日: %s%s" % (date, note_suffix),
            ))

    return records
