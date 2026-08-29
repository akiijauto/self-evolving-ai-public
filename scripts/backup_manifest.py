#!/usr/bin/env python3
"""ローカルPCコンテキストのバックアップ対象を棚卸しし、manifestを生成する(フェーズA)。

重要: このスクリプトは読み取り専用。ファイルのコピー・移動・削除は一切行わない。
実際の同期は後続の backup_sync.py(未実装)が担当する。

設計の詳細は コンテキストバックアップ設計.md を参照。

使い方:
    # 1) まず何がPCにあるかを調べる(推奨候補パスの存在確認だけ)
    python scripts/backup_manifest.py --detect --date 2026-07-31

    # 2) 対象を決めたら走査してmanifestを生成する
    python scripts/backup_manifest.py --date 2026-07-31 \\
        --source "C:/Users/<user>/AI開発" \\
        --source "C:/Users/<user>/.claude/skills=A"

    # 3) 対象パスを設定ファイル(gitignore対象)にまとめる場合
    python scripts/backup_manifest.py --date 2026-07-31 --sources-file context/backup/sources.txt

出力先は既定で context/backup/ 配下(ローカル絶対パスを含むため.gitignore対象)。
"""
import argparse
import fnmatch
import hashlib
import json
import pathlib
import sys
from datetime import datetime, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKUP_DIR = ROOT / "context" / "backup"

DEFAULT_MAX_MB = 50

# --- Tier X: 常に除外する ---------------------------------------------------
# 認証情報。ここに引っかかったファイルはmanifestに「除外した」記録だけ残し、
# 中身は一切読まない(ハッシュも取らない)。
SECRET_FILE_PATTERNS = [
    ".env", ".env.*", "*.key", "*.pem", "*.p12", "*.pfx", "*.keystore",
    "*.jks", "*.ppk", "*.kdbx", "*.kdb",
    "credentials*", "*credential*", "*secret*", "*token*", "*password*",
    "id_rsa*", "id_ed25519*", ".netrc", ".npmrc", ".pypirc",
    ".credentials.json", ".claude.json",  # MCP設定等にAPIキーが入りうる
    # 二段階認証のリカバリコード。名前に secret/token を含まないため個別に指定する
    # (例: Backup-codes-<アカウント名>.txt)
    "backup-code*", "backup_code*", "backupcode*",
    "recovery-code*", "recovery_code*", "recoverycode*",
    "*2fa*", "*mfa*", "authenticator*",
]
# ディレクトリごと除外(認証情報)
SECRET_DIR_NAMES = {".ssh", ".aws", ".gnupg", ".docker", ".kube"}

# 再生成可能なので運ばない
SKIP_DIR_NAMES = {
    ".git", ".svn", ".hg",
    "node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "dist", "build", "out", ".next", ".nuxt",
    "target", ".gradle", ".cache", ".turbo", "Thumbs.db",
}

# セッションログ・キャッシュ類。設定ファイルと同じディレクトリに同居しているため
# ディレクトリ単位の対象指定では拾ってしまう。ファイル数・容量の大半を占める上、
# 会話の中に貼り付けたトークンやパスがそのまま残るため、既定で除外する。
# (残したい場合は --no-default-excludes)
DEFAULT_EXCLUDES = [
    # セッションログ・履歴
    "*/.codex/sessions", "*/.codex/log", "*/.codex/logs", "*/.codex/history.jsonl",
    "*/.claude/projects", "*/.claude/shell-snapshots", "*/.claude/file-history",
    "*/.claude/todos", "*/.claude/statsig", "*/.claude/history.jsonl",
    # プラグイン/マーケットプレイスのキャッシュと実体。マーケットプレイスから
    # 再インストールできるため、手で書いた資産ではない。容量の大半を占める。
    "*/.codex/.tmp", "*/.codex/cache", "*/.codex/plugins", "*/.codex/.sandbox-bin",
    "*/.claude/plugins/cache", "*/.claude/plugins/.tmp",
    "*/.claude/plugins/.plugin-appserver", "*/.claude/plugins/repos",
    "*/bundled-marketplaces",
    # 実行ファイル・モデルデータ。再ダウンロードできる上、コンテキストではない。
    "*.exe", "*.dll", "*.msi", "*.so", "*.dylib", "*.traineddata",
    # ローカルの作業用DB(ログ等)。破損しやすくバックアップの意味も薄い。
    "*.sqlite", "*.sqlite-wal", "*.sqlite-shm", "*.db-wal", "*.db-shm",
]

