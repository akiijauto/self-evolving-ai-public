#!/usr/bin/env python3
"""リモート求人APIからの収集(Remotive / RemoteOK)。

個別の求人ではなく、求人に付与されたスキルタグの分布を集計する。
個別求人は日々入れ替わるが、タグの分布は「企業が何を求めているか」という
需要構造を表すため。

2つの求人ボードを別々の収集元として扱い、集計を混ぜない。掲載基準も
母数も違うため、合算するとどちらの実態も表さない数字になる。

規約上の根拠: どちらも認証不要の公式APIで、レスポンス本体に利用条件が
埋め込まれている。出典明記が条件のため attribution を必ず併記する。

依存ライブラリなし(標準ライブラリのみ)。
"""
import collections

from . import base
from .. import schema

TOP_N = 40

# 雇用形態や勤務地など、スキル需要を表さないタグ。集計から除く。
NOISE_TAGS = {
    "full time", "part time", "contract", "freelance", "internship",
    "remote", "anywhere", "worldwide", "english", "hiring",
    "digital nomad", "travel", "non tech",
}


def _rank_tags(jobs, source_name, captured_at, category_of=None):
    """求人リストからタグの出現数ランキングを組み立てる。

    category_of が渡された場合、そのタグが最も多く現れた求人カテゴリを
    note に添える(どの職種で求められているタグかを見失わないため)。
    """
    counter = collections.Counter()
    categories = collections.defaultdict(collections.Counter)

    for job in jobs:
        category = (category_of(job) or "").strip() if category_of else ""
        for tag in job.get("tags") or []:
            normalized = str(tag).strip().lower()
            if not normalized or normalized in NOISE_TAGS:
                continue
            counter[normalized] += 1
            if category:
                categories[normalized][category] += 1

    if not counter:
        raise base.CollectError(
            "%s の求人からスキルタグを1件も抽出できませんでした" % source_name
        )

    total = len(jobs)
    records = []
    for rank, (tag, count) in enumerate(counter.most_common(TOP_N), 1):
        note = "全%d件の求人が母数" % total
        if categories.get(tag):
            note += " / 主な職種: %s" % categories[tag].most_common(1)[0][0]
        records.append(schema.make_record(
            captured_at=captured_at,
            source=source_name,
            domain="job",
            country="WW",
            # 順位は全求人を母数に一本で振っているため、category も単一にする。
            # (職種別に分けると通し番号の順位が分断されて歯抜けに見えてしまう)
            category="全職種",
            rank=rank,
            title=tag,
            metrics={
                "job_count": count,
                "share_pct": round(count / total * 100, 2),
            },
            note=note,
        ))
    return records


@base.register("remotive")
def collect_remotive(source, captured_at):
    """Remotive の求人からスキルタグ分布を返す。"""
    payload = base.fetch_json(source["endpoint"])
    jobs = payload.get("jobs") or []
    if not jobs:
        raise base.CollectError("Remotive の応答に jobs がありません(仕様変更の可能性)")
    return _rank_tags(jobs, "remotive", captured_at,
                      category_of=lambda job: job.get("category"))


@base.register("remoteok")
def collect_remoteok(source, captured_at):
    """RemoteOK の求人からスキルタグ分布を返す。

    応答は配列で、先頭要素が求人ではなく利用条件(legal)を含むメタ情報。
    求人として扱わないよう position キーの有無で選別する。
    """
    payload = base.fetch_json(source["endpoint"])
    if not isinstance(payload, list):
        raise base.CollectError("RemoteOK の応答が配列ではありません(仕様変更の可能性)")

    jobs = [entry for entry in payload
            if isinstance(entry, dict) and entry.get("position")]
    if not jobs:
        raise base.CollectError("RemoteOK の応答に求人が含まれていません(仕様変更の可能性)")
    return _rank_tags(jobs, "remoteok", captured_at)
