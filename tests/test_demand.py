#!/usr/bin/env python3
"""需要データ収集システムの共通基盤のテスト。

特に重視しているのは規約ガード(registry.check)の検証。ここが緩むと
「規約を確認していない収集元が動いてしまう」という、このシステムで
最も避けたい事故が起きるため、通過条件を1つずつ潰す形でテストしている。

実行:
    python -m unittest discover -s tests -v
"""
import collections
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from demand import registry, report, schema, store  # noqa: E402
from demand.collectors import estat_dashboard as estat  # noqa: E402
from demand.collectors import indeed_hiring_lab as hiring_lab  # noqa: E402
from demand.collectors import job_boards  # noqa: E402
from demand.collectors import base  # noqa: E402
from demand.collectors import public_rankings  # noqa: E402

_COLLECT_SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "demand_collect.py"
_SPEC = importlib.util.spec_from_file_location("demand_collect_script", _COLLECT_SCRIPT)
demand_collect_script = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(demand_collect_script)


def approved_source(**overrides):
    """規約ガードを通過する最小構成の収集元定義を返す。"""
    source = {
        "display_name": "テスト収集元",
        "domain": "ec",
        "country": "JP",
        "status": "approved",
        "tier": 1,
        "collect_method": "official_api",
        "requires_credentials": False,
        "terms_url": "https://example.com/terms",
        "robots_url": "https://example.com/robots.txt",
        "robots_checked_at": "2026-08-02",
        "priority": 1,
    }
    source.update(overrides)
    return source


class TestSchema(unittest.TestCase):
    def test_make_record_returns_validated_record(self):
        record = schema.make_record(
            "2026-08-02", "coconala", "service", "JP", "Web制作", 1, "LP制作します",
            url="https://example.com/1", price=30000, currency="JPY",
            metrics={"orders": 120},
        )
        self.assertEqual(record["rank"], 1)
        self.assertEqual(record["metrics"], {"orders": 120})

    def test_append_demand_event_is_idempotent(self):
        """再実行しても同じ需要アラートを重複させない。"""
        original = demand_collect_script.EVENTS_FILE
        with tempfile.TemporaryDirectory() as tmp:
            demand_collect_script.EVENTS_FILE = pathlib.Path(tmp) / "events.jsonl"
            try:
                self.assertTrue(demand_collect_script.append_demand_event(
                    "2026-08-11", "demand_alert", "需要データの更新停止: test が0件を返した"
                ))
                self.assertFalse(demand_collect_script.append_demand_event(
                    "2026-08-11", "demand_alert", "需要データの更新停止: test が0件を返した"
                ))
                events = [json.loads(line) for line in demand_collect_script.EVENTS_FILE.read_text(
                    encoding="utf-8").splitlines()]
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["type"], "demand_alert")
            finally:
                demand_collect_script.EVENTS_FILE = original

    def test_missing_required_key_is_rejected(self):
        with self.assertRaises(schema.SchemaError):
            schema.validate({"captured_at": "2026-08-02", "source": "coconala"})

    def test_unknown_domain_is_rejected(self):
        with self.assertRaises(schema.SchemaError):
            schema.make_record("2026-08-02", "x", "unknown", "JP", "all", 1, "t")

    def test_bad_date_is_rejected(self):
        with self.assertRaises(schema.SchemaError):
            schema.make_record("2026/08/02", "x", "ec", "JP", "all", 1, "t")

    def test_rank_must_be_positive_int(self):
        for bad_rank in (0, -1, "1", 1.5, True):
            with self.assertRaises(schema.SchemaError):
                schema.make_record("2026-08-02", "x", "ec", "JP", "all", bad_rank, "t")

    def test_price_requires_currency(self):
        with self.assertRaises(schema.SchemaError):
            schema.make_record("2026-08-02", "x", "ec", "JP", "all", 1, "t", price=100)

    def test_unknown_key_is_rejected(self):
        # 収集元固有の値を勝手にトップレベルへ足すと、後段が気づかず取りこぼす。
        # metrics に入れるよう強制するためのテスト。
        with self.assertRaises(schema.SchemaError):
            schema.make_record("2026-08-02", "x", "ec", "JP", "all", 1, "t", seller_id="abc")

    def test_country_must_be_two_upper_letters(self):
        for bad in ("jp", "JPN", "J"):
            with self.assertRaises(schema.SchemaError):
                schema.make_record("2026-08-02", "x", "ec", bad, "all", 1, "t")


