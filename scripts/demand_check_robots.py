#!/usr/bin/env python3
"""収集元の robots.txt を実際に取得し、対象パスの許可状況を確認する。

規約遵守の証跡を人力の記憶に頼らないための確認コマンド。結果を見て
demand/sources.json の robots_checked_at に確認日を記録する。

このスクリプトは robots.txt を1回取得するだけで、対象サイトのコンテンツ
ページには一切アクセスしない(確認行為そのものが負荷にならないように)。

使い方:
    # sources.json に登録済みの収集元をまとめて確認
    python scripts/demand_check_robots.py --date 2026-08-02

    # 特定のURLパスが許可されているかを確認
    python scripts/demand_check_robots.py --url https://coconala.com/categories/11 --date 2026-08-02

依存ライブラリなし(標準ライブラリのみ)。
"""
import argparse
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from demand import registry  # noqa: E402

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# robots.txt の取得元にこちらの素性を伝える。匿名クローラとして扱われないよう、
# 問い合わせ先が分かる形にしておく(規約遵守の姿勢を通信レベルでも示す)。
USER_AGENT = "self-evolving-ai-demand-radar/0.1 (compliance check; +https://github.com/akiijauto/self-evolving-ai-public)"
TIMEOUT_SEC = 20


def fetch_robots(robots_url):
    """robots.txt を取得して本文を返す。失敗時は (None, エラー内容)。"""
    request = urllib.request.Request(robots_url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SEC) as response:
            body = response.read().decode("utf-8", errors="replace")
            return body, None
    except urllib.error.HTTPError as exc:
        return None, "HTTP %s" % exc.code
    except Exception as exc:  # ネットワーク不通・タイムアウト等
        return None, "%s: %s" % (type(exc).__name__, exc)


def can_fetch(robots_body, target_url, user_agent=USER_AGENT):
    """robots.txt の内容に照らして target_url が取得可能かを判定する。"""
    parser = urllib.robotparser.RobotFileParser()
    parser.parse(robots_body.splitlines())
    return parser.can_fetch(user_agent, target_url)


def crawl_delay(robots_body, user_agent=USER_AGENT):
    """robots.txt が Crawl-delay を指定していればその秒数を返す。"""
    parser = urllib.robotparser.RobotFileParser()
    parser.parse(robots_body.splitlines())
    try:
        return parser.crawl_delay(user_agent)
    except Exception:
        return None


def check_one(label, robots_url, target_url):
    """1件確認して結果を表示し、許可されていれば True を返す。"""
    print("== %s ==" % label)
    print("robots.txt: %s" % robots_url)

    body, error = fetch_robots(robots_url)
    if body is None:
        print("結果: 取得失敗 (%s)" % error)
        print("  → 取得できていないため、許可されているとみなしてはいけません。")
        print()
        return False

    allowed = can_fetch(body, target_url)
    delay = crawl_delay(body)
    print("確認対象URL: %s" % target_url)
    print("結果: %s" % ("Allow(取得可)" if allowed else "Disallow(取得不可)"))
    if delay:
        print("Crawl-delay: %s 秒(この間隔以上を空けること)" % delay)
    if not allowed:
        print("  → このパスは robots.txt で拒否されています。直接取得は行わないでください。")
    else:
        print("  → robots.txt 上は許可。ただし利用規約に自動収集の禁止条項がないかは別途確認が必要です。")
    print()
    return allowed


def main():
    parser = argparse.ArgumentParser(description="収集元の robots.txt を確認する")
    parser.add_argument("--date", required=True, help="確認日(YYYY-MM-DD)。sources.json に記録する日付")
    parser.add_argument("--url", help="個別に確認したいURL。省略時は sources.json の全収集元を確認")
    parser.add_argument("--source", help="sources.json のキーを指定して1件だけ確認する")
    args = parser.parse_args()

    if args.url:
        parts = urllib.parse.urlsplit(args.url)
        if not parts.scheme or not parts.netloc:
            print("エラー: --url は https://example.com/path の形式で指定してください", file=sys.stderr)
            sys.exit(1)
        robots_url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))
        check_one(parts.netloc, robots_url, args.url)
        return

    sources = registry.load_sources()
    if args.source:
        if args.source not in sources:
            print("エラー: sources.json に %r がありません" % args.source, file=sys.stderr)
            sys.exit(1)
        sources = {args.source: sources[args.source]}

    for name, source in sources.items():
        robots_url = source.get("robots_url")
        if not robots_url:
            print("== %s ==\n結果: robots_url が未記載のため確認できません\n" % name)
            continue
        # 確認対象が指定されていなければ、サイトのトップを代表として確認する。
        target = source.get("check_url") or urllib.parse.urlunsplit(
            urllib.parse.urlsplit(robots_url)[:2] + ("/", "", "")
        )
        check_one("%s (%s)" % (name, source.get("display_name", "")), robots_url, target)

    print("確認が済んだ収集元は demand/sources.json の robots_checked_at に %s を記録してください。" % args.date)


if __name__ == "__main__":
    main()
