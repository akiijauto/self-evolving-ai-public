#!/usr/bin/env python3
"""バックアップ一式を1コマンドで実行する(棚卸し → 同期 → 検証)。

対象パスとバックアップ先を自動検出するため、通常は日付を渡すだけでよい。
個別に制御したいときは backup_manifest.py / backup_sync.py / backup_verify.py を
直接呼ぶこと(このスクリプトはそれらを順に呼び出しているだけ)。

使い方:
    # 1) まず確認(何も書き込まない)
    python scripts/backup_run.py --date 2026-08-02

    # 2) 内容に納得したら実行
    python scripts/backup_run.py --date 2026-08-02 --apply

正本はローカルPC側。バックアップ先は複製であり、編集しない。
"""
import argparse
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from backup_manifest import (  # noqa: E402
    BACKUP_DIR, DEFAULT_EXCLUDES, DETECT_CANDIDATES, human_size, iter_files, is_secret,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

SCRIPTS = pathlib.Path(__file__).resolve().parent

# Google Drive for desktop のローカル実体の置き場所。
# ミラーリング設定ではユーザープロファイル配下に、ストリーミング設定では
# 仮想ドライブ(既定G:)に現れる。バックアップにはミラーリングが必要。
DRIVE_ROOT_NAMES = ["My Drive", "マイドライブ", "Google Drive"]
DRIVE_LETTERS = ["G:", "H:", "I:"]

# 既定の対象。--detect で「あり」と判定されたものだけを実際の対象にする。
DEFAULT_TIERS = {rel: tier for rel, tier, _ in DETECT_CANDIDATES}
# セッションログは巨大かつ秘密情報が残りやすいため、既定では対象にしない
SKIP_BY_DEFAULT = {".claude/projects", "Desktop", "Documents"}


def find_drive_root():
    """Google Driveのローカル実体のルートを探す。(パス, ミラーリングらしいか) を返す。"""
    home = pathlib.Path.home()
    for name in DRIVE_ROOT_NAMES:
        candidate = home / name
        if candidate.is_dir():
            return candidate, True  # プロファイル配下 = ミラーリング設定
    for letter in DRIVE_LETTERS:
        for name in DRIVE_ROOT_NAMES:
            candidate = pathlib.Path(f"{letter}/{name}")
            try:
                if candidate.is_dir():
                    return candidate, False  # 仮想ドライブ = ストリーミングの疑い
            except OSError:
                continue
    return None, False


def pick_sources(extra_sources, include_all):
    """存在する候補パスから対象を組み立てる。"""
    home = pathlib.Path.home()
    picked = []
    skipped = []
    for rel, tier, note in DETECT_CANDIDATES:
        target = home / rel
        if not target.exists():
            continue
        if rel in SKIP_BY_DEFAULT and not include_all:
            skipped.append((rel, note))
            continue
        picked.append((target, tier, note))
    for spec in extra_sources:
        path = pathlib.Path(spec.split("=")[0]).expanduser()
        if path.exists():
            picked.append((path, spec.split("=")[1] if "=" in spec else None, "手動指定"))
        else:
            print(f"警告: 指定されたパスが存在しません: {path}", file=sys.stderr)
    return picked, skipped


def measure(path, max_bytes, excludes=None):
    count = 0
    total = 0
    for f in iter_files(path, excludes):
        if is_secret(f):
            continue
        try:
            size = f.stat().st_size
        except OSError:
            continue
        if size > max_bytes:
            continue
        count += 1
        total += size
    return count, total


def run(cmd):
    print(f"\n$ {' '.join(str(c) for c in cmd)}\n")
    return subprocess.run([sys.executable] + [str(c) for c in cmd]).returncode


def main():
    parser = argparse.ArgumentParser(
        description="棚卸し → 同期 → 検証 を順に実行する(既定は書き込みなしの確認のみ)")
    parser.add_argument("--date", required=True, help="YYYY-MM-DD(自動取得しない)")
    parser.add_argument("--dest", help="バックアップ先。省略時はGoogle Driveのローカル実体から自動決定")
    parser.add_argument("--dest-subdir", default="AI開発/context-backup",
                        help="Driveルートからの相対パス(既定: AI開発/context-backup)")
    parser.add_argument("--source", action="append", default=[],
                        help="対象パスを追加する。'PATH' または 'PATH=TIER'")
    parser.add_argument("--include-all", action="store_true",
                        help="既定で除外している候補(セッションログ等)も対象にする")
    parser.add_argument("--apply", action="store_true", help="実際にコピーする")
    parser.add_argument("--force-overwrite", action="store_true",
                        help="バックアップ先が編集されていても正本で上書きする")
    parser.add_argument("--exclude", action="append", default=[],
                        help="除外するパスのパターン(fnmatch)。複数指定可")
    parser.add_argument("--no-default-excludes", action="store_true",
                        help="セッションログ等の既定除外を無効にする")
    parser.add_argument("--max-size-mb", type=float, default=50.0)
    args = parser.parse_args()

    max_bytes = int(args.max_size_mb * 1024 * 1024)
    excludes = list(args.exclude) + ([] if args.no_default_excludes else DEFAULT_EXCLUDES)

    print("=" * 60)
    print("1. バックアップ対象の確認")
    print("=" * 60)
    picked, skipped = pick_sources(args.source, args.include_all)
    if not picked:
        print("エラー: バックアップ対象が1つも見つかりませんでした。", file=sys.stderr)
        print("      --source で明示的に指定してください。", file=sys.stderr)
        sys.exit(1)
    for path, tier, note in picked:
        count, total = measure(path, max_bytes, excludes)
        tier_label = f"Tier {tier}" if tier else "Tier 自動判定"
        print(f"  [対象] {path}  ({count}件 / {human_size(total)} / {tier_label})  - {note}")
    if skipped:
        print("\n  既定で対象外にしたもの(--include-all で含められる):")
        for rel, note in skipped:
            print(f"  [除外] ~/{rel}  - {note}")

    print()
    print("=" * 60)
    print("2. バックアップ先の確認")
    print("=" * 60)
    if args.dest:
        dest = pathlib.Path(args.dest).expanduser()
        mirrored = True
    else:
        drive_root, mirrored = find_drive_root()
        if drive_root is None:
            print("エラー: Google Driveのローカルフォルダが見つかりませんでした。", file=sys.stderr)
            print(file=sys.stderr)
            print("  考えられる原因と対処:", file=sys.stderr)
            print("  1. Google Drive for desktop が未インストール", file=sys.stderr)
            print("     → https://www.google.com/drive/download/ からインストールし、", file=sys.stderr)
            print("       セットアップ時に「マイドライブをミラーリングする」を選ぶ", file=sys.stderr)
            print("  2. インストール済みだがストリーミング設定", file=sys.stderr)
            print("     → 設定 → Google ドライブ → ミラーリングに変更する", file=sys.stderr)
            print(file=sys.stderr)
            print("  暫定運用: 別ドライブや外付けディスクを保存先にして先にバックアップを取れる。", file=sys.stderr)
            print('     python scripts/backup_run.py --date <日付> --dest "D:/context-backup"',
                  file=sys.stderr)
            print("     (同一PC内だと故障時に一緒に失われるため、外付けや別ドライブを推奨)",
                  file=sys.stderr)
            sys.exit(1)
        dest = drive_root / args.dest_subdir
        print(f"  Driveのローカル実体: {drive_root}")
    print(f"  バックアップ先: {dest}")

    if not mirrored:
        print()
        print("  警告: 仮想ドライブ上のパスを検出しました。ストリーミング設定の可能性が高く、", file=sys.stderr)
        print("        その場合ローカルにファイルの実体が無いためバックアップとして機能しません。", file=sys.stderr)
        print("        Google Drive for desktop の設定でミラーリングに変更してください。", file=sys.stderr)

    if not dest.parent.exists():
        print(f"\n  注意: 親フォルダがまだ存在しません: {dest.parent}")
        print(f"        Drive側でフォルダが同期されるのを待つか、手動で作成してください。")

    print()
    print("=" * 60)
    print("3. 棚卸し(manifest生成)")
    print("=" * 60)
    manifest_cmd = [SCRIPTS / "backup_manifest.py", "--date", args.date,
                    "--max-size-mb", args.max_size_mb]
    for pattern in args.exclude:
        manifest_cmd += ["--exclude", pattern]
    if args.no_default_excludes:
        manifest_cmd.append("--no-default-excludes")
    for path, tier, _ in picked:
        manifest_cmd += ["--source", f"{path}={tier}" if tier else str(path)]
    if run(manifest_cmd) != 0:
        print("棚卸しに失敗しました。中断します。", file=sys.stderr)
        sys.exit(1)

    print()
    print("=" * 60)
    print(f"4. 同期({'実行' if args.apply else 'dry-run: 書き込みなし'})")
    print("=" * 60)
    sync_cmd = [SCRIPTS / "backup_sync.py", "--date", args.date, "--dest", dest]
    if args.apply:
        sync_cmd.append("--apply")
    if args.force_overwrite:
        sync_cmd.append("--force-overwrite")
    sync_rc = run(sync_cmd)

    if not args.apply:
        print()
        print("=" * 60)
        print("確認は以上です。実際にバックアップするには --apply を付けて再実行してください:")
        print(f"  python scripts/backup_run.py --date {args.date} --apply")
        print("=" * 60)
        sys.exit(sync_rc)

    if sync_rc != 0:
        print("\n同期で要確認・失敗がありました。上の内容を確認してください。", file=sys.stderr)

    print()
    print("=" * 60)
    print("5. 検証(本当に復元できる状態かハッシュ照合)")
    print("=" * 60)
    verify_rc = run([SCRIPTS / "backup_verify.py", "--date", args.date, "--dest", dest])

    print()
    if verify_rc == 0 and sync_rc == 0:
        print("完了: バックアップは復元可能な状態です。")
        print(f"レポート: {BACKUP_DIR}")
    else:
        print("要対応: 上のレポートを確認してください。", file=sys.stderr)
    sys.exit(max(sync_rc, verify_rc))


if __name__ == "__main__":
    main()
