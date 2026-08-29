#!/usr/bin/env python3
"""バックアップから復元する(フェーズD)。

「バックアップが取れている」ことと「復元できる」ことは別物なので、復元経路も
スクリプトとして用意し、実際に動かして確かめられるようにする。

安全設計:
- 既定はdry-run。実際に書き出すには --apply が必要。
- **正本の場所へは直接書き戻さない**。復元先ディレクトリを別途指定させ、
  そこへ展開する。正本を上書きするかどうかは中身を見た人間が判断する
  (`backup_sync.py` が一方向なのと同じ理由。自動で逆流させない)。
- 復元先に既存ファイルがある場合は上書きせずスキップする(--overwrite で上書き)。
- 復元後にsha256を照合し、manifestと一致するか確認する。

使い方:
    # 何が復元されるか確認(書き込みなし)
    python scripts/backup_restore.py --date 2026-08-03 \\
        --dest "C:/context-backup" --to "C:/restore-test"

    # 実行
    python scripts/backup_restore.py --date 2026-08-03 \\
        --dest "C:/context-backup" --to "C:/restore-test" --apply

    # 一部だけ復元する(ラベル単位)
    python scripts/backup_restore.py --date 2026-08-03 \\
        --dest "C:/context-backup" --to "C:/restore-test" --only AI開発 --apply
"""
import argparse
import json
import pathlib
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from backup_manifest import BACKUP_DIR, dest_rel_path, human_size, sha256_of  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def load_manifest(path: pathlib.Path):
    records = []
    with path.open(encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"エラー: manifestの{i}行目が壊れています: {e}", file=sys.stderr)
                sys.exit(1)
    return records


def plan(records, backup_root: pathlib.Path, restore_root: pathlib.Path, only, overwrite):
    actions = []
    for r in records:
        if r.get("status") != "included":
            continue
        if only and r.get("source") not in only:
            continue
        rel = dest_rel_path(r)
        src = backup_root / rel
        target = restore_root / rel

        if not src.is_file():
            actions.append({"rel": rel, "src": src, "target": target,
                            "action": "missing-in-backup", "record": r})
            continue
        if target.exists() and not overwrite:
            actions.append({"rel": rel, "src": src, "target": target,
                            "action": "skip-existing", "record": r})
            continue
        actions.append({"rel": rel, "src": src, "target": target,
                        "action": "restore", "record": r})
    return actions


def build_report(date, backup_root, restore_root, actions, counts, restored_bytes, applied,
                 verify_result):
    mode = "実行(--apply)" if applied else "dry-run(既定)"
    lines = [
        f"# バックアップ復元レポート ({date})",
        "",
        f"- モード: {mode}",
        f"- 復元元(バックアップ): `{backup_root}`",
        f"- 復元先: `{restore_root}`",
        f"- 復元: {counts.get('restore', 0)}件 ({human_size(restored_bytes)})",
        f"- 既存のためスキップ: {counts.get('skip-existing', 0)}件",
        f"- バックアップに存在しない: {counts.get('missing-in-backup', 0)}件",
        f"- 復元失敗: {counts.get('restore-failed', 0)}件",
        "",
    ]

    missing = [a for a in actions if a["action"] == "missing-in-backup"]
    if missing:
        lines += ["## バックアップに存在しないファイル", "",
                  "manifestには記録されているが、バックアップ先に見つからなかった。",
                  "バックアップが不完全な可能性がある。", ""]
        for a in missing[:30]:
            lines.append(f"- `{a['rel']}`")
        if len(missing) > 30:
            lines.append(f"- ... 他 {len(missing) - 30}件")
        lines.append("")

    if verify_result is not None:
        ok, mismatch, unreadable = verify_result
        healthy = not (mismatch or unreadable)
        lines += [
            "## 復元後の検証(sha256照合)",
            "",
            f"- 判定: {'**復元成功**(全件一致)' if healthy else '**要対応**(不一致あり)'}",
            f"- 一致: {len(ok)}件",
            f"- 不一致: {len(mismatch)}件",
            f"- 読み取り失敗: {len(unreadable)}件",
            "",
        ]
        for rel in mismatch[:20]:
            lines.append(f"- 不一致: `{rel}`")
        for item in unreadable[:20]:
            lines.append(f"- 読み取り失敗: `{item}`")
        if mismatch or unreadable:
            lines.append("")

    lines += [
        "---",
        "",
        "(復元先へ展開しただけで、正本の場所へは書き戻していない。"
        "正本を置き換えるかどうかは中身を確認した上で人間が判断すること。)",
    ]
    return "\n".join(lines) + "\n"


