#!/usr/bin/env python3
"""振り返り自動生成の拡張(アイデア2)。

context/events.jsonl / context/critic_findings.jsonl から指定日の記録を集計し、
context/reflections/YYYY-MM-DD.md を自動生成(既存があれば末尾に追記)する。
error イベントおよび評価役(Critic)のfail指摘は「課題」、同日以降の success
イベントは「対策」の手がかりとして突き合わせる(完全一致ではなく参考情報として
併記する程度の軽量な実装)。

また、生成された reflections ファイルが5の倍数に達するたびに、
5回ごとの見直しルール(運用ルールのCLAUDE.mdに記載)と連動して
context/reflections/_review/REVIEW_<n>.md に「直近5件の振り返り一覧」を作成する
(内容の自動要約はしない。人間 or 別途AIが目を通すための一覧を作るだけ)。

依存ライブラリなし(標準ライブラリのみ)。
"""
import argparse
import json
import pathlib
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
EVENTS_FILE = ROOT / "context" / "events.jsonl"
CRITIC_FINDINGS_FILE = ROOT / "context" / "critic_findings.jsonl"
REFLECTIONS_DIR = ROOT / "context" / "reflections"
REVIEW_DIR = REFLECTIONS_DIR / "_review"


def load_events_for_date(date: str):
    if not EVENTS_FILE.exists():
        return []
    events = []
    with EVENTS_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("date") == date:
                events.append(e)
    return events


def load_events_up_to(date: str):
    """対策の手がかり探索用に、指定日以降(当日含む)のsuccessイベントも見る"""
    if not EVENTS_FILE.exists():
        return []
    events = []
    with EVENTS_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("date", "") >= date:
                events.append(e)
    return events


def load_critic_findings_for_date(date: str):
    if not CRITIC_FINDINGS_FILE.exists():
        return []
    findings = []
    with CRITIC_FINDINGS_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                c = json.loads(line)
            except json.JSONDecodeError:
                continue
            if c.get("date") == date:
                findings.append(c)
    return findings


def build_section(events, types):
    items = [e for e in events if e.get("type") in types]
    if not items:
        return None
    return items


def build_reflection_markdown(date, events, followup_success, critic_findings):
    lines = [f"# 振り返り {date} (自動生成)", ""]

    milestones_decisions = build_section(events, ("milestone", "decision"))
    lines.append("## 今日やったこと")
    lines.append("")
    if milestones_decisions:
        for e in milestones_decisions:
            lines.append(f"- [{e.get('actor', '不明')}] {e.get('summary', '')}")
    else:
        lines.append("(該当イベントなし)")
    lines.append("")

    demand_events = build_section(events, ("demand_signal", "demand_alert"))
    lines.append("## 需要データの変化")
    lines.append("")
    if demand_events:
        for e in demand_events:
            label = "要確認" if e.get("type") == "demand_alert" else "変化"
            lines.append(f"- {label}: {e.get('summary', '')}")
    else:
        lines.append("(該当イベントなし)")
    lines.append("")

    errors = build_section(events, ("error",))
    demand_alerts = build_section(events, ("demand_alert",))
    critic_fails = [c for c in critic_findings if c.get("verdict") == "fail"]
    lines.append("## 発生した課題と対策")
    lines.append("")
    if errors or demand_alerts or critic_fails:
        for e in errors or []:
            lines.append(f"- 課題: [{e.get('actor', '不明')}] {e.get('summary', '')}")
        for e in demand_alerts or []:
            lines.append(f"- 課題(需要収集): {e.get('summary', '')}")
        for c in critic_fails:
            lines.append(
                f"- 課題(評価役指摘・{c.get('severity', '不明')}): "
                f"[{c.get('actor', '不明')}] 対象: {c.get('artifact', '不明')} / {c.get('finding', '')}"
            )
        if followup_success:
            lines.append("")
            lines.append("  (参考: 同日以降に記録された success イベント。対策の手がかりとして併記。"
                          "自動での対応付けはしていないため、実際の対応関係は要確認)")
            for e in followup_success[:5]:
                lines.append(f"  - success候補: [{e.get('date')} / {e.get('actor', '不明')}] {e.get('summary', '')}")
    else:
        lines.append("(該当イベントなし)")
    lines.append("")

    todos = build_section(events, ("todo",))
    lines.append("## 次回に向けて")
    lines.append("")
    if todos:
        for e in todos:
            lines.append(f"- {e.get('summary', '')}")
    else:
        lines.append("(該当イベントなし)")
    lines.append("")

    return "\n".join(lines)


def count_reflection_files():
    if not REFLECTIONS_DIR.exists():
        return 0
    return len([p for p in REFLECTIONS_DIR.glob("*.md") if p.is_file()])


def maybe_write_review(n):
    if n == 0 or n % 5 != 0:
        return None
    files = sorted(
        [p for p in REFLECTIONS_DIR.glob("*.md") if p.is_file()],
        key=lambda p: p.name,
    )
    recent = files[-5:]
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    review_path = REVIEW_DIR / f"REVIEW_{n}.md"
    lines = [
        f"# 5回ごとの見直し (通算{n}件目)",
        "",
        "以下の直近5件の振り返りをまとめて見直してください"
        "(CLAUDE.mdの「5回ごとに全体を見直し」ルールと連動)。",
        "",
    ]
    for p in recent:
        lines.append(f"- [{p.name}](../{p.name})")
    review_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return review_path


def main():
    parser = argparse.ArgumentParser(description="指定日のイベントから振り返りを自動生成する")
    parser.add_argument("--date", required=True, help="YYYY-MM-DD形式")
    parser.add_argument("--force", action="store_true", help="既存ファイルがあっても上書きする")
    args = parser.parse_args()

    events = load_events_for_date(args.date)
    followup = [e for e in load_events_up_to(args.date) if e.get("type") == "success" and e.get("date") != args.date]
    critic_findings = load_critic_findings_for_date(args.date)

    REFLECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = REFLECTIONS_DIR / f"{args.date}.md"

    content = build_reflection_markdown(args.date, events, followup, critic_findings)

    if out_path.exists() and not args.force:
        with out_path.open("a", encoding="utf-8") as f:
            f.write("\n---\n\n" + content)
        print(f"追記しました(既存ファイルあり): {out_path}")
    else:
        out_path.write_text(content, encoding="utf-8")
        print(f"生成しました: {out_path}")

    n = count_reflection_files()
    review_path = maybe_write_review(n)
    if review_path:
        print(f"5回ごとの見直しファイルを生成しました: {review_path}")


if __name__ == "__main__":
    main()
