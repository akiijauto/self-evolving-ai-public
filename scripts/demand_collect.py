#!/usr/bin/env python3
"""需要データを収集し、日付別のJSONLへ保存する。

規約ガード(demand/registry.py)を通過した収集元だけを実行する。スキップされた
収集元は理由付きで必ず表示する(黙って対象を減らさない)。

使い方:
    # 承認済みの収集元をすべて収集
    python scripts/demand_collect.py --date 2026-08-02

    # 何が実行され何がスキップされるかだけ確認する(通信しない)
    python scripts/demand_collect.py --date 2026-08-02 --dry-run

    # 特定の収集元だけ
    python scripts/demand_collect.py --date 2026-08-02 --source google_trends_rss

依存ライブラリなし(標準ライブラリのみ)。
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from demand import registry, store  # noqa: E402
from demand.collectors import base  # noqa: E402
import demand.collectors  # noqa: E402,F401  (収集モジュールを登録簿に読み込む)

ROOT = pathlib.Path(__file__).resolve().parent.parent
EVENTS_FILE = ROOT / "context" / "events.jsonl"


def append_demand_event(date, event_type, summary):
    """収集品質の変化を、重複させず自己発展ループへ渡す。"""
    event = {
        "date": date,
        "actor": "demand-collector",
        "type": event_type,
        "summary": summary,
    }
    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if EVENTS_FILE.exists():
        for line in EVENTS_FILE.read_text(encoding="utf-8").splitlines():
            try:
                if json.loads(line) == event:
                    return False
            except json.JSONDecodeError:
                continue
    with EVENTS_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
    return True


def previous_source_count(date, source_name):
    """前回取得日における同一収集元の件数。欠損日は比較対象から外す。"""
    previous = store.previous_date(date)
    if not previous:
        return None
    return sum(1 for record in store.load(previous) if record.get("source") == source_name)

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')


def write_summary(path, summary):
    """収集結果をGitHub Actionsなどから読めるJSONとして保存する。"""
    if not path:
        return
    destination = pathlib.Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description="需要データを収集してJSONLに保存する")
    parser.add_argument("--date", required=True,
                        help="収集日(YYYY-MM-DD)。実行環境の現在日付をAI自身が把握し指定すること")
    parser.add_argument("--source", action="append",
                        help="収集元名。複数指定可。省略時は承認済みの全収集元")
    parser.add_argument("--allow-tier3", action="store_true",
                        help="robots.txt許可下の直接取得(Tier 3)も実行する。内容を確認したうえで明示的に指定すること")
    parser.add_argument("--dry-run", action="store_true",
                        help="通信せず、実行対象とスキップ理由の一覧だけ表示する")
    parser.add_argument("--summary-file",
                        help="収集結果をJSONで保存するパス（GitHub Actions通知用）")
    parser.add_argument("--volume-drop-ratio", type=float, default=0.5,
                        help="前回比でこの割合以上減ったら需要アラートにする(既定: 0.5)")
    args = parser.parse_args()

    enabled, skipped = registry.enabled_sources(
        allow_tier3=args.allow_tier3, only=args.source
    )
    summary = {
        "date": args.date,
        "enabled_source_count": len(enabled),
        "successful_sources": [],
        "failed_sources": [],
        "unimplemented_sources": [],
        "records_saved": 0,
    }

    if skipped:
        print("== スキップした収集元 ==")
        for name, reason in skipped.items():
            print("  - %s" % reason)
        print()

    if not enabled:
        print("実行対象の収集元がありません。")
        write_summary(args.summary_file, summary)
        return 0

    print("== 実行対象 ==")
    for name, source in enabled.items():
        collector = base.get_collector(name)
        state = "実装済み" if collector else "★収集モジュール未実装"
        print("  - %s (%s / tier %d / %s) %s"
              % (name, source["display_name"], source["tier"], source["collect_method"], state))
    print()

    if args.dry_run:
        print("--dry-run のため通信は行いませんでした。")
        write_summary(args.summary_file, summary)
        return 0

    if not 0 < args.volume_drop_ratio <= 1:
        parser.error("--volume-drop-ratio は 0 より大きく 1 以下で指定してください")

    total, failures, unimplemented = 0, [], []
    for name, source in enabled.items():
        collector = base.get_collector(name)
        if collector is None:
            # 規約上は収集してよいが、まだ収集モジュールを書いていない状態。
            # 規約違反ではないので異常終了はさせず、未着手として表に出す。
            unimplemented.append(name)
            summary["unimplemented_sources"].append({
                "name": name,
                "display_name": source["display_name"],
            })
            continue

        try:
            records = collector(source, args.date)
        except base.CollectError as exc:
            # 1つの収集元が落ちても他は続行する。ただし失敗は必ず最後に報告する。
            failures.append("%s: %s" % (name, exc))
            summary["failed_sources"].append({
                "name": name,
                "display_name": source["display_name"],
                "reason": str(exc),
            })
            append_demand_event(
                args.date,
                "demand_alert",
                "需要データの更新停止: %s の収集に失敗 (%s)" % (name, exc),
            )
            continue

        # 出典情報(規約遵守の証跡)は収集モジュールではなくここで一律に付与する。
        stamp = registry.provenance(source)
        for record in records:
            record.update(stamp)

        # 同じ日に同じ収集元を2回実行しても結果が変わらないよう、追記ではなく置換する。
        saved = store.replace_source(records, args.date, name)
        total += saved
        summary["successful_sources"].append({
            "name": name,
            "display_name": source["display_name"],
            "records_saved": saved,
        })
        print("%s: %d件を保存しました" % (name, saved))

        previous_count = previous_source_count(args.date, name)
        if saved == 0:
            append_demand_event(
                args.date,
                "demand_alert",
                "需要データの更新停止: %s が0件を返した" % name,
            )
        elif previous_count and saved <= previous_count * (1 - args.volume_drop_ratio):
            append_demand_event(
                args.date,
                "demand_signal",
                "需要データ件数が急減: %s は前回%d件から%d件へ減少" %
                (name, previous_count, saved),
            )

    summary["records_saved"] = total
    write_summary(args.summary_file, summary)

    print()
    print("合計 %d件を %s に保存しました。" % (total, store.data_file(args.date)))

    if unimplemented:
        print()
        print("== 規約上は収集可能だが、収集モジュールが未実装 ==")
        for name in unimplemented:
            print("  - %s" % name)

    if failures:
        print()
        print("== 失敗した収集元 ==")
        for failure in failures:
            print("  - %s" % failure)
        # 一部でも失敗したら異常終了させ、GitHub Actions 上で気づけるようにする。
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