# 同期先(クラウドストレージのローカルフォルダ)を走査対象に含めると
# コピー済みのものを再度コピー対象として拾ってしまうため、既定で除外する。
CLOUD_DIR_MARKERS = ["マイドライブ", "Google Drive", "GoogleDrive", "OneDrive", "Dropbox", "iCloudDrive"]

# --- Tier判定 ---------------------------------------------------------------
AI_CONFIG_DIR_PARTS = {".claude", ".codex", ".cursor", ".config/claude", "AI開発"}
AI_CONFIG_FILE_NAMES = {
    "claude.md", "agent.md", "agents.md", "settings.json",
    "settings.local.json", "keybindings.json", "skill.md",
}
TEXT_SUFFIXES = {".md", ".txt", ".canvas", ".org", ".rst", ".jsonl", ".yaml", ".yml"}

# --detect で存在確認する推奨候補(Windows想定。ホーム相対で解決する)
DETECT_CANDIDATES = [
    ("AI開発", "A", "CLAUDE.md等のAI設定の正本"),
    (".claude/CLAUDE.md", "A", "ユーザーグローバルの指示ファイル"),
    (".claude/settings.json", "A", "Claude Codeの設定"),
    (".claude/skills", "A", "自作スキル定義"),
    (".claude/commands", "A", "自作スラッシュコマンド"),
    (".claude/agents", "A", "サブエージェント定義"),
    (".claude/plugins", "A", "プラグイン設定"),
    (".claude/projects", "B", "セッション会話ログ(巨大になりがち。要判断)"),
    (".codex", "A", "GPT Codex側の設定"),
    ("AGENTS.md", "A", "ツール非依存の指示ファイル"),
    ("Documents", "B", "ノート・設計メモ"),
    ("Desktop", "C", "作業中ファイル"),
]


def is_secret(path: pathlib.Path) -> bool:
    name = path.name.lower()
    for pat in SECRET_FILE_PATTERNS:
        if fnmatch.fnmatch(name, pat):
            return True
    return False


def in_cloud_dir(path: pathlib.Path) -> bool:
    s = str(path)
    return any(marker in s for marker in CLOUD_DIR_MARKERS)


def guess_tier(path: pathlib.Path) -> str:
    parts_lower = {p.lower() for p in path.parts}
    if any(d.lower() in parts_lower for d in AI_CONFIG_DIR_PARTS):
        return "A"
    if path.name.lower() in AI_CONFIG_FILE_NAMES:
        return "A"
    if path.suffix.lower() in TEXT_SUFFIXES:
        return "B"
    return "C"


INVALID_LABEL_CHARS = '<>:"/\\|?*'


def source_label(source: pathlib.Path) -> str:
    """対象パスを同期先での名前空間に使う短いラベルに変換する。

    複数の対象を同じ同期先に置いたとき、同名の相対パス(例: notes/memo.md)が
    衝突しないよう、対象ごとに1階層挟むために使う。

    対象がファイル単体のときは、そのファイル名をラベルにすると
    `settings.json/settings.json` のような冗長な階層になるため、親ディレクトリ名を使う。
    """
    base = source.parent if source.is_file() else source
    name = base.name or base.anchor.strip("/\\").replace(":", "") or "root"
    for ch in INVALID_LABEL_CHARS:
        name = name.replace(ch, "_")
    return name.strip(". ") or "root"


def dest_rel_path(record) -> str:
    """manifestレコードから同期先での相対パスを組み立てる(sync/verifyで共通)。"""
    source = record.get("source") or "root"
    return f"{source}/{record['rel_path']}"


def sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def matches_any(path: pathlib.Path, patterns) -> bool:
    """パスがfnmatchパターンのいずれかに一致するか。区切りは / に正規化して比較する。"""
    if not patterns:
        return False
    s = path.as_posix()
    return any(fnmatch.fnmatch(s, p) for p in patterns)


def iter_files(root: pathlib.Path, excludes=None):
    """root配下のファイルを列挙する。除外ディレクトリには降りない。

    excludes は絶対パスに対するfnmatchパターン(例: '*/.codex/sessions')。
    一致したディレクトリには降りないため、配下のファイルは列挙自体されない。
    """
    if root.is_file():
        if not matches_any(root, excludes):
            yield root
        return
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except (PermissionError, OSError) as e:
            print(f"  警告: 読み取れないディレクトリをスキップしました: {current} ({e})", file=sys.stderr)
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue  # ループ・想定外の場所への参照を避けるため辿らない
                if entry.is_dir():
                    if entry.name in SKIP_DIR_NAMES or entry.name in SECRET_DIR_NAMES:
                        continue
                    if matches_any(entry, excludes):
                        continue
                    stack.append(entry)
                elif entry.is_file():
                    if matches_any(entry, excludes):
                        continue
                    yield entry
            except OSError:
                continue


def scan_source(source: pathlib.Path, tier_override, max_bytes, date, with_hash, label=None,
                excludes=None):
    """1つの対象パスを走査し、manifestレコードのリストを返す。"""
    records = []
    label = label or source_label(source)
    base = source.parent if source.is_file() else source
    for f in iter_files(source, excludes):
        try:
            rel = f.relative_to(base).as_posix()
        except ValueError:
            rel = f.name

        common = {
            "backup_at": date,
            "source": label,
            "rel_path": rel,
            "src": str(f),
        }

        if is_secret(f):
            records.append({**common, "tier": "X", "status": "excluded", "reason": "secret-pattern"})
            continue

        try:
            stat = f.stat()
        except OSError as e:
            records.append({**common, "tier": "X", "status": "excluded", "reason": f"stat-error: {e}"})
            continue

        if stat.st_size > max_bytes:
            records.append({
                **common, "tier": "X", "status": "excluded",
                "reason": "size-over", "size": stat.st_size,
            })
            continue

        rec = {
            **common,
            "tier": tier_override or guess_tier(f),
            "status": "included",
            "size": stat.st_size,
            "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds"),
            "tags": sorted({p for p in f.parent.parts[-2:] if p}
                           | {t for t in [f.suffix.lstrip(".").lower()] if t}),
        }
        if with_hash:
            try:
                rec["sha256"] = sha256_of(f)
            except OSError as e:
                rec["status"] = "excluded"
                rec["tier"] = "X"
                rec["reason"] = f"read-error: {e}"
        records.append(rec)
    return records


def summarize(records):
    summary = {"included": 0, "excluded": 0, "bytes": 0, "by_tier": {}, "by_reason": {}}
    for r in records:
        if r["status"] == "included":
            summary["included"] += 1
            summary["bytes"] += r.get("size", 0)
            summary["by_tier"][r["tier"]] = summary["by_tier"].get(r["tier"], 0) + 1
        else:
            summary["excluded"] += 1
            reason = r.get("reason", "unknown")
            summary["by_reason"][reason] = summary["by_reason"].get(reason, 0) + 1
    return summary


def human_size(n):
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024


