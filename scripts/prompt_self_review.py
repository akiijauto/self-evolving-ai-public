#!/usr/bin/env python3
"""プロンプト自己レビュー層(アイデア4)。

タスクを実行する前に、そのタスクの説明(プロンプト/指示文)に
「目的・手段・アウトプット」の3点が揃っているかを軽量にチェックする。
LLM呼び出しは行わず、ヒューリスティック(キーワード・構造マッチ)のみで
判定する(依存ライブラリなし・APIコスト0)。

判定はあくまで「揃っていなさそうな観点への気づき」を与えるためのもので、
実行を強制的にブロックするものではない(WARNを出すだけで、続行は呼び出し側の判断)。

使い方:
    python scripts/prompt_self_review.py --text "このタスクの目的は...アウトプットは..."
    python scripts/prompt_self_review.py --file path/to/prompt.txt
    echo "..." | python scripts/prompt_self_review.py --stdin

終了コード: 常に0(チェック結果はJSONで標準出力に返すのみ。呼び出し側で
必要ならJSONの `verdict` を見て挙動を変えること)。
"""
import argparse
import json
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# 「目的」「手段」「アウトプット」それぞれを示唆するキーワード群。
# 完全一致ではなく緩やかな手がかり探索(誤検知はあり得る前提の軽量チェック)。
PURPOSE_KEYWORDS = ["目的", "ゴール", "なぜ", "背景", "課題", "狙い", "goal", "purpose", "why"]
MEANS_KEYWORDS = ["方法", "手段", "手順", "どうやって", "実装", "使って", "how", "using", "via", "経由"]
OUTPUT_KEYWORDS = ["アウトプット", "成果物", "出力", "報告", "レポート", "結果", "output", "deliverable", "report"]


def contains_any(text, keywords):
    return any(k.lower() in text.lower() for k in keywords)


def review(text):
    has_purpose = contains_any(text, PURPOSE_KEYWORDS)
    has_means = contains_any(text, MEANS_KEYWORDS)
    has_output = contains_any(text, OUTPUT_KEYWORDS)

    missing = []
    if not has_purpose:
        missing.append("目的")
    if not has_means:
        missing.append("手段")
    if not has_output:
        missing.append("アウトプット")

    # 日本語は分かち書きされないため単語数ではなく文字数(空白除く)で短文判定する
    char_count = len(re.sub(r"\s", "", text))
    too_short = char_count < 10

    verdict = "OK" if not missing and not too_short else "WARN"

    return {
        "verdict": verdict,
        "has_purpose": has_purpose,
        "has_means": has_means,
        "has_output": has_output,
        "missing": missing,
        "too_short": too_short,
        "char_count": char_count,
        "note": (
            "3点(目的・手段・アウトプット)が揃っているかの軽量ヒューリスティック判定です。"
            "誤検知はあり得るため、あくまで気づきの参考情報として扱ってください。"
        ),
    }


def main():
    parser = argparse.ArgumentParser(description="プロンプト/指示文が目的・手段・アウトプットの3点を含むか軽量チェックする")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--text", help="チェック対象のテキストを直接渡す")
    group.add_argument("--file", help="チェック対象のテキストファイルパス")
    group.add_argument("--stdin", action="store_true", help="標準入力からテキストを読む")
    args = parser.parse_args()

    if args.text:
        text = args.text
    elif args.file:
        text = open(args.file, encoding="utf-8").read()
    else:
        text = sys.stdin.read()

    result = review(text)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
