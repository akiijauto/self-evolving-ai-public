#!/usr/bin/env python3
"""収集元レジストリの読み込みと、規約リスクに応じた実行ガード。

このシステムの中心にある安全装置。「規約を確認した証跡が sources.json に
残っている収集元しか実行できない」ことをコードで強制する。

設計意図: 規約確認を運用ルール(人間の心がけ)に委ねると、収集元が増えた
ときに必ず抜ける。そのため未確認の収集元は既定でスキップし、規約リスクの
高い手段(Tier 3)は明示フラグなしでは動かない構造にしている。
既存の skill_triage.py が既定dry-runで破壊的操作を防いでいるのと同じ考え方。

依存ライブラリなし(標準ライブラリのみ)。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES_FILE = ROOT / "demand" / "sources.json"

# 規約リスクの格付け。詳細は sources.json の _readme を参照。
TIER_OFFICIAL_API = 1
TIER_PUBLIC_FEED = 2
TIER_ROBOTS_ALLOWED = 3
TIER_PROHIBITED = 4

# --allow-tier3 を付けても、これ以上のTierは決して実行しない。
MAX_ALLOWED_TIER = TIER_ROBOTS_ALLOWED

STATUS_INVESTIGATING = "investigating"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
# 規約上は収集してよいが、実データを見た結果この用途には使えないと判断したもの。
# rejected(規約違反)と区別しておかないと、後から「なぜ使っていないのか」を
# 誤解して規約リスクのある収集元だと思い込む恐れがある。
STATUS_UNSUITABLE = "unsuitable"


class SourceBlocked(Exception):
    """収集元が規約ガードによって実行を拒否された場合に送出される。"""


def load_sources(path=None):
    """sources.json を読み込み、収集元定義の dict を返す(_readme は除く)。"""
    path = pathlib.Path(path) if path else SOURCES_FILE
    with path.open(encoding="utf-8") as f:
        raw = json.load(f)
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def check(name, source, allow_tier3=False):
    """収集元1件が実行可能かを判定する。不可なら SourceBlocked を送出する。

    実行可能な条件はすべて満たす必要がある:
      - status が approved であること(調査中・却下は実行しない)
      - tier が 1〜3 であること(4=規約違反は常に拒否)
      - tier 3 の場合は allow_tier3 が True であること
      - 規約URLと、規約を確認した証跡が残っていること
    """
    status = source.get("status")
    if status == STATUS_UNSUITABLE:
        raise SourceBlocked(
            "%s: 規約上は収集可能だが、データが目的に合わないため採用していません(%s)"
            % (name, source.get("notes") or "理由の記載なし")
        )
    if status == STATUS_REJECTED:
        raise SourceBlocked(
            "%s: 規約で自動収集が禁止されているため実行しません(%s)"
            % (name, source.get("notes") or "理由の記載なし")
        )
    if status != STATUS_APPROVED:
        raise SourceBlocked(
            "%s: status が %r のため実行しません。規約とrobots.txtの確認を終え、"
            "sources.json の status を approved にしてください。" % (name, status)
        )

    tier = source.get("tier")
    if not isinstance(tier, int) or isinstance(tier, bool):
        raise SourceBlocked("%s: tier が未設定です。収集手段の格付けを sources.json に記載してください。" % name)
    if tier >= TIER_PROHIBITED:
        raise SourceBlocked("%s: tier %d は規約違反の手段です。このシステムでは実装しません。" % (name, tier))
    if tier > MAX_ALLOWED_TIER:
        raise SourceBlocked("%s: tier %d は許可された上限(%d)を超えています。" % (name, tier, MAX_ALLOWED_TIER))
    if tier == TIER_ROBOTS_ALLOWED and not allow_tier3:
        raise SourceBlocked(
            "%s: tier 3(robots.txt許可下の直接取得)は既定では実行しません。"
            "内容を確認のうえ --allow-tier3 を明示指定してください。" % name
        )

    if not source.get("terms_url"):
        raise SourceBlocked("%s: terms_url が未記載です。準拠する規約のURLを残してください。" % name)
    if not source.get("collect_method"):
        raise SourceBlocked("%s: collect_method が未記載です。実際に使う取得手段を記載してください。" % name)
    if tier >= TIER_ROBOTS_ALLOWED and not source.get("robots_checked_at"):
        raise SourceBlocked(
            "%s: robots.txt の確認日(robots_checked_at)が未記載です。"
            "scripts/demand_check_robots.py で確認し、日付を記録してください。" % name
        )

    return True


def enabled_sources(allow_tier3=False, only=None, path=None):
    """実行可能な収集元だけを返す。

    戻り値: (実行可能な収集元の dict, スキップ理由の dict)
    スキップされた理由も返すことで、「なぜこの収集元が動かなかったか」を
    実行ログとNotionレポートに残せるようにしている(沈黙して減らさない)。
    """
    sources = load_sources(path)
    if only:
        unknown = set(only) - set(sources)
        if unknown:
            raise KeyError("sources.json に存在しない収集元です: %s" % ", ".join(sorted(unknown)))
        sources = {k: v for k, v in sources.items() if k in only}

    enabled, skipped = {}, {}
    for name, source in sorted(sources.items(), key=lambda kv: kv[1].get("priority", 999)):
        try:
            check(name, source, allow_tier3=allow_tier3)
        except SourceBlocked as exc:
            skipped[name] = str(exc)
        else:
            enabled[name] = source
    return enabled, skipped


def provenance(source):
    """需要レコードに付与する出典情報(規約遵守の証跡)を組み立てる。"""
    return {
        "tier": source["tier"],
        "collect_method": source["collect_method"],
        "terms_url": source["terms_url"],
    }
