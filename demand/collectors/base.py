#!/usr/bin/env python3
"""収集モジュールの共通土台。HTTP取得と収集元ごとの実装の登録を扱う。

方針: 収集元ごとの差異は collect() の中に閉じ込め、外からは
「収集元名を渡すと需要レコードのリストが返る」だけに見えるようにする。
これにより収集元が増えても後段(集計・Notion出力)を触らずに済む。

依存ライブラリなし(標準ライブラリのみ)。
"""
import json
import time
import urllib.error
import urllib.request

# 収集元に対してこちらの素性を明示する。Wikimedia の User-Agent Policy が
# 連絡先入りUAを要求しているほか、匿名クローラとして扱われないようにする意味もある。
USER_AGENT = (
    "self-evolving-ai-demand-radar/0.1 "
    "(+https://github.com/akiijauto/self-evolving-ai-public)"
)
TIMEOUT_SEC = 30

# 連続リクエスト間に必ず空ける秒数。どの収集元も日次1回・少数リクエストの
# 想定だが、複数ページを取る場合に相手側へ負荷をかけないための下限。
MIN_INTERVAL_SEC = 1.0

_last_request_at = [0.0]

# 収集元名 -> collect関数 の登録簿。
_COLLECTORS = {}


class CollectError(Exception):
    """収集に失敗した場合に送出される。"""


def register(name):
    """収集関数を収集元名に紐づけるデコレータ。

    使い方:
        @register("google_trends_rss")
        def collect(source, captured_at):
            return [...]
    """
    def decorator(func):
        _COLLECTORS[name] = func
        return func
    return decorator


def get_collector(name):
    """収集元名に対応する収集関数を返す。未実装なら None。"""
    return _COLLECTORS.get(name)


def implemented():
    """収集関数が実装済みの収集元名を返す。"""
    return sorted(_COLLECTORS)


def _throttle(interval=None):
    """直前のリクエストから指定秒数(既定 MIN_INTERVAL_SEC)空ける。"""
    interval = MIN_INTERVAL_SEC if interval is None else interval
    elapsed = time.monotonic() - _last_request_at[0]
    if elapsed < interval:
        time.sleep(interval - elapsed)
    _last_request_at[0] = time.monotonic()


# レート制限(429)を受けたときの待機秒数。相手側が明示的に「速すぎる」と
# 言ってきている状態なので、素直に下がって待つ。
RETRY_WAITS_SEC = (5, 15, 45)


def fetch(url, accept=None, interval=None):
    """URLを取得して本文(str)を返す。失敗時は CollectError。

    429(レート制限)と一部の5xxのみ、間隔を空けて再試行する。それ以外の
    エラーコードは相手側の明確な拒否なので、再試行せず即座に失敗させる。
    interval は、レート制限の厳しい収集元でリクエスト間隔を広げるために使う。
    """
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    request = urllib.request.Request(url, headers=headers)

    for attempt in range(len(RETRY_WAITS_SEC) + 1):
        _throttle(interval)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SEC) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="replace")
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code < 600
            if not retryable or attempt == len(RETRY_WAITS_SEC):
                raise CollectError("%s の取得に失敗しました (HTTP %s)" % (url, exc.code))
            time.sleep(RETRY_WAITS_SEC[attempt])
        except Exception as exc:
            raise CollectError("%s の取得に失敗しました (%s: %s)" % (url, type(exc).__name__, exc))


def fetch_json(url, interval=None):
    """URLを取得してJSONとして解釈する。"""
    body = fetch(url, accept="application/json", interval=interval)
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise CollectError("%s のレスポンスがJSONとして解釈できません: %s" % (url, exc))
