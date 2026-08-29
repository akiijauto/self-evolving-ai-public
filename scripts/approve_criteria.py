#!/usr/bin/env python3
"""判断基準のバージョン管理(アイデア6)+ 承認フロー(アイデア1の後半)。

PROPOSED.md の内容を人間に提示し、承認された場合のみ CURRENT.md を更新する。
更新前の CURRENT.md は context/criteria/history/ にタイムスタンプ付きで保存し、
CURRENT.md の更新履歴セクションにも1行追記する。バージョン管理そのものはgit
コミット(このリポジトリ全体)に委ねる想定。

--yes を付けると非対話的に承認する(スケジューラ/CI経由での実行を想定。
その場合も history/ への退避とCURRENT.mdの更新履歴追記は必ず行われるため、
「いつ・何が反映されたか」はgit diffで追跡できる)。
"""
import argparse
import datetime
import pathlib
import shutil
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parent.parent
CRITERIA_DIR = ROOT / "context" / "criteria"
CURRENT_FILE = CRITERIA_DIR / "CURRENT.md"
PROPOSED_FILE = CRITERIA_DIR / "PROPOSED.md"
HISTORY_DIR = CRITERIA_DIR / "history"


def main():
    parser = argparse.ArgumentParser(description="PROPOSED.md をレビューし、承認したらCURRENT.mdへ反映する")
    parser.add_argument("--yes", action="store_true", help="確認プロンプトなしで承認する(スケジューラ実行向け)")
    args = parser.parse_args()

    if not PROPOSED_FILE.exists():
        print("PROPOSED.md がありません。先に scripts/regenerate_criteria.py を実行してください。", file=sys.stderr)
        sys.exit(1)

    proposed_text = PROPOSED_FILE.read_text(encoding="utf-8")
    print("=" * 60)
    print(proposed_text)
    print("=" * 60)

    if not args.yes:
        answer = input("この内容をCURRENT.mdに反映しますか? [y/N]: ").strip().lower()
        if answer != "y":
            print("反映を中止しました。CURRENT.mdは変更していません。")
            return

    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    if CURRENT_FILE.exists():
        backup_path = HISTORY_DIR / f"CURRENT_{timestamp}.md"
        shutil.copy2(CURRENT_FILE, backup_path)
        print(f"旧バージョンを退避しました: {backup_path}")

    today = datetime.date.today().isoformat()
    new_content = proposed_text.replace("# 判断基準 候補 (PROPOSED)", "# 判断基準 (CURRENT)")
    new_content += f"\n## 更新履歴\n\n- {today}: PROPOSED.mdの内容を承認して反映\n"

    CURRENT_FILE.write_text(new_content, encoding="utf-8")
    print(f"反映しました: {CURRENT_FILE}")
    print("git commit でこの変更を記録してください(バージョン管理はgit履歴に委ねています)。")


if __name__ == "__main__":
    main()