def verify_restored(actions, records_by_rel):
    ok, mismatch, unreadable = [], [], []
    for a in actions:
        if a["action"] != "restore":
            continue
        expected = records_by_rel.get(a["rel"], {}).get("sha256")
        if not expected:
            continue
        try:
            actual = sha256_of(a["target"])
        except OSError as e:
            unreadable.append(f"{a['rel']} ({e})")
            continue
        (ok if actual == expected else mismatch).append(a["rel"])
    return ok, mismatch, unreadable


def main():
    parser = argparse.ArgumentParser(
        description="バックアップから復元する(既定dry-run。正本へは書き戻さない)")
    parser.add_argument("--date", required=True, help="manifest/レポートのYYYY-MM-DD(自動取得しない)")
    parser.add_argument("--dest", required=True, help="復元元のバックアップ先ディレクトリ")
    parser.add_argument("--to", required=True, help="復元先ディレクトリ(正本とは別の場所を指定する)")
    parser.add_argument("--manifest", help="manifestのパス(既定: context/backup/manifest_<date>.jsonl)")
    parser.add_argument("--only", action="append", default=[],
                        help="復元する対象ラベル(例: AI開発)。複数指定可。省略時は全部")
    parser.add_argument("--apply", action="store_true", help="実際に書き出す")
    parser.add_argument("--overwrite", action="store_true",
                        help="復元先に既存ファイルがあっても上書きする")
    parser.add_argument("--out-dir", default=str(BACKUP_DIR), help="レポートの出力先")
    args = parser.parse_args()

    manifest_path = pathlib.Path(args.manifest).expanduser() if args.manifest \
        else BACKUP_DIR / f"manifest_{args.date}.jsonl"
    if not manifest_path.is_file():
        print(f"エラー: manifestが見つかりません: {manifest_path}", file=sys.stderr)
        sys.exit(1)

    backup_root = pathlib.Path(args.dest).expanduser()
    restore_root = pathlib.Path(args.to).expanduser()
    if not backup_root.is_dir():
        print(f"エラー: 復元元が見つかりません: {backup_root}", file=sys.stderr)
        sys.exit(1)

    try:
        if restore_root.resolve() == backup_root.resolve():
            print("エラー: 復元先と復元元が同じです。別のディレクトリを指定してください。",
                  file=sys.stderr)
            sys.exit(1)
    except OSError:
        pass

    records = load_manifest(manifest_path)
    only = set(args.only)
    if only:
        labels = {r.get("source") for r in records if r.get("status") == "included"}
        unknown = only - labels
        if unknown:
            print(f"エラー: 存在しないラベルです: {', '.join(sorted(unknown))}", file=sys.stderr)
            print(f"      指定できるラベル: {', '.join(sorted(l for l in labels if l))}",
                  file=sys.stderr)
            sys.exit(1)

    actions = plan(records, backup_root, restore_root, only, args.overwrite)
    if not actions:
        print("復元対象がありませんでした。", file=sys.stderr)
        sys.exit(1)

    counts = {}
    for a in actions:
        counts[a["action"]] = counts.get(a["action"], 0) + 1

    restored_bytes = 0
    verify_result = None
    if args.apply:
        for a in actions:
            if a["action"] != "restore":
                continue
            try:
                a["target"].parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(a["src"], a["target"])
                restored_bytes += a["record"].get("size", 0)
            except OSError as e:
                print(f"警告: 復元に失敗しました: {a['src']} -> {a['target']} ({e})",
                      file=sys.stderr)
                a["action"] = "restore-failed"
                counts["restore-failed"] = counts.get("restore-failed", 0) + 1
        records_by_rel = {dest_rel_path(r): r for r in records if r.get("status") == "included"}
        verify_result = verify_restored(actions, records_by_rel)
    else:
        restored_bytes = sum(a["record"].get("size", 0)
                             for a in actions if a["action"] == "restore")

    report = build_report(args.date, backup_root, restore_root, actions, counts,
                          restored_bytes, args.apply, verify_result)
    print(report)

    out_dir = pathlib.Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = "apply" if args.apply else "dryrun"
    report_path = out_dir / f"restore_{suffix}_{args.date}.md"
    report_path.write_text(report, encoding="utf-8")
    print(f"レポートを保存しました: {report_path}")

    if not args.apply:
        print("\n※ dry-runのため何も書き出していません。実行するには --apply を付けてください。")
        sys.exit(0)

    ok, mismatch, unreadable = verify_result
    if mismatch or unreadable or counts.get("restore-failed") or counts.get("missing-in-backup"):
        sys.exit(1)
    print(f"\n復元完了: {len(ok)}件が正本と一致しています。")
    print(f"復元先: {restore_root}")
    print("正本を置き換えるかどうかは、中身を確認した上で判断してください。")


if __name__ == "__main__":
    main()
