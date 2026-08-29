#!/usr/bin/env python3
"""バックアップ先を再ハッシュし、manifestと突き合わせて復元可能性を検証する(フェーズB)。

「バックアップを取った」ことと「復元できる」ことは別物なので、コピー後に
同期先のファイルを実際に読み直してsha256を照合する。読み取り専用。

終了コード:
    0 = 全件一致(復元可能な状態)
    1 = 欠損または不一致あり

使い方:
    python scripts/backup_verify.py --date 2026-07-31 --dest "G:/マイドライブ/context-backup"
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from backup_manifest import BACKUP_DIR, dest_rel_path, human_size, sha256_of  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def verify(records, dest_root: pathlib.Path):
    results = {"ok": [], "missing": [], "mismatch": [], "no-hash": [], "unreadable": []}
    for r in records:
        if r.get("status") != "included":
            continue
        rel = dest_rel_path(r)
        target = dest_root / rel
        expected = r.get("sha256")

        if not target.is_file():
            results["missing"].append(rel)
            continue
        if not expected:
            results["no-hash"].append(rel)
            continue
        try:
            actual = sha256_of(target)
        except OSError as e:
            results["unreadable"].append(f"{rel} ({e})")
            continue
        if actual == expected:
            results["ok"].append(rel)
        else:
            results["mismatch"].append(rel)
    return results


def build_report(date, dest_root, results, total_bytes):
    healthy = not (results["missing"] or results["mismatch"] or results["unreadable"])
    lines = [
        f"# バックアップ検証レポート ({date})",
        "",
        f"- 同期先: `{dest_root}`",
        f"- 判定: {'**復元可能**(全件一致)' if healthy else '**要対応**(欠損または不一致あり)'}",
        f"- 一致: {len(results['ok'])}件 ({human_size(total_bytes)})",
        f"- 欠損: {len(results['missing'])}件",
        f"- 不一致: {len(results['mismatch'])}件",
        f"- ハッシュ未記録でスキップ: {len(results['no-hash'])}件",
        f"- 読み取り失敗: {len(results['unreadable'])}件",
        "",
    ]
    for key, title, note in [
        ("missing", "欠損しているファイル", "同期先に存在しない。backup_sync.py --apply を実行する。"),
        ("mismatch", "内容が一致しないファイル",
         "コピー後にバックアップ先で編集されたか、破損している。バックアップ先は編集しない運用が前提。"
         "`backup_sync.py` が要確認として報告するので、そちらの判断に従うこと。"),
        ("unreadable", "読み取れなかったファイル",
         "Google Driveがストリーミング設定だとローカルに実体が無く読めない。ミラーリング設定を確認する。"),
    ]:
        if results[key]:
            lines += [f"## {title}", ""]
            for rel in results[key][:50]:
                lines.append(f"- `{rel}`")
            if len(results[key]) > 50:
                lines.append(f"- ... 他 {len(results[key]) - 50}件")
            lines += ["", note, ""]

    lines += [
        "---",
        "",
        "(検証は読み取り専用。ファイルの修正・再コピーは行っていない。)",
    ]
    return "\n".join(lines) + "\n", healthy


def main():
    parser = argparse.ArgumentParser(
        description="バックアップ先を再ハッシュしmanifestと照合する(読み取り専用)")
    parser.add_argument("--date", required=True, help="manifest/レポートのYYYY-MM-DD(自動取得しない)")
    parser.add_argument("--dest", required=True, help="検証するバックアップ先ディレクトリ")
    parser.add_argument("--manifest", help="manifestのパス(既定: context/backup/manifest_<date>.jsonl)")
    parser.add_argument("--out-dir", default=str(BACKUP_DIR), help="レポートの出力先")
    args = parser.parse_args()

    manifest_path = pathlib.Path(args.manifest).expanduser() if args.manifest \
        else BACKUP_DIR / f"manifest_{args.date}.jsonl"
    if not manifest_path.is_file():
        print(f"エラー: manifestが見つかりません: {manifest_path}", file=sys.stderr)
        sys.exit(1)

    dest_root = pathlib.Path(args.dest).expanduser()
    if not dest_root.is_dir():
        print(f"エラー: バックアップ先が見つかりません: {dest_root}", file=sys.stderr)
        sys.exit(1)

    records = []
    with manifest_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    results = verify(records, dest_root)
    total_bytes = sum(r.get("size", 0) for r in records
                      if r.get("status") == "included" and dest_rel_path(r) in set(results["ok"]))
    report, healthy = build_report(args.date, dest_root, results, total_bytes)
    print(report)

    out_dir = pathlib.Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / f"verify_{args.date}.md"
    report_path.write_text(report, encoding="utf-8")
    print(f"レポートを保存しました: {report_path}")

    sys.exit(0 if healthy else 1)


if __name__ == "__main__":
    main()
