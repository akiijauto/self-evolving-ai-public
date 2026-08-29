#!/usr/bin/env python3
"""判断基準の自動更新ループ(アイデア1)。

context/events.jsonl / context/critic_findings.jsonl と context/reflections/*.md
を読み込み、判断基準の「候補」を context/criteria/PROPOSED.md に書き出す。

このスクリプトは CURRENT.md を直接書き換えない。人間が PROPOSED.md を確認し、
scripts/approve_criteria.py で承認して初めて CURRENT.md に反映される
(=人間承認した差分だけが判断基準へ反映される、という運用ルールをコードで担保する)。

評価役(Critic)が `severity: high` で記録した指摘(fail)は、実行役の自己申告に
頼らない客観的な不備として、決定事項・課題と並ぶ候補材料として扱う。

依存ライブラリなし(標準ライブラリのみ)。週次実行を想定(cron/スケジューラは
Phase 2以降でCron/schedulerに接続する)。
"""
import collections
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
EVENTS_FILE = ROOT / "context" / "events.jsonl"
CRITIC_FINDINGS_FILE = ROOT / "context" / "critic_findings.jsonl"
REFLECTIONS_DIR = ROOT / "context" / "reflections"
PROPOSED_FILE = ROOT / "context" / "criteria" / "PROPOSED.md"

CANDIDATE_TYPES = ("decision", "error", "success", "demand_signal", "demand_alert")


def load_events():
    if not EVENTS_FILE.exists():
        return []
    events = []
    with EVENTS_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def load_reflection_titles():
    if not REFLECTIONS_DIR.exists():
        return []
    return sorted(p.name for p in REFLECTIONS_DIR.glob("*.md"))


def load_critic_findings():
    if not CRITIC_FINDINGS_FILE.exists():
        return []
    findings = []
    with CRITIC_FINDINGS_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                findings.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return findings


def build_proposed(events, reflection_files, critic_findings):
    by_type = collections.defaultdict(list)
    for e in events:
        t = e.get("type", "unknown")
        if t in CANDIDATE_TYPES:
            by_type[t].append(e)

    high_severity_fails = [
        c for c in critic_findings
        if c.get("severity") == "high" and c.get("verdict") == "fail"
    ]

    lines = []
    lines.append("# 判断基準 候補 (PROPOSED)")
    lines.append("")
    lines.append("`scripts/regenerate_criteria.py` が自動生成した候補です。")
    lines.append("内容を確認し、採用するものだけ `scripts/approve_criteria.py` で")
    lines.append("CURRENT.md に反映してください(全自動反映はしない)。")
    lines.append("")
    lines.append(f"- 参照イベント数: {len(events)}")
    lines.append(f"- 参照振り返りファイル数: {len(reflection_files)}")
    lines.append(f"- 参照Critic指摘数(high/fail): {len(high_severity_fails)}")
    lines.append("")

    if not events and not high_severity_fails:
        lines.append("(イベント・Critic指摘がまだ蓄積されていないため、候補はありません)")
    else:
        for t in CANDIDATE_TYPES:
            items = by_type.get(t, [])
            if not items:
                continue
            label = {
                "decision": "決定事項",
                "error": "課題・エラー",
                "success": "成功パターン",
                "demand_signal": "需要データの変化",
                "demand_alert": "需要収集の要確認事項",
            }[t]
            lines.append(f"## {label} ({len(items)}件)")
            lines.append("")
            for e in items[-20:]:  # 直近20件まで(古いものは次回以降のイベントで補強される想定)
                lines.append(f"- [{e.get('date', '不明')} / {e.get('actor', '不明')}] {e.get('summary', '')}")
            lines.append("")

        if high_severity_fails:
            lines.append(f"## 評価役(Critic)の重大な指摘 ({len(high_severity_fails)}件)")
            lines.append("")
            lines.append("実行役の自己申告(decision/error等)とは独立した、客観的な指摘です。")
            lines.append("")
            for c in high_severity_fails[-20:]:
                lines.append(
                    f"- [{c.get('date', '不明')} / {c.get('actor', '不明')}] "
                    f"対象: {c.get('artifact', '不明')} / 指摘: {c.get('finding', '')}"
                )
            lines.append("")

    lines.append("## 承認方法")
    lines.append("")
    lines.append("```")
    lines.append("python scripts/approve_criteria.py")
    lines.append("```")
    lines.append("")
    lines.append("上記コマンドはこのファイルの内容をレビュー用に表示するだけで、")
    lines.append("CURRENT.md への反映は人間が対話的に承認した場合のみ行われます。")
    return "\n".join(lines) + "\n"


def main():
    events = load_events()
    reflection_files = load_reflection_titles()
    critic_findings = load_critic_findings()
    content = build_proposed(events, reflection_files, critic_findings)

    PROPOSED_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROPOSED_FILE.write_text(content, encoding="utf-8")
    print(f"生成しました: {PROPOSED_FILE}")


if __name__ == "__main__":
    main()
