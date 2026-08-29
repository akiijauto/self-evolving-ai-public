#!/usr/bin/env bash
#
# 稼働中のサーバーを最新版へ更新する。
#
#   sudo bash /opt/rt-mvp/src/real_time_ai_mvp_project/scripts/update.sh
#   sudo bash ... update.sh mvp.example.jp    # 更新後に疎通確認まで行う
#
# **商談中は更新しない。** 実行中のセッションがあれば、何もせずに止まる。
# 更新は systemctl restart を伴い、実行中の商談を `server_restart` で終わらせる。
#
# 途中で失敗したら、元のコミットへ戻してから起動し直す。
# 「更新に失敗した状態のまま商談を迎える」のが一番まずい。
set -euo pipefail

DOMAIN="${1:-}"
SRC=/opt/rt-mvp/src
PROJECT="$SRC/real_time_ai_mvp_project"
# 作業ブランチから追うときは RTMVP_BRANCH で上書きする
BRANCH="${RTMVP_BRANCH:-master}"

step() { echo; echo "=============== $* ==============="; }
fail() { echo; echo "!!! ここで止めました: $*"; exit 1; }

step "0. 前提の確認"
[ "$(id -u)" -eq 0 ] || fail "root で実行してください"
[ -d "$PROJECT/.git" ] || [ -d "$SRC/.git" ] || fail "$SRC がgitリポジトリではありません"

health="$(curl -fsS -m 5 http://127.0.0.1:8787/healthz)" \
  || fail "Gateway が応答しません。先に systemctl status rt-mvp を確認してください"

# **`sessions` ではなく `active` を見る。**
# `sessions` は保持中の全件で、終了済みの商談も30日間数え続ける。
# そちらで判定すると、一度商談をしたあと二度と更新できなくなる
active="$(printf '%s' "$health" | sed -n 's/.*"active":\([0-9]*\).*/\1/p')"
sessions="$(printf '%s' "$health" | sed -n 's/.*"sessions":\([0-9]*\).*/\1/p')"

if [ -z "$active" ]; then
  # 稼働中のサーバーが `active` を返さない = この修正より前の版。
  # 判定できないことを黙って「0件」に読み替えない
  fail "稼働中のサーバーが古く、実行中の商談を判定できません(healthz に active がない)。
  保持中のセッション: ${sessions:-不明}件(終了済みを含む)
  **商談中でないことを自分で確かめてから**、次で進めてください:
    RTMVP_FORCE=1 bash $0 ${DOMAIN:+$DOMAIN}
  この更新が入れば、次回から自動で判定できます"
fi

echo "実行中の商談: ${active}件(保持中のセッション: ${sessions:-不明}件、終了済みを含む)"

if [ "$active" != 0 ] && [ "${RTMVP_FORCE:-}" != 1 ]; then
  fail "商談が実行中です(${active}件)。更新すると server_restart で終了します。
  それでも進めるなら RTMVP_FORCE=1 を付けてください"
fi

step "1. いまの版を控える"
PREV="$(sudo -H -u rtmvp git -C "$SRC" rev-parse HEAD)"
echo "現在: $PREV"
echo "戻したいとき: sudo -H -u rtmvp git -C $SRC checkout $PREV && 下と同じ手順"

step "2. 取得"
export GIT_TERMINAL_PROMPT=0
sudo -H -u rtmvp git -C "$SRC" fetch origin "$BRANCH" \
  || fail "git fetch に失敗しました。まだ更新していないので、稼働中の版はそのままです"
NEXT="$(sudo -H -u rtmvp git -C "$SRC" rev-parse "origin/$BRANCH")"

if [ "$PREV" = "$NEXT" ]; then
  echo "既に最新です。何もしません"
  exit 0
fi
echo "更新先: $NEXT"
sudo -H -u rtmvp git -C "$SRC" log --oneline "$PREV..$NEXT" | sed 's/^/  /'

# ここから先で失敗したら、元へ戻してから起動し直す
rollback() {
  echo
  echo "!!! 失敗しました。$PREV へ戻します"
  sudo -H -u rtmvp git -C "$SRC" checkout -q "$PREV" || true
  (cd "$PROJECT" && sudo -H -u rtmvp npm ci --no-audit --no-fund >/dev/null 2>&1) || true
  (cd "$PROJECT" && sudo -H -u rtmvp npm run build >/dev/null 2>&1) || true
  systemctl restart rt-mvp || true
  sleep 4
  if curl -fsS -m 5 http://127.0.0.1:8787/healthz >/dev/null; then
    echo "元の版で復旧しました。更新は行われていません"
  else
    echo "**復旧できませんでした。** 手で確認してください: journalctl -u rt-mvp -n 50"
  fi
  exit 1
}
trap rollback ERR

step "3. 切り替えとビルド"
sudo -H -u rtmvp git -C "$SRC" checkout -B "$BRANCH" "origin/$BRANCH"
cd "$PROJECT"
echo "依存関係(数分かかる)"
sudo -H -u rtmvp npm ci --no-audit --no-fund
echo "PWAのビルド"
sudo -H -u rtmvp npm run build
# ここで `|| fail` を使うと exit してしまい、ERRトラップの巻き戻しが動かない。
# 素の判定にして、失敗をそのままトラップへ渡す
test -f app/dist/index.html

step "4. 再起動"
systemctl restart rt-mvp
sleep 4
curl -fsS -m 5 http://127.0.0.1:8787/healthz
echo
trap - ERR

step "5. 確認"
if [ -n "$DOMAIN" ]; then
  # ここでは自動で巻き戻さない。Basic認証をかけていて PREFLIGHT_BASIC を
  # 渡し忘れただけ、という失敗の方が多く、そのために新しい版を捨てるのは行き過ぎ
  node "$PROJECT/scripts/preflight.mjs" "https://$DOMAIN" || fail "preflight が通りませんでした。
  Basic認証をかけているなら PREFLIGHT_BASIC=利用者名 を付けて実行し直す(パスワードは後で聞かれる)。
  それでも駄目なら戻す:
    sudo -H -u rtmvp git -C $SRC checkout $PREV
    cd $PROJECT && sudo -H -u rtmvp npm ci && sudo -H -u rtmvp npm run build
    systemctl restart rt-mvp"
else
  echo "ドメインを渡すと疎通確認まで行います:"
  echo "  sudo bash $0 mvp.example.jp"
fi

echo
echo ">>> $PREV → $NEXT へ更新しました <<<"
