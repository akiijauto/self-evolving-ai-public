#!/usr/bin/env python3
"""manifestに従ってバックアップ先へファイルをコピーする(フェーズB)。

正本(single source of truth)はローカルPC側。同期は **正本 → バックアップ先の一方向のみ**で、
逆方向のコピーは実装しない。バックアップ先には正本の所在を書いたマーカーファイルを置き、
どちらが正本かがフォルダを開いた人にも分かるようにする。

安全設計:
- 既定はdry-run。実際にコピーするには --apply が必要。
- **バックアップ先が直接編集されていたら上書きしない**。前回書き込んだ内容の
  ハッシュを記録しておき、「正本が更新された」のか「バックアップ先が編集された」のかを
  区別する。後者は要確認としてスキップし、--force-overwrite を付けたときだけ上書きする。
- **削除は一切しない**。同期先に余分なファイルがあっても消さず、レポートに出すだけ。
  ミラー削除は事故時の被害がバックアップの目的と真逆になるため実装しない。
- 認証情報らしきファイルはmanifest生成時に除外済みだが、コピー直前にもう一度
  検査し、1件でも混入していたらコピーせず異常終了する(多層防御)。
- 同一内容(sha256一致)ならコピーしない。

前提: バックアップ先はGoogle Drive for desktopの同期フォルダ(ミラーリング設定)。
ストリーミング設定だとローカルに実体が無く、バックアップとして機能しない。

使い方:
    # まずdry-runで何が起きるか確認する
    python scripts/backup_sync.py --date 2026-07-31 --dest "G:/マイドライブ/context-backup"

    # 納得したら実行
    python scripts/backup_sync.py --date 2026-07-31 --dest "G:/マイドライブ/context-backup" --apply
"""
import argparse
import json
import pathlib
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from backup_manifest import (  # noqa: E402
    BACKUP_DIR, dest_rel_path, human_size, is_secret, sha256_of,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# 同期先のルートに置く管理ファイル。どちらもバックアップ対象ではない。
STATE_FILE = "_backup_state.json"      # 前回書き込んだ内容の記録(同期先の編集を検知するため)
MARKER_FILE = "_このフォルダはバックアップです.md"  # 正本の所在を人間に示すための掲示


def build_marker(date, roots, dest_root):
    lines = [
        "# このフォルダはバックアップ(複製)です",
        "",
        "**ここのファイルを直接編集しないでください。**",
        "編集しても正本には反映されず、次回の同期で上書きされる対象になります。",
        "",
        "## 正本(single source of truth)の所在",
        "",
    ]
    if roots:
        for label, root in sorted(roots.items()):
            lines.append(f"- `{label}/` の正本 → `{root}`")
    else:
        lines.append("- (manifestに対象が無かった)")
    lines += [
        "",
        "## ルール",
        "",
        "- 編集は必ず正本(ローカルPC側)で行う。",
        "- このフォルダへは `scripts/backup_sync.py` からの一方向コピーしか行われない。",
        "- 逆方向(このフォルダ → ローカルPC)の同期は行わない。",
        "  復元が必要なときだけ、人間が明示的にコピーする。",
        "- このフォルダのファイルは削除されない(同期スクリプトは削除を一切行わない)。",
        "",
        f"- 最終更新: {date}",
        f"- 生成元: `scripts/backup_sync.py --dest \"{dest_root}\" --apply`",
        "",
        "---",
        "",
        "(このファイルは backup_sync.py が自動生成しています。)",
    ]
    return "\n".join(lines) + "\n"


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


def source_roots(records):
    """manifestから対象ラベルごとの正本パスを復元する(マーカーファイルに書くため)。"""
    roots = {}
    for r in records:
        if r.get("status") != "included" or "src" not in r:
            continue
        label = r.get("source", "root")
        if label in roots:
            continue
        base = pathlib.Path(r["src"])
        for _ in pathlib.PurePosixPath(r["rel_path"]).parts:
            base = base.parent
        roots[label] = str(base)
    return roots


def load_state(dest_root: pathlib.Path):
    """前回このスクリプトが書き込んだ内容の記録を読む。

    「同期先がローカルと違う」理由は2通りある:
      (a) 正本(ローカル)が更新された  → 上書きしてよい
      (b) 同期先が直接編集された      → 上書きすると編集内容が消える
    前回書き込んだハッシュを覚えておくことで、この2つを区別する。
    """
    path = dest_root / STATE_FILE
    if not path.is_file():
        return {"written": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data.get("written"), dict):
            return data
    except (OSError, json.JSONDecodeError) as e:
        print(f"警告: 状態ファイルを読めませんでした({e})。"
              f"同期先の編集を検知できないため、全件を要確認として扱います。", file=sys.stderr)
    return {"written": {}}


def plan(records, dest_root: pathlib.Path, state):
    """コピー計画を組み立てる。ファイルの書き込みは行わない。"""
    written = state.get("written", {})
    actions = []
    for r in records:
        if r.get("status") != "included":
            continue
        src = pathlib.Path(r["src"])
        rel = dest_rel_path(r)
        target = dest_root / rel

        if not src.is_file():
            actions.append({"record": r, "target": target, "rel": rel, "action": "missing-source"})
            continue

        # 多層防御: manifest生成後に名前が変わった等の可能性に備え、直前にも検査する
        if is_secret(src):
            actions.append({"record": r, "target": target, "rel": rel, "action": "secret-detected"})
            continue

        if not target.exists():
            actions.append({"record": r, "target": target, "rel": rel, "action": "copy"})
            continue

        expected = r.get("sha256")
        try:
            current = sha256_of(target)
        except OSError as e:
            actions.append({"record": r, "target": target, "rel": rel,
                            "action": "unreadable-target", "detail": str(e)})
            continue

        if expected and current == expected:
            actions.append({"record": r, "target": target, "rel": rel, "action": "unchanged"})
            continue

        last = written.get(rel)
        if last is None:
            # 前回の記録が無い(初回・状態ファイル紛失)。取り違えを避けるため要確認扱い。
            action = "conflict"
            detail = "前回書き込んだ記録が無く、同期先が編集されたかどうか判定できない"
        elif current == last:
            # 同期先は前回書いたまま = 触られていない。正本が更新されたということ。
            action = "update"
            detail = None
        else:
            # 同期先が前回書いた内容と違う = 同期先が直接編集されている。
            action = "conflict"
            detail = "同期先が直接編集されている(上書きするとその編集が失われる)"
        entry = {"record": r, "target": target, "rel": rel, "action": action}
        if detail:
            entry["detail"] = detail
        actions.append(entry)
    return actions


def find_orphans(dest_root: pathlib.Path, actions):
    """同期先にあるがmanifestに無いファイル。報告のみで削除はしない。"""
    if not dest_root.is_dir():
        return []
    known = {a["target"].resolve() for a in actions}
    managed = {(dest_root / STATE_FILE).resolve(), (dest_root / MARKER_FILE).resolve()}
    orphans = []
    for f in dest_root.rglob("*"):
        try:
            resolved = f.resolve()
            if f.is_file() and resolved not in known and resolved not in managed:
                orphans.append(f)
        except OSError:
            continue
    return orphans


def build_report(date, dest_root, actions, orphans, applied, counts, copied_bytes):
    mode = "実行(--apply)" if applied else "dry-run(既定)"
    lines = [
        f"# バックアップ同期レポート ({date})",
        "",
        f"- モード: {mode}",
        f"- 同期先: `{dest_root}`",
        f"- 新規コピー: {counts.get('copy', 0)}件",
        f"- 更新: {counts.get('update', 0)}件",
        f"- 変更なし(スキップ): {counts.get('unchanged', 0)}件",
        f"- **要確認(同期先が編集された疑い): {counts.get('conflict', 0)}件**",
        f"- 転送量: {human_size(copied_bytes)}",
        "",
    ]

    conflicts = [a for a in actions if a["action"] == "conflict"]
    if conflicts:
        lines += [
            "## 要確認: 同期先が正本と食い違っている",
            "",
            "以下は「前回このスクリプトが書き込んだ内容」と現在の同期先が違っている。",
            "同期先を直接編集した可能性があるため、**上書きせずスキップした**。",
            "",
        ]
        for a in conflicts[:30]:
            lines.append(f"- `{a['rel']}`")
            if a.get("detail"):
                lines.append(f"  - {a['detail']}")
        if len(conflicts) > 30:
            lines.append(f"- ... 他 {len(conflicts) - 30}件")
        lines += [
            "",
            "対処: 同期先の編集内容が不要なら `--force-overwrite` を付けて正本で上書きする。",
            "必要なら、先に正本(ローカルPC側)へ手で取り込んでから同期し直す。",
            "",
        ]

    problems = {k: v for k, v in counts.items()
                if k in {"missing-source", "secret-detected", "unreadable-target", "copy-failed"}}
    if problems:
        lines += ["## 問題", ""]
        for k, v in sorted(problems.items()):
            lines.append(f"- {k}: {v}件")
        lines.append("")

    detail = [a for a in actions if a["action"] in {"copy", "update"}]
    if detail:
        lines += ["## コピー対象(上位50件)", ""]
        for a in detail[:50]:
            lines.append(f"- [{a['action']}] `{dest_rel_path(a['record'])}` "
                         f"({human_size(a['record'].get('size', 0))})")
        if len(detail) > 50:
            lines.append(f"- ... 他 {len(detail) - 50}件")
        lines.append("")

    lines += ["## 同期先にある manifest 外のファイル(削除はしない)", ""]
    if orphans:
        for f in orphans[:30]:
            lines.append(f"- `{f}`")
        if len(orphans) > 30:
            lines.append(f"- ... 他 {len(orphans) - 30}件")
        lines += ["",
                  "これらは対象から外れた・リネームされた等の理由で残ったファイル。"
                  "本スクリプトは削除しないので、不要かどうかは人間が判断すること。"]
    else:
        lines.append("- なし")

    lines += [
        "",
        "---",
        "",
        "(同期は 正本(ローカルPC) → 同期先 の一方向のみ。逆方向のコピーと削除は行わない。)",
    ]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(
        description="manifestに従いバックアップ先へコピーする(既定dry-run、削除は一切しない)")
    parser.add_argument("--date", required=True, help="manifest/レポートのYYYY-MM-DD(自動取得しない)")
    parser.add_argument("--dest", required=True,
                        help="バックアップ先ディレクトリ(Google Driveの同期フォルダ等)")
    parser.add_argument("--manifest", help="manifestのパス(既定: context/backup/manifest_<date>.jsonl)")
    parser.add_argument("--apply", action="store_true",
                        help="実際にコピーする(付けない限り何も書き込まない)")
    parser.add_argument("--force-overwrite", action="store_true",
                        help="同期先が直接編集されていても正本で上書きする(その編集は失われる)")
    parser.add_argument("--out-dir", default=str(BACKUP_DIR), help="レポートの出力先")
    args = parser.parse_args()

    manifest_path = pathlib.Path(args.manifest).expanduser() if args.manifest \
        else BACKUP_DIR / f"manifest_{args.date}.jsonl"
    if not manifest_path.is_file():
        print(f"エラー: manifestが見つかりません: {manifest_path}\n"
              f"      先に backup_manifest.py を実行してください。", file=sys.stderr)
        sys.exit(1)

    dest_root = pathlib.Path(args.dest).expanduser()
    records = load_manifest(manifest_path)
    state = load_state(dest_root)
    actions = plan(records, dest_root, state)

    if args.force_overwrite:
        for a in actions:
            if a["action"] == "conflict":
                a["action"] = "update"
                a["detail"] = "--force-overwrite により同期先の編集を破棄して上書き"

    secrets = [a for a in actions if a["action"] == "secret-detected"]
    if secrets:
        print("エラー: 認証情報らしきファイルがコピー対象に混入しています。中断します。",
              file=sys.stderr)
        for a in secrets:
            print(f"  - {a['record']['src']}", file=sys.stderr)
        print("manifestを作り直すか、対象パスを見直してください。", file=sys.stderr)
        sys.exit(2)

    counts = {}
    copied_bytes = 0
    for a in actions:
        counts[a["action"]] = counts.get(a["action"], 0) + 1

    if args.apply:
        written = dict(state.get("written", {}))
        for a in actions:
            if a["action"] == "unchanged":
                # 同期先が正本と一致している間は、その状態を記録しておく
                # (次回「同期先が編集された」ことを検知できるようにするため)
                if a["record"].get("sha256"):
                    written[a["rel"]] = a["record"]["sha256"]
                continue
            if a["action"] not in {"copy", "update"}:
                continue
            src = pathlib.Path(a["record"]["src"])
            target = a["target"]
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
                copied_bytes += a["record"].get("size", 0)
                written[a["rel"]] = a["record"].get("sha256") or sha256_of(target)
            except OSError as e:
                print(f"警告: コピーに失敗しました: {src} -> {target} ({e})", file=sys.stderr)
                a["action"] = "copy-failed"
                counts["copy-failed"] = counts.get("copy-failed", 0) + 1

        roots = source_roots(records)
        try:
            dest_root.mkdir(parents=True, exist_ok=True)
            (dest_root / MARKER_FILE).write_text(
                build_marker(args.date, roots, dest_root), encoding="utf-8")
            (dest_root / STATE_FILE).write_text(
                json.dumps({"updated_at": args.date, "source_of_truth": roots, "written": written},
                           ensure_ascii=False, indent=2),
                encoding="utf-8")
        except OSError as e:
            print(f"警告: 管理ファイルを書けませんでした({e})。"
                  f"次回、同期先の編集を検知できない可能性があります。", file=sys.stderr)
    else:
        copied_bytes = sum(a["record"].get("size", 0)
                           for a in actions if a["action"] in {"copy", "update"})

    orphans = find_orphans(dest_root, actions)
    report = build_report(args.date, dest_root, actions, orphans, args.apply, counts, copied_bytes)
    print(report)

    out_dir = pathlib.Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = "apply" if args.apply else "dryrun"
    report_path = out_dir / f"sync_{suffix}_{args.date}.md"
    report_path.write_text(report, encoding="utf-8")
    print(f"レポートを保存しました: {report_path}")

    if not args.apply:
        print("\n※ dry-runのため何もコピーしていません。実行するには --apply を付けてください。")

    if counts.get("conflict"):
        print(f"\n※ 同期先が編集された疑いのあるファイルが {counts['conflict']}件 あります。"
              f"上書きせずスキップしました。", file=sys.stderr)

    if counts.get("copy-failed") or counts.get("conflict"):
        sys.exit(1)


if __name__ == "__main__":
    main()