class TestRegistryGuard(unittest.TestCase):
    """規約ガードの検証。ここが本システムの安全装置の中核。"""

    def test_approved_tier1_passes(self):
        self.assertTrue(registry.check("test", approved_source()))

    def test_investigating_is_blocked(self):
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", approved_source(status="investigating"))

    def test_rejected_is_blocked(self):
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", approved_source(status="rejected"))

    def test_tier4_is_always_blocked(self):
        # 規約違反の手段は allow_tier3 を付けても通らないこと。
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", approved_source(tier=4), allow_tier3=True)

    def test_tier3_requires_explicit_flag(self):
        source = approved_source(tier=3, collect_method="html")
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", source)
        self.assertTrue(registry.check("test", source, allow_tier3=True))

    def test_tier3_requires_robots_check(self):
        source = approved_source(tier=3, collect_method="html", robots_checked_at=None)
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", source, allow_tier3=True)

    def test_missing_tier_is_blocked(self):
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", approved_source(tier=None))

    def test_missing_terms_url_is_blocked(self):
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", approved_source(terms_url=None))

    def test_missing_collect_method_is_blocked(self):
        with self.assertRaises(registry.SourceBlocked):
            registry.check("test", approved_source(collect_method=None))

    def test_enabled_sources_reports_skip_reasons(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "sources.json"
            path.write_text(json.dumps({
                "_readme": ["コメント行は無視されること"],
                "ok": approved_source(priority=1),
                "ng": approved_source(status="investigating", priority=2),
            }, ensure_ascii=False), encoding="utf-8")

            enabled, skipped = registry.enabled_sources(path=path)
            self.assertEqual(list(enabled), ["ok"])
            # 落ちた収集元を沈黙で消さず、理由を必ず返すこと。
            self.assertIn("ng", skipped)
            self.assertIn("investigating", skipped["ng"])

    def test_shipped_sources_json_only_enables_tier1_and_2(self):
        # 同梱している sources.json が読め、実行対象が Tier 1/2 のみであること。
        enabled, _ = registry.enabled_sources()
        self.assertTrue(enabled, "承認済みの収集元が1件も無い(意図しない全停止)")
        for name, source in enabled.items():
            self.assertLessEqual(source["tier"], registry.TIER_PUBLIC_FEED,
                                 "%s: 既定で Tier 3 以上が有効になっている" % name)

    def test_shipped_rejected_sources_never_run(self):
        # 却下した収集元が --allow-tier3 を付けても実行対象に入らないこと。
        # ここが破れると規約違反の収集が走るため、最も重要な回帰テスト。
        rejected = [n for n, s in registry.load_sources().items()
                    if s.get("status") == registry.STATUS_REJECTED]
        self.assertTrue(rejected, "却下済みの収集元が登録されていない")
        enabled, skipped = registry.enabled_sources(allow_tier3=True)
        for name in rejected:
            self.assertNotIn(name, enabled)
            self.assertIn(name, skipped)

    def test_shipped_coconala_requires_explicit_tier3_flag(self):
        # ココナラは Tier 3。2026-08-03 に人間が承認したが、承認だけでは足りず
        # --allow-tier3 の明示指定が無ければ実行されないこと。
        # 承認済みの収集元でもフラグ無しでは走らない、という二重ゲートの回帰テスト。
        _, skipped_default = registry.enabled_sources()
        self.assertIn("coconala", skipped_default)
        enabled_tier3, _ = registry.enabled_sources(allow_tier3=True)
        self.assertIn("coconala", enabled_tier3)

    def test_shipped_unverified_terms_sources_stay_blocked(self):
        # 利用規約を実確認できていない収集元は、Tier3方針を承認した後も
        # approved にしない。規約確認の証跡を実行の前提にするという中核ルールの回帰テスト。
        sources = registry.load_sources()
        enabled, _ = registry.enabled_sources(allow_tier3=True)
        for name in ("aupay_market", "noon", "momo"):
            self.assertNotIn(name, enabled,
                             "%s: 利用規約が未確認のまま実行対象に入っている" % name)
            self.assertEqual(sources[name]["status"], registry.STATUS_INVESTIGATING)


class TestStore(unittest.TestCase):
    def test_append_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = [
                schema.make_record("2026-08-02", "s", "ec", "JP", "家電", 1, "商品A"),
                schema.make_record("2026-08-02", "s", "ec", "JP", "家電", 2, "商品B"),
            ]
            self.assertEqual(store.append(records, "2026-08-02", data_dir=tmp), 2)
            loaded = store.load("2026-08-02", data_dir=tmp)
            self.assertEqual([r["title"] for r in loaded], ["商品A", "商品B"])

    def test_append_rejects_date_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            record = schema.make_record("2026-08-01", "s", "ec", "JP", "all", 1, "t")
            with self.assertRaises(schema.SchemaError):
                store.append([record], "2026-08-02", data_dir=tmp)

    def test_invalid_record_writes_nothing(self):
        # 1件でも壊れていたら、途中まで書いたファイルを残さないこと。
        with tempfile.TemporaryDirectory() as tmp:
            good = schema.make_record("2026-08-02", "s", "ec", "JP", "all", 1, "t")
            bad = {"captured_at": "2026-08-02", "source": "s"}
            with self.assertRaises(schema.SchemaError):
                store.append([good, bad], "2026-08-02", data_dir=tmp)
            self.assertFalse(store.data_file("2026-08-02", data_dir=tmp).exists())

    def test_replace_source_is_idempotent(self):
        # 同じ日に同じ収集元を2回収集しても、順位が重複したデータが残らないこと。
        # GitHub Actions の手動再実行と定時実行が同じ日に重なるだけで起きるため、
        # ここが破れると静かにデータが壊れる。
        with tempfile.TemporaryDirectory() as tmp:
            def batch(titles):
                return [schema.make_record("2026-08-03", "s1", "ec", "JP", "all", i, t)
                        for i, t in enumerate(titles, 1)]

            store.replace_source(batch(["A", "B"]), "2026-08-03", "s1", data_dir=tmp)
            store.replace_source(batch(["A", "B"]), "2026-08-03", "s1", data_dir=tmp)
            loaded = store.load("2026-08-03", data_dir=tmp)
            self.assertEqual(len(loaded), 2)
            self.assertEqual([r["title"] for r in loaded], ["A", "B"])

    def test_replace_source_keeps_other_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            store.append([schema.make_record("2026-08-03", "other", "ec", "JP", "all", 1, "X")],
                         "2026-08-03", data_dir=tmp)
            store.replace_source(
                [schema.make_record("2026-08-03", "s1", "ec", "JP", "all", 1, "A")],
                "2026-08-03", "s1", data_dir=tmp)
            loaded = store.load("2026-08-03", data_dir=tmp)
            self.assertEqual(sorted(r["source"] for r in loaded), ["other", "s1"])

    def test_replace_source_rejects_mismatched_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            record = schema.make_record("2026-08-03", "s1", "ec", "JP", "all", 1, "A")
            with self.assertRaises(schema.SchemaError):
                store.replace_source([record], "2026-08-03", "s2", data_dir=tmp)

    def test_stored_data_has_no_duplicate_ranks(self):
        # 蓄積済みの実データに、同一の(収集元・国・カテゴリ・順位)が
        # 二重に入っていないこと。重複は例外を出さず件数が増えるだけなので、
        # ここで見ていないと壊れたまま気づけない。
        dates = store.available_dates()
        if not dates:
            self.skipTest("収集済みデータが無いため検証をスキップします")
        for date in dates:
            seen = collections.Counter(
                (r["source"], r["country"], r["category"], r["rank"])
                for r in store.load(date)
            )
            duplicated = [k for k, n in seen.items() if n > 1]
            self.assertFalse(duplicated, "%s に重複レコード: %s" % (date, duplicated[:5]))

    def test_load_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(store.load("2026-08-02", data_dir=tmp), [])

    def test_previous_date_skips_missing_days(self):
        # 収集に失敗した日があっても、直近の収集日を比較対象にできること。
        with tempfile.TemporaryDirectory() as tmp:
            for date in ("2026-07-28", "2026-07-31"):
                store.append(
                    [schema.make_record(date, "s", "ec", "JP", "all", 1, "t")], date, data_dir=tmp
                )
            self.assertEqual(store.previous_date("2026-08-02", data_dir=tmp), "2026-07-31")
            self.assertIsNone(store.previous_date("2026-07-28", data_dir=tmp))


class TestReport(unittest.TestCase):
    def test_metric_labels_cover_every_metric_key_in_use(self):
        # 収集モジュールが新しい metrics キーを足したのにラベルを足し忘れると、
        # Notionに `ratio 1.7` のような生キーがそのまま出てしまう。
        used = set()
        for date in store.available_dates():
            for record in store.load(date):
                used.update((record.get("metrics") or {}).keys())
        if not used:
            self.skipTest("収集済みデータが無いため検証をスキップします")
        missing = used - set(report.METRIC_LABELS)
        self.assertFalse(missing, "report.py にラベル未定義の metrics キー: %s" % sorted(missing))

    def test_rank_change_arrows(self):
        previous = {("s", "JP", "c", "上昇"): 5, ("s", "JP", "c", "下降"): 1,
                    ("s", "JP", "c", "横ばい"): 3}

        def record(title, rank):
            return {"source": "s", "country": "JP", "category": "c",
                    "title": title, "rank": rank}

        self.assertEqual(report._rank_change(record("上昇", 2), previous), "▲ +3")
        self.assertEqual(report._rank_change(record("下降", 4), previous), "▼ -3")
        self.assertEqual(report._rank_change(record("横ばい", 3), previous), "— 0")
        self.assertEqual(report._rank_change(record("初登場", 1), previous), "🆕 新規")

    def test_cross_source_signals_requires_two_sources(self):
        records = [
            {"title": "React", "source": "npm_downloads"},
            {"title": "react", "source": "remotive"},
            {"title": "vue", "source": "npm_downloads"},
        ]
        signals = report._cross_source_signals(records)
        # 表記ゆれを吸収して同じものと見なし、1ソースだけのものは出さない。
        self.assertEqual([title for title, _ in signals], ["react"])


class TestCategoryCaveats(unittest.TestCase):
    def test_hiring_lab_ai_share_has_a_caveat(self):
        # AI関連求人比率は、カナダのオンタリオ州のAI開示義務化(2026-01)により
        # 制度要因で跳ねている。数字だけが独り歩きしないよう、注意書きが
        # レジストリに登録されていることを担保する。
        source = registry.load_sources()["indeed_hiring_lab"]
        caveats = source.get("category_caveats") or {}
        self.assertIn("AI関連求人の比率", caveats)
        self.assertIn("カナダ", caveats["AI関連求人の比率"])

    def test_report_renders_category_caveat(self):
        with tempfile.TemporaryDirectory() as tmp:
            store.append([
                schema.make_record("2026-08-03", "indeed_hiring_lab", "job", "WW",
                                   "AI関連求人の比率", 1, "カナダ (CA)",
                                   metrics={"ai_share_pct": 17.93}),
            ], "2026-08-03", data_dir=tmp)
            body = report.build("2026-08-03", data_dir=tmp)
        self.assertIn("⚠️", body)
        self.assertIn("国際比較に使ってはいけない", body)


class TestHiringLabParsing(unittest.TestCase):
    def test_latest_by_country_picks_per_country_latest(self):
        # 国ごとに最終更新日がずれるため、全体の最大日で足切りしないこと。
        rows = [
            {"date": "2026-06-30", "jobcountry": "US", "v": "5.0"},
            {"date": "2026-05-31", "jobcountry": "US", "v": "4.0"},
            {"date": "2026-04-30", "jobcountry": "JP", "v": "9.0"},
        ]
        latest = hiring_lab._latest_by_country(rows, "date", "jobcountry", "v")
        self.assertEqual(latest["US"], ("2026-06-30", 5.0))
        self.assertEqual(latest["JP"], ("2026-04-30", 9.0))

    def test_latest_by_country_skips_unparsable_values(self):
        rows = [
            {"date": "2026-06-30", "jobcountry": "US", "v": ""},
            {"date": "2026-06-30", "jobcountry": "GB", "v": "N/A"},
            {"date": "2026-06-30", "jobcountry": "DE", "v": "1.5"},
        ]
        latest = hiring_lab._latest_by_country(rows, "date", "jobcountry", "v")
        self.assertEqual(list(latest), ["DE"])

    def test_latest_by_country_applies_row_filter(self):
        rows = [
            {"date": "2026-07-24", "jobcountry": "US", "v": "102", "variable": "total postings"},
            {"date": "2026-07-24", "jobcountry": "US", "v": "97", "variable": "new postings"},
        ]
        latest = hiring_lab._latest_by_country(
            rows, "date", "jobcountry", "v",
            row_filter=lambda r: r["variable"] == "total postings",
        )
        self.assertEqual(latest["US"][1], 102.0)


class TestEstatDashboard(unittest.TestCase):
    def test_format_month(self):
        self.assertEqual(estat._format_month("20260600"), "2026年6月")
        self.assertEqual(estat._format_month("20261200"), "2026年12月")

    def test_prefecture_region_codes(self):
        self.assertEqual(len(estat.PREFECTURE_REGIONS), 47)
        self.assertEqual(estat.PREFECTURE_REGIONS[0], "01000")
        self.assertEqual(estat.PREFECTURE_REGIONS[-1], "47000")


class TestPublicRankingsParsing(unittest.TestCase):
    """Tier3のHTML収集。相手の都合で構造が変わるため、静かに0件にならないことを検証する。"""

    def _fake_fetch(self, body):
        return lambda url, accept=None, interval=None: body

    def test_dlsite_extracts_rank_sales_and_price(self):
        html_body = (
            '<table><tbody><tr class="">'
            '<td class="ranking_count"><div class="ranking_count_inner">'
            '<div class="rank_no type_1">1</div>'
            '<div class="dl_count"><span class="dl_count_label">販売数</span>10,438</div>'
            '</div></td><td><dl class="work_1col">'
            '<dt class="work_name"><a href="https://example.com/w1">作品A</a></dt>'
            '<dd class="maker_name"><a href="#">サークルX</a></dd>'
            '<span class="work_price discount">1,188<i>円</i></span>'
            '</dl></td></tr></tbody></table>'
        )
        original = public_rankings.base.fetch
        public_rankings.base.fetch = self._fake_fetch(html_body)
        try:
            records = public_rankings.collect_dlsite({}, "2026-08-03")
        finally:
            public_rankings.base.fetch = original

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["rank"], 1)
        self.assertEqual(records[0]["title"], "作品A")
        self.assertEqual(records[0]["metrics"]["sales_count"], 10438)
        self.assertEqual(records[0]["price"], 1188)
        self.assertEqual(records[0]["currency"], "JPY")

    def test_kinokuniya_uses_the_rank_in_the_markup(self):
        # 順位はクラス名に入っている。出現順で振り直すと欠番があったときにずれる。
        html_body = (
            '<p id="period">8月2日のベストセラー</p>'
            '<li class="rank_1"><p class="book_title"><a href="https://example.com/a">本A</a></p></li>'
            '<li class="rank_3"><p class="book_title"><a href="https://example.com/c">本C</a></p></li>'
        )
        original = public_rankings.base.fetch
        public_rankings.base.fetch = self._fake_fetch(html_body)
        try:
            records = public_rankings.collect_kinokuniya({}, "2026-08-03")
        finally:
            public_rankings.base.fetch = original

        self.assertEqual([r["rank"] for r in records], [1, 3])
        self.assertIn("8月2日のベストセラー", records[0]["note"])

    def test_empty_page_fails_loudly(self):
        # 構造が変わって0件になったとき、成功扱いにして静かに対象を減らさないこと。
        original = public_rankings.base.fetch
        public_rankings.base.fetch = self._fake_fetch("<html><body>お探しのページは見つかりません</body></html>")
        try:
            for collect in (public_rankings.collect_dlsite,
                            public_rankings.collect_kinokuniya,
                            public_rankings.collect_coconala):
                with self.assertRaises(base.CollectError):
                    collect({}, "2026-08-03")
        finally:
            public_rankings.base.fetch = original


if __name__ == "__main__":
    unittest.main()
