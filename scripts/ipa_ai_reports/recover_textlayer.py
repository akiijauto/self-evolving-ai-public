#!/usr/bin/env python3
"""OCR で上書きされる前のテキストレイヤ版を git 履歴から復元する。

壊れたテキストレイヤにもグラフの数値だけは残っていることがあり
（図中文字が取れず数値だけ取れる）、OCR 側はその逆になりやすい。
両方あると突き合わせができるので、退避し損ねた分を履歴から拾い直す。

    python3 scripts/ipa_ai_reports/recover_textlayer.py
"""
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TEXT_DIR = ROOT / "data" / "ipa-ai-reports" / "text"
OCR_MARK = "テキストレイヤ破損のため"


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args],
                          capture_output=True, text=True).stdout


def main():
    recovered = skipped = 0
    for path in sorted(TEXT_DIR.glob("*.txt")):
        if path.name.endswith((".ocr.txt", ".textlayer.txt")):
            continue
        if OCR_MARK not in path.read_text(encoding="utf-8", errors="replace")[:400]:
            continue
        keep = path.with_name(path.name.replace(".txt", ".textlayer.txt"))
        if keep.exists():
            skipped += 1
            continue

        rel = path.relative_to(ROOT).as_posix()
        for sha in git("log", "--format=%H", "--", rel).split():
            blob = git("show", f"{sha}:{rel}")
            if blob and OCR_MARK not in blob[:400]:
                keep.write_text(blob, encoding="utf-8")
                print(f"復元 {keep.name}  ({len(blob):,}字, {sha[:8]})")
                recovered += 1
                break
        else:
            print(f"見つからず {path.name}")

    print(f"\n復元 {recovered} 件 / 退避済み {skipped} 件")


if __name__ == "__main__":
    main()
