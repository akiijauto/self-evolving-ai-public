#!/usr/bin/env python3
"""需要データの共通スキーマ定義とバリデーション。

ECサイトの売れ筋・スキルマーケットの人気サービス・求人の募集動向を、
すべて「順位付きの需要シグナル」として同一の形に正規化する。収集元が
増えても後段(集計・Notion出力)を変更せずに済ませるための中間形式。

依存ライブラリなし(標準ライブラリのみ)。
"""
import datetime

# 需要の種類。収集元が何の需要を表しているかを区別する。
# ec      : 商品が売れている量(ECサイトの売れ筋ランキング)
# service : 役務が売れている量(スキルマーケットの人気サービス)
# job     : 企業が人材を求めている量(求人の募集数・掲載動向)
# trend   : 関心の量(検索トレンド等の代理指標)
DOMAINS = ("ec", "service", "job", "trend")

# 必須キー。どの収集元でもこれだけは必ず埋める。
REQUIRED_KEYS = (
    "captured_at",  # YYYY-MM-DD。収集を実行した日(呼び出し側が明示的に渡す)
    "source",       # sources.json のキー(例: coconala)
    "domain",       # DOMAINS のいずれか
    "country",      # ISO 3166-1 alpha-2(例: JP, US)。全世界対象なら WW
    "category",     # 収集元でのカテゴリ名。無ければ "all"
    "rank",         # 1始まりの順位
    "title",        # 商品名 / サービス名 / 職種名
)

# 任意キー。埋められる収集元だけが埋める。
OPTIONAL_KEYS = (
    "url",          # 詳細ページ
    "price",        # 数値。通貨単位は currency
    "currency",     # ISO 4217(例: JPY, USD)
    "metrics",      # dict。収集元固有の指標(販売実績数・レビュー数・応募数など)
    "note",         # 補足
)

# 出典キー。規約遵守の証跡として全レコードに自動付与される
# (collect 時に registry.py が埋めるため、収集側で書く必要はない)。
PROVENANCE_KEYS = (
    "tier",           # 1〜3。収集手段の規約リスク格付け(registry.py 参照)
    "collect_method", # 実際に使った手段(official_api / rss / open_data など)
    "terms_url",      # 準拠を確認した規約のURL
)


class SchemaError(ValueError):
    """需要レコードがスキーマを満たさない場合に送出される。"""


def _validate_date(value, field):
    if not isinstance(value, str):
        raise SchemaError("%s は YYYY-MM-DD 形式の文字列である必要があります: %r" % (field, value))
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        raise SchemaError("%s が YYYY-MM-DD 形式ではありません: %r" % (field, value))


def validate(record):
    """需要レコード1件を検証する。問題があれば SchemaError を送出する。

    後段の集計・Notion出力が壊れたデータで落ちるより、収集直後に
    落ちたほうが原因を特定しやすいため、保存前に必ず通す。
    """
    if not isinstance(record, dict):
        raise SchemaError("需要レコードは dict である必要があります: %r" % (record,))

    missing = [k for k in REQUIRED_KEYS if k not in record or record[k] in (None, "")]
    if missing:
        raise SchemaError("必須キーが不足しています: %s" % ", ".join(missing))

    _validate_date(record["captured_at"], "captured_at")

    if record["domain"] not in DOMAINS:
        raise SchemaError(
            "domain は %s のいずれかである必要があります: %r"
            % ("/".join(DOMAINS), record["domain"])
        )

    country = record["country"]
    if not isinstance(country, str) or len(country) != 2 or not country.isupper():
        raise SchemaError("country は大文字2文字のコードである必要があります(例: JP, WW): %r" % (country,))

    rank = record["rank"]
    if not isinstance(rank, int) or isinstance(rank, bool) or rank < 1:
        raise SchemaError("rank は1以上の整数である必要があります: %r" % (rank,))

    if "price" in record and record["price"] is not None:
        if not isinstance(record["price"], (int, float)) or isinstance(record["price"], bool):
            raise SchemaError("price は数値である必要があります: %r" % (record["price"],))
        if not record.get("currency"):
            raise SchemaError("price を指定する場合は currency も必要です")

    if "metrics" in record and record["metrics"] is not None:
        if not isinstance(record["metrics"], dict):
            raise SchemaError("metrics は dict である必要があります: %r" % (record["metrics"],))

    unknown = set(record) - set(REQUIRED_KEYS) - set(OPTIONAL_KEYS) - set(PROVENANCE_KEYS)
    if unknown:
        raise SchemaError(
            "未知のキーが含まれています(収集元固有の値は metrics に入れてください): %s"
            % ", ".join(sorted(unknown))
        )

    return record


def make_record(captured_at, source, domain, country, category, rank, title, **optional):
    """需要レコードを1件組み立てて検証する。収集モジュールから使う想定。"""
    record = {
        "captured_at": captured_at,
        "source": source,
        "domain": domain,
        "country": country,
        "category": category,
        "rank": rank,
        "title": title,
    }
    for key, value in optional.items():
        if value is not None:
            record[key] = value
    return validate(record)
