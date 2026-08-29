#!/usr/bin/env python3
"""Discord Webhookへの通知送信。

Webhook URLはこのスクリプトにもリポジトリにもハードコードしない。
呼び出し側が `--webhook-url` 引数、または `DISCORD_WEBHOOK_URL` 環境変数で渡す
(既存のAI開発プロジェクトの `shared/notify.py` と同じ環境変数名に合わせている)。

依存ライブラリなし(標準ライブラリのみ、urllib.requestを使用)。

使い方:
    python scripts/notify_discord.py --webhook-url "https://discord.com/api/webhooks/..." --message "本文"
    # または
    DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." python scripts/notify_discord.py --message "本文"
"""
import argparse
import json
import os
import sys
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Discord Webhookへメッセージを送信する")
    parser.add_argument("--webhook-url", default=None, help="省略時はDISCORD_WEBHOOK_URL環境変数を使う")
    parser.add_argument("--message", required=True, help="送信する本文")
    args = parser.parse_args()

    webhook_url = args.webhook_url or os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook_url:
        print("エラー: Webhook URLが指定されていません(--webhook-url か DISCORD_WEBHOOK_URL 環境変数が必要)", file=sys.stderr)
        sys.exit(1)

    payload = json.dumps({"content": args.message}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "self-evolving-ai-notify/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"送信しました(status: {resp.status})")
    except Exception as e:
        print(f"エラー: Discordへの送信に失敗しました: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
