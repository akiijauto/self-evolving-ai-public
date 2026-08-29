#!/usr/bin/env python3
"""npm / PyPI のダウンロード統計からの収集。

技術需要の先行指標。求人票に「Next.js経験者」と載るより先に Next.js の
ダウンロード数が動くため、受託案件の需要変化を早く捉えられる。

どちらも履歴の保持期間が短い(npm: 18ヶ月 / PyPI: 180日)ので、日次で
スナップショットを自前に貯めること自体に価値がある。

依存ライブラリなし(標準ライブラリのみ)。
"""
from . import base
from .. import schema

# pypistats.org はIPベースのレート制限が厳しいため、npmより間隔を空ける。
PYPI_INTERVAL_SEC = 3.0


def _collect_counts(packages, url_template, extract, interval=None):
    """各パッケージのダウンロード数を集める。

    1件の失敗で収集元全体を落とすと、レート制限に1回当たっただけで
    その日のデータが丸ごと欠測する。個別の失敗は許容して数だけ記録し、
    全滅した場合にのみ失敗として扱う。
    戻り値: (取得できた {パッケージ名: 数}, 取得できなかったパッケージ名のリスト)
    """
    counts, failed = {}, []
    for name in packages:
        try:
            payload = base.fetch_json(url_template % name, interval=interval)
        except base.CollectError:
            failed.append(name)
            continue
        downloads = extract(payload)
        if downloads is None:
            # 取れなかったものを0として扱うと順位を歪めるため、黙って含めない。
            failed.append(name)
            continue
        counts[name] = downloads
    return counts, failed


def _rank_by_downloads(counts, failed, captured_at, source_name, category):
    """{パッケージ名: ダウンロード数} を降順に並べて需要レコードにする。"""
    ordered = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    # 取りこぼしがあった日は、その事実をレコード自体に残す。後から
    # 「この日は順位が薄い」と判断できるようにするため。
    note = ("取得失敗: %s" % ", ".join(failed)) if failed else None
    return [
        schema.make_record(
            captured_at=captured_at,
            source=source_name,
            domain="trend",
            country="WW",
            category=category,
            rank=rank,
            title=name,
            metrics={"downloads_last_week": downloads},
            note=note,
        )
        for rank, (name, downloads) in enumerate(ordered, 1)
    ]


@base.register("npm_downloads")
def collect_npm(source, captured_at):
    """設定されたnpmパッケージの直近1週間のダウンロード数を順位付きで返す。"""
    packages = source.get("packages") or []
    if not packages:
        raise base.CollectError("sources.json に packages が設定されていません")

    counts, failed = _collect_counts(
        packages,
        "https://api.npmjs.org/downloads/point/last-week/%s",
        lambda payload: payload.get("downloads"),
    )
    if not counts:
        raise base.CollectError("npmから1件もダウンロード数を取得できませんでした")
    return _rank_by_downloads(counts, failed, captured_at, "npm_downloads", "npmパッケージ")


@base.register("pypi_downloads")
def collect_pypi(source, captured_at):
    """設定されたPyPIパッケージの直近1週間のダウンロード数を順位付きで返す。"""
    packages = source.get("packages") or []
    if not packages:
        raise base.CollectError("sources.json に packages が設定されていません")

    counts, failed = _collect_counts(
        packages,
        "https://pypistats.org/api/packages/%s/recent",
        lambda payload: (payload.get("data") or {}).get("last_week"),
        interval=PYPI_INTERVAL_SEC,
    )
    if not counts:
        raise base.CollectError(
            "PyPIから1件もダウンロード数を取得できませんでした"
            "(pypistats.org のIPベースのレート制限に当たっている可能性があります)"
        )
    return _rank_by_downloads(counts, failed, captured_at, "pypi_downloads", "PyPIパッケージ")
