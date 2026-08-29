#!/usr/bin/env python3
"""世界の主要ソフトウェアシステムを、売上・採用量・求人の3軸でランキングする。

■ なぜ日次バッチではなく都度実行なのか
このランキングの主軸である売上は、四半期ごとの決算でしか動かない。日次で
取りに行っても同じ値が返るだけで、相手のサーバにも実行コストにも無駄が出る。
Remotive も API の返答自体が「1日4回までで十分、データはそれより速く変わらない」
と明言している。そのため日次ワークフロー(.github/workflows/demand-collect.yml)
には入れず、決算期の後や必要になったときに手で叩く設計にしている。

■ 3軸の合成方法(重要)
このリポジトリには「収集元をまたいだ合算ランキングを作らない」という約束がある。
算出基準の異なる数字を足すと、どの実態も表さない数字になるためである。
ここでもその原則は崩さない。具体的には:

  - 絶対値は決して足さない(売上のドルと求人の件数を足すようなことはしない)
  - 各軸で順位を出し、順位の合計で総合順位を決める(順位和法)
  - 各軸の順位は必ず併記し、総合順位だけを見て判断できないようにする
  - 軸ごとに測れないシステムがあるため、何軸で測れたか(coverage)も出す

■ 各軸の信頼度の差
売上は公開されている決算資料が出典で、根拠として強い。
一方で求人は、規約を守って自動取得できるのが Remotive と RemoteOK だけで、
両者を合わせても母数が100件台のリモート求人しかない。企業向けソフトの
求人需要を代表する数字ではないので、レポートには必ず母数を明記する。

依存ライブラリなし(標準ライブラリのみ)。

使い方:
    # ランキングを表示する
    python scripts/software_ranking.py --date 2026-08-04

    # 前回実行時からの求人の増減を出す(2回目以降)
    python scripts/software_ranking.py --date 2026-08-04 --compare
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from demand import store  # noqa: E402
from demand.collectors import base  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY_FILE = ROOT / "demand" / "software_systems.json"
SNAPSHOT_DIR = ROOT / "context" / "software"

# 求人の突き合わせに使う求人ボード。いずれも sources.json で承認済み(Tier 1)。
# Remotive は規約で出典表示を求めているため、レポートに必ず出典行を入れる。
JOB_BOARDS = (
    ("remotive", "https://remotive.com/api/remote-jobs",
     "出典: Remotive (https://remotive.com)"),
    ("remoteok", "https://remoteok.com/api",
     "出典: RemoteOK (https://remoteok.com)"),
)

AXES = ("revenue", "adoption", "jobs")
AXIS_LABELS = {"revenue": "売上", "adoption": "採用量", "jobs": "求人"}


def load_registry(path=None):
    path = pathlib.Path(path) if path else REGISTRY_FILE
    with path.open(encoding="utf-8") as f:
        raw = json.load(f)
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def collect_job_texts():
    """求人ボードから求人1件ごとのテキストを集める。

    戻り値: (テキストのリスト, 求人ボードごとの件数)
    Remotive の search パラメータはサーバ側で効かず全件が返るため(実測)、
    キーワードの突き合わせはこちら側で行う。
    """
    texts, counts = [], {}
    for name, url, _attribution in JOB_BOARDS:
        try:
            payload = base.fetch_json(url)
        except base.CollectError as exc:
            counts[name] = "取得失敗(%s)" % exc
            continue
        jobs = payload.get("jobs", payload) if isinstance(payload, dict) else payload
        if not isinstance(jobs, list):
            counts[name] = "想定外の形式"
            continue
        board_texts = []
        for job in jobs:
            if not isinstance(job, dict):
                continue
            parts = [str(job.get(key, "")) for key in
                     ("title", "position", "description", "tags", "category")]
            board_texts.append(" ".join(parts).lower())
        counts[name] = len(board_texts)
        texts.extend(board_texts)
    return texts, counts


def count_keyword_hits(job_texts, keywords):
    """求人テキストのうち、キーワードのいずれかを含む件数を返す。

    1件の求人が複数キーワードに当たっても1件として数える(二重計上しない)。
    """
    if not keywords:
        return None
    lowered = [k.lower() for k in keywords]
    return sum(1 for text in job_texts if any(k in text for k in lowered))


# 採用量は、日次収集が持っている上位パッケージ一覧には載らない名前
# (boto3 や oracledb など)を見たいので、パッケージ統計APIを直接引く。
# いずれも sources.json で承認済みの公式API。
NPM_URL = "https://api.npmjs.org/downloads/point/last-week/%s"
PYPI_URL = "https://pypistats.org/api/packages/%s/recent"
# pypistats.org はIPベースのレート制限が厳しいため間隔を広く取る。
PYPI_INTERVAL_SEC = 3.0


def adoption_downloads(system, cache):
    """対象パッケージの週間DL数の合計を返す。対象パッケージが無ければ None。

    cache は同じパッケージを2度引かないための辞書(呼び出し側が持つ)。
    個別パッケージの取得失敗は許容する(全滅したときだけ None になる)。
    """
    packages = system.get("adoption_packages") or {}
    targets = [("npm", name) for name in packages.get("npm", [])]
    targets += [("pypi", name) for name in packages.get("pypi", [])]
    if not targets:
        return None

    total, found = 0, False
    for kind, name in targets:
        if (kind, name) not in cache:
            cache[(kind, name)] = _fetch_downloads(kind, name)
        downloads = cache[(kind, name)]
        if downloads is not None:
            total += downloads
            found = True
    return total if found else None


def _fetch_downloads(kind, name):
    """1パッケージの週間DL数を返す。取得できなければ None。"""
    try:
        if kind == "npm":
            return base.fetch_json(NPM_URL % name).get("downloads")
        payload = base.fetch_json(PYPI_URL % name, interval=PYPI_INTERVAL_SEC)
        return (payload.get("data") or {}).get("last_week")
    except base.CollectError:
        return None


def rank_by(values):
    """値の大きい順に1始まりの順位を付ける。None は順位を付けない。

    同値は同順位にする。順位和法で使うため、順位の飛ばし方(1,2,2,4)を
    採用している。
    """
    present = sorted({v for v in values.values() if v is not None}, reverse=True)
    ranks, position = {}, 1
    for value in present:
        for key, v in values.items():
            if v == value:
                ranks[key] = position
        position += sum(1 for v in values.values() if v == value)
    return ranks


def build(date, registry=None, job_texts=None, download_cache=None):
    """3軸の値と順位、総合順位を組み立てて返す。"""
    registry = registry if registry is not None else load_registry()
    job_texts = job_texts if job_texts is not None else []
    download_cache = download_cache if download_cache is not None else {}

    values = {axis: {} for axis in AXES}
    for key, system in registry.items():
        values["revenue"][key] = system.get("revenue_usd_b")
        values["adoption"][key] = adoption_downloads(system, download_cache)
        values["jobs"][key] = count_keyword_hits(job_texts, system.get("job_keywords"))

    ranks = {axis: rank_by(values[axis]) for axis in AXES}

    rows = []
    for key, system in registry.items():
        measured = [axis for axis in AXES if ranks[axis].get(key) is not None]
        # 順位和法。測れなかった軸は最下位扱いにせず、測れた軸だけで平均を取る。
        # 最下位扱いにすると「測れないこと」が「人気が無いこと」に化けてしまう。
        rank_sum = sum(ranks[axis][key] for axis in measured)
        rows.append({
            "key": key,
            "display_name": system["display_name"],
            "vendor": system.get("vendor"),
            "category": system.get("category"),
            "values": {axis: values[axis][key] for axis in AXES},
            "ranks": {axis: ranks[axis].get(key) for axis in AXES},
            "measured_axes": len(measured),
            "score": rank_sum / len(measured) if measured else None,
            "is_estimate": system.get("is_estimate", False),
            "period": system.get("period"),
            "source_url": system.get("source_url"),
            "note": system.get("note"),
        })

    # 総合は順位の平均が小さい順。同点は売上順位で割る(主軸を優先する)。
    rows.sort(key=lambda r: (r["score"] if r["score"] is not None else 999,
                             r["ranks"]["revenue"] or 999))
    for index, row in enumerate(rows, 1):
        row["overall_rank"] = index
    return {"date": date, "rows": rows}


def load_previous(date):
    """直近(当日より前)のスナップショットを返す。無ければ None。"""
    if not SNAPSHOT_DIR.exists():
        return None
    candidates = sorted(p for p in SNAPSHOT_DIR.glob("*.json") if p.stem < date)
    if not candidates:
        return None
    with candidates[-1].open(encoding="utf-8") as f:
        return json.load(f)


def save_snapshot(result):
    """求人の増減を後から出せるようにスナップショットを残す。"""
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOT_DIR / ("%s.json" % result["date"])
    with path.open("w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return path


def format_report(result, job_counts, previous=None):
    """人が読む形に整える。"""
    lines = []
    lines.append("== 世界の主要ソフトウェアシステム ランキング (%s) ==" % result["date"])
    lines.append("")
    lines.append("総合順位は「売上・採用量・求人それぞれの順位の平均」で決めている。")
    lines.append("算出基準の異なる絶対値は足していない。各軸の順位を併記するので、")
    lines.append("総合順位だけでなく、どの軸で強いのかを見て判断すること。")
    lines.append("")

    previous_jobs = {}
    if previous:
        previous_jobs = {r["key"]: r["values"].get("jobs") for r in previous["rows"]}

    header = "総合  システム                          売上(億ドル)  売上位 採用位 求人位 求人件数"
    lines.append(header)
    lines.append("-" * len(header))
    for row in result["rows"]:
        revenue = row["values"]["revenue"]
        revenue_text = ("%.1f" % (revenue * 10)) if revenue is not None else "—"
        if row["is_estimate"]:
            revenue_text += "*"
        jobs = row["values"]["jobs"]
        jobs_text = "—" if jobs is None else str(jobs)
        if previous_jobs and row["key"] in previous_jobs:
            before = previous_jobs[row["key"]]
            if before is not None and jobs is not None:
                diff = jobs - before
                jobs_text += " (%+d)" % diff if diff else " (±0)"
        lines.append("%4d  %-32s %12s %6s %6s %6s %s" % (
            row["overall_rank"],
            row["display_name"][:32],
            revenue_text,
            row["ranks"]["revenue"] or "—",
            row["ranks"]["adoption"] or "—",
            row["ranks"]["jobs"] or "—",
            jobs_text,
        ))

    lines.append("")
    lines.append("* は四半期値からの年換算など、原典に年額の記載が無いもの。")
    lines.append("決算期は企業ごとに異なる(Microsoftは6月期、Oracleは5月期、SAPは12月期)。")
    lines.append("同一期間の厳密な比較ではないため、順位は目安として読むこと。")
    lines.append("")
    lines.append("[求人軸の母数]")
    for name, count in job_counts.items():
        lines.append("  %s: %s件" % (name, count))
    total = sum(v for v in job_counts.values() if isinstance(v, int))
    lines.append("  合計 %d件。いずれもリモート求人に限られ、企業向けソフトの求人需要を" % total)
    lines.append("  代表する母数ではない。求人軸は参考値として扱うこと。")
    lines.append("")
    lines.append("[採用量軸の限界]")
    lines.append("  npm と PyPI の公開統計しか使えないため、Windows・SAP・Adobe のように")
    lines.append("  公開パッケージ統計が存在しないシステムは測定対象外(—)になる。")
    lines.append("  「—」は人気が無いという意味ではなく、この軸では測れないという意味。")
    lines.append("")
    for _name, _url, attribution in JOB_BOARDS:
        lines.append(attribution)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="主要ソフトウェアシステムを売上・採用量・求人でランキングする(都度実行)")
    parser.add_argument("--date", required=True, help="実行日(YYYY-MM-DD)")
    parser.add_argument("--compare", action="store_true",
                        help="前回のスナップショットと比べて求人の増減を出す")
    parser.add_argument("--no-save", action="store_true",
                        help="スナップショットを保存しない")
    args = parser.parse_args()

    registry = load_registry()
    job_texts, job_counts = collect_job_texts()
    result = build(args.date, registry, job_texts)
    previous = load_previous(args.date) if args.compare else None
    if args.compare and previous is None:
        print("注意: 比較できる過去のスナップショットがありません。今回が基準になります。",
              file=sys.stderr)

    print(format_report(result, job_counts, previous))

    if not args.no_save:
        path = save_snapshot(result)
        print("")
        print("スナップショットを保存しました: %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