def build_report(date, sources, records, summary, max_bytes, excludes=None):
    lines = [
        f"# バックアップ対象棚卸しレポート ({date})",
        "",
        f"- 走査対象: {len(sources)}件",
        f"- 採用: {summary['included']}件 ({human_size(summary['bytes'])})",
        f"- 除外: {summary['excluded']}件",
        f"- サイズ上限: {human_size(max_bytes)}",
        "",
        "## 走査した対象パス",
        "",
    ]
    for s in sources:
        lines.append(f"- `{s}`")
    if excludes:
        lines += ["", "## 適用した除外パターン", "",
                  "以下に一致するディレクトリ/ファイルは走査自体していないため、"
                  "上の「除外の内訳」には現れない。", ""]
        for pat in excludes:
            lines.append(f"- `{pat}`")

    lines += ["", "## Tier別の内訳", ""]
    for tier in sorted(summary["by_tier"]):
        lines.append(f"- Tier {tier}: {summary['by_tier'][tier]}件")
    if summary["by_reason"]:
        lines += ["", "## 除外の内訳", ""]
        for reason, count in sorted(summary["by_reason"].items(), key=lambda x: -x[1]):
            lines.append(f"- {reason}: {count}件")
        secret_count = summary["by_reason"].get("secret-pattern", 0)
        lines += [
            "",
            f"認証情報らしきファイル {secret_count}件 は中身を一切読まずに除外している"
            "(ハッシュも計算していない)。",
        ]
    lines += [
        "",
        "## 容量上位20件",
        "",
    ]
    top = sorted([r for r in records if r["status"] == "included"],
                 key=lambda r: r.get("size", 0), reverse=True)[:20]
    for r in top:
        lines.append(f"- {human_size(r.get('size', 0))}  `{r['rel_path']}` (Tier {r['tier']})")
    lines += [
        "",
        "---",
        "",
        "(このレポートは読み取り専用の棚卸しです。ファイルのコピー・移動・削除は"
        "一切行っていません。実際の同期は backup_sync.py が担当します。)",
    ]
    return "\n".join(lines) + "\n"


def run_detect(date, max_bytes, excludes=None):
    """推奨候補パスの存在と規模だけを調べる(ハッシュは取らない)。"""
    home = pathlib.Path.home()
    lines = [
        f"# バックアップ候補パスの検出結果 ({date})",
        "",
        f"- ホームディレクトリ: `{home}`",
        "",
        "| 候補パス | Tier | 状態 | ファイル数 | 合計サイズ | 用途 |",
        "|---|---|---|---|---|---|",
    ]
    found = []
    for rel, tier, note in DETECT_CANDIDATES:
        target = home / rel
        if not target.exists():
            lines.append(f"| `{rel}` | {tier} | なし | - | - | {note} |")
            continue
        count = 0
        total = 0
        for f in iter_files(target, excludes):
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
        found.append((rel, tier, count, total))
        lines.append(f"| `{rel}` | {tier} | あり | {count} | {human_size(total)} | {note} |")

    lines += ["", "## クラウド同期フォルダの検出", ""]
    cloud_found = False
    try:
        home_entries = sorted(home.iterdir()) if home.exists() else []
    except OSError:
        home_entries = []
    for entry in home_entries:
        if entry.is_dir() and any(m in entry.name for m in CLOUD_DIR_MARKERS):
            lines.append(f"- `{entry}` (同期先候補。走査対象には含めない)")
            cloud_found = True
    if not cloud_found:
        lines.append("- ホーム直下では見つからなかった(Google Drive for desktopは既定で "
                     "`G:` 等のドライブとしてマウントされる。バックアップ用途では"
                     "「ミラーリング」設定にしてローカルに実体を置くこと)。")

    lines += [
        "",
        "## 次のステップ",
        "",
        "上の表で「あり」かつ内容を確認したパスを `--source` に指定して、",
        "manifest生成(ハッシュ計算あり)を実行する。",
        "",
        "---",
        "",
        "(検出は読み取り専用。ファイルの内容は読んでいない=サイズと件数のみ集計。)",
    ]
    return "\n".join(lines) + "\n"


def parse_source(spec):
    """'PATH' または 'PATH=TIER' を (pathlib.Path, tier or None) に分解する。"""
    tier = None
    if "=" in spec:
        head, tail = spec.rsplit("=", 1)
        if tail.strip().upper() in {"A", "B", "C"}:
            spec, tier = head, tail.strip().upper()
    return pathlib.Path(spec).expanduser(), tier


