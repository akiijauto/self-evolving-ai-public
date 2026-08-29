#!/usr/bin/env python3
"""スキル/MCP自己整理スクリプト(アイデア3)。

`context/skill_usage.jsonl`(scripts/log_skill_usage.py が生成)を集計し、
指定した閾値以下しか使われていないスキル/MCPフォルダを一覧化する。

安全のため既定では dry-run(レポート出力のみ)。実際にフォルダを移動するには
明示的に --apply を付ける必要がある。移動先は削除ではなく
「<skills-dir>/_2軍/」への退避(shutil.move)であり、いつでも元に戻せる。

--skills-dir は必須(このリポジトリ外の実際のスキルディレクトリ、例:
~/.claude/skills を指すことを想定しているため、デフォルト値は持たせない
=誤って何かを動かしてしまう事故を防ぐ)。

使い方:
    # レポートのみ(既定)
    python scripts/skill_triage.py --skills-dir /path/to/skills --threshold 3

    # 実際に2軍フォルダへ移動する
    python scripts/skill_triage.py --skills-dir /path/to/skills --threshold 3 --apply
"""
import argparse
import collections
import json
import pathlib
import shutil
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
USAGE_LOG = ROOT / "context" / "skill_usage.jsonl"
REPORTS_DIR = ROOT / "context" / "reports"
SECOND_TIER_DIRNAME = "_2軍"


def load_usage_counts():
    counts = collections.Counter()
    if not USAGE_LOG.exists():
        return counts
    with USAGE_LOG.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            name = e.get("skill_name")
            if name:
                counts[name] += 1
    return counts


def main():
    parser = argparse.ArgumentParser(description="使用頻度の低いスキル/MCPを棚卸しする")
    parser.add_argument("--skills-dir", required=True, help="対象のスキルディレクトリ(例: ~/.claude/skills)")
    parser.add_argument("--threshold", type=int, default=3, help="この回数未満の使用は2軍候補とする(既定: 3)")
    parser.add_argument("--apply", action="store_true", help="実際に2軍フォルダへ移動する(既定はレポートのみ)")
    parser.add_argument("--date", help="レポートファイル名に使う日付(YYYY-MM-DD)。省略時はレポートを標準出力のみに出す")
    args = parser.parse_args()

    skills_dir = pathlib.Path(args.skills_dir).expanduser()
    if not skills_dir.is_dir():
        print(f"エラー: 指定されたディレクトリが存在しません: {skills_dir}", file=sys.stderr)
        sys.exit(1)

    counts = load_usage_counts()

    candidates = []
    for entry in sorted(skills_dir.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name == SECOND_TIER_DIRNAME or entry.name.startswith("."):
            continue
        used = counts.get(entry.name, 0)
        if used < args.threshold:
            candidates.append((entry, used))

    lines = [f"# スキル/MCP棚卸しレポート", "", f"- 対象ディレクトリ: {skills_dir}", f"- 閾値: {args.threshold}回未満", ""]
    if not candidates:
        lines.append("(閾値未満のスキル/MCPはありませんでした)")
    else:
        lines.append("## 2軍候補")
        lines.append("")
        for entry, used in candidates:
            lines.append(f"- {entry.name} (使用回数: {used})")

    report_text = "\n".join(lines) + "\n"
    print(report_text)

    if args.date:
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        report_path = REPORTS_DIR / f"skill_triage_{args.date}.md"
        report_path.write_text(report_text, encoding="utf-8")
        print(f"レポートを保存しました: {report_path}")

    if not args.apply:
        print("(dry-runモードのため実際の移動は行っていません。移動するには --apply を付けてください)")
        return

    if not candidates:
        return

    second_tier = skills_dir / SECOND_TIER_DIRNAME
    second_tier.mkdir(exist_ok=True)
    for entry, used in candidates:
        dest = second_tier / entry.name
        shutil.move(str(entry), str(dest))
        print(f"移動しました: {entry} -> {dest}")


if __name__ == "__main__":
    main()