def main():
    parser = argparse.ArgumentParser(
        description="ローカルPCのバックアップ対象を棚卸ししmanifestを生成する(読み取り専用。コピーはしない)")
    parser.add_argument("--date", required=True, help="出力ファイル名に使うYYYY-MM-DD(自動取得しない)")
    parser.add_argument("--source", action="append", default=[],
                        help="走査対象パス。'PATH' または 'PATH=TIER'(TIERはA/B/C)。複数指定可")
    parser.add_argument("--sources-file", help="1行1パスの対象一覧ファイル(#始まりはコメント)")
    parser.add_argument("--detect", action="store_true",
                        help="推奨候補パスの存在と規模だけを調べる(manifestは作らない)")
    parser.add_argument("--max-size-mb", type=float, default=DEFAULT_MAX_MB,
                        help=f"この値を超えるファイルは除外する(既定: {DEFAULT_MAX_MB}MB)")
    parser.add_argument("--no-hash", action="store_true", help="sha256の計算を省略する(高速確認用)")
    parser.add_argument("--exclude", action="append", default=[],
                        help="除外するパスのパターン(fnmatch、例: '*/.codex/sessions')。複数指定可")
    parser.add_argument("--no-default-excludes", action="store_true",
                        help="セッションログ等の既定除外を無効にする")
    parser.add_argument("--out-dir", default=str(BACKUP_DIR),
                        help="出力先ディレクトリ(既定: context/backup/。ローカル絶対パスを含むためgit管理外)")
    args = parser.parse_args()

    max_bytes = int(args.max_size_mb * 1024 * 1024)
    out_dir = pathlib.Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    excludes = list(args.exclude)
    if not args.no_default_excludes:
        excludes += DEFAULT_EXCLUDES
    if excludes:
        print(f"除外パターン: {len(excludes)}件 "
              f"({'既定+' if not args.no_default_excludes else ''}指定 {len(args.exclude)}件)")

    if args.detect:
        report = run_detect(args.date, max_bytes, excludes)
        print(report)
        report_path = out_dir / f"detect_{args.date}.md"
        report_path.write_text(report, encoding="utf-8")
        print(f"検出結果を保存しました: {report_path}")
        return

    specs = list(args.source)
    if args.sources_file:
        sf = pathlib.Path(args.sources_file).expanduser()
        if not sf.is_file():
            print(f"エラー: 対象一覧ファイルが見つかりません: {sf}", file=sys.stderr)
            sys.exit(1)
        for line in sf.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                specs.append(line)

    if not specs:
        print("エラー: --source か --sources-file で対象を指定してください"
              "(候補を調べるには --detect)", file=sys.stderr)
        sys.exit(1)

    all_records = []
    scanned = []
    used_labels = {}
    for spec in specs:
        source, tier = parse_source(spec)
        if not source.exists():
            print(f"警告: 存在しないためスキップします: {source}", file=sys.stderr)
            continue
        if in_cloud_dir(source):
            print(f"警告: クラウド同期フォルダ配下のためスキップします(二重コピー防止): {source}",
                  file=sys.stderr)
            continue

        label = source_label(source)
        if label in used_labels:
            used_labels[label] += 1
            label = f"{label}_{used_labels[label]}"
            print(f"注意: ラベルが重複したため '{label}' として区別します: {source}")
        else:
            used_labels[label] = 1

        print(f"走査中: {source} (ラベル: {label})")
        all_records.extend(
            scan_source(source, tier, max_bytes, args.date, not args.no_hash, label=label,
                        excludes=excludes))
        scanned.append(source)

    if not scanned:
        print("エラー: 走査できる対象がありませんでした", file=sys.stderr)
        sys.exit(1)

    summary = summarize(all_records)

    manifest_path = out_dir / f"manifest_{args.date}.jsonl"
    with manifest_path.open("w", encoding="utf-8") as f:
        for r in all_records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    report = build_report(args.date, scanned, all_records, summary, max_bytes, excludes)
    print()
    print(report)
    report_path = out_dir / f"manifest_report_{args.date}.md"
    report_path.write_text(report, encoding="utf-8")
    print(f"manifestを保存しました: {manifest_path}")
    print(f"レポートを保存しました: {report_path}")


if __name__ == "__main__":
    main()
