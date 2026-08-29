#!/usr/bin/env bash
#
# VPS の初期構築(DEPLOY.md の手順1〜4)を一度に行う。
#
#   sudo bash setup-vps.sh
#
# **nginx には一切触れない。** 既にサイトが動いているサーバーでも安全に流せる。
# nginx の設定と証明書の取得(手順5)は、既存設定を確認してから手で行う。
#
# 何度流しても同じ結果になるようにしてある(再実行で更新できる)。
#
# 止まって見えるときは、別のSSH窓から:
#   ps -eo pid,etime,cmd | grep -E "apt|dpkg|npm" | grep -v grep
#   fuser -v /var/lib/dpkg/lock-frontend
set -euo pipefail

# 作業ブランチから追うときは RTMVP_BRANCH で上書きする
BRANCH="${RTMVP_BRANCH:-master}"
REPO="${RTMVP_REPO:-https://github.com/akiijauto/self-evolving-ai-public.git}"
SRC=/opt/rt-mvp/src
PROJECT="$SRC/real_time_ai_mvp_project"

step() { echo; echo "=============== $* ==============="; }
fail() { echo; echo "!!! ここで失敗しました: $*"; exit 1; }

step "0. 前提の確認"
[ "$(id -u)" -eq 0 ] || fail "root で実行してください(sudo bash setup-vps.sh)"
. /etc/os-release
echo "OS: $PRETTY_NAME"
case "${ID:-}" in
  ubuntu | debian) ;;
  *) fail "この手順は Ubuntu / Debian 用です。OSに合わせた手順が必要です" ;;
esac

step "1. Node 22"
# 対話プロンプト(設定ファイルの差し替え確認など)で止まらないようにする
export DEBIAN_FRONTEND=noninteractive
# needrestart を止める。Ubuntu 24.04 では apt のフック(apt-pinvoke -m u)が
# 「どのサービスを再起動しますか」を対話で聞き、**答えるまで永久に待つ。**
# 更新待ちが溜まったサーバーで実際に1時間36分止まった。
#
# 既にサイトが動いているサーバーへ入れるので、自動再起動(NEEDRESTART_MODE=a)は選ばない。
# 一覧表示だけにして、再起動の判断は人に残す
export NEEDRESTART_SUSPEND=1
export NEEDRESTART_MODE=l
# aptのロックは待つが、待ち続けない。握っているのはたいてい unattended-upgrades で、
# 初回起動直後のUbuntuでは数分かかる。無限に待つと「固まった」ようにしか見えない
APT="apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 -q -y"

# 誰かがaptを使っていれば、黙って待たずに誰なのかを出す
if command -v fuser >/dev/null && fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
  echo "他のプロセスが apt を使っています。終わるまで最大10分待ちます:"
  fuser -v /var/lib/dpkg/lock-frontend 2>&1 | sed 's/^/  /'
fi

# 外へ出られるかを先に確かめる。IPv6が張られているのに疎通しないVPSでは、
# apt も curl も IPv6 を先に試して長く待つ(これも「固まった」に見える)
if ! curl -fsS -o /dev/null -m 20 https://deb.nodesource.com/setup_22.x; then
  echo "IPv4 で試し直します(IPv6 の疎通が無い可能性)"
  curl -4 -fsS -o /dev/null -m 20 https://deb.nodesource.com/setup_22.x \
    || fail "deb.nodesource.com へ出られません。VPSのネットワーク設定を確認してください"
  # apt にも IPv4 を使わせる
  echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4
  echo "→ apt も IPv4 に固定しました(/etc/apt/apt.conf.d/99force-ipv4)"
fi

$APT update
$APT install git curl ca-certificates
if ! node -v 2>/dev/null | grep -q '^v22'; then
  # 出力を捨てない。捨てると、詰まったときに何を待っているか分からなくなる
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  $APT install nodejs
fi
node -v | grep -q '^v22' || fail "Node 22 が入りませんでした"
echo "Node: $(node -v) / npm: $(npm -v)"

step "2. 配置とビルド"
id rtmvp >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin rtmvp
mkdir -p /opt/rt-mvp /var/lib/rt-mvp
chown rtmvp:rtmvp /opt/rt-mvp /var/lib/rt-mvp

# 非公開リポジトリだと入力待ちで固まる。聞かずに失敗させて理由を出す
export GIT_TERMINAL_PROMPT=0
if [ -d "$SRC/.git" ]; then
  sudo -H -u rtmvp git -C "$SRC" fetch origin "$BRANCH" \
    || fail "git fetch に失敗。認証情報を確認してください(下の clone と同じ)"
  sudo -H -u rtmvp git -C "$SRC" checkout -B "$BRANCH" "origin/$BRANCH"
else
  sudo -H -u rtmvp git clone -b "$BRANCH" "$REPO" "$SRC" \
    || fail "git clone に失敗。このリポジトリは非公開です。次のどちらかで認証してください:
  (A) デプロイキー(推奨。サーバー向き・読み取り専用・鍵がconfigに残らない)
      sudo -u rtmvp ssh-keygen -t ed25519 -f /home/rtmvp/.ssh/id_ed25519 -N ''
      sudo cat /home/rtmvp/.ssh/id_ed25519.pub   # GitHubの Settings > Deploy keys へ登録(Read only)
      sudo -u rtmvp ssh-keyscan github.com >> /home/rtmvp/.ssh/known_hosts
      RTMVP_REPO=git@github.com:akiijauto/self-evolving-ai-public.git sudo -E bash \$0
  (B) アクセストークン(手早いが、使用後に remote から取り除くこと)
      RTMVP_REPO=https://<TOKEN>@github.com/akiijauto/self-evolving-ai-public.git sudo -E bash \$0
      # 完了後: sudo -u rtmvp git -C $SRC remote set-url origin $REPO"
fi

cd "$PROJECT" || fail "$PROJECT がありません。ブランチ指定を確認してください"
[ -f package-lock.json ] || fail "リポジトリの中身が想定と違います"
echo "依存関係を入れます(数分かかる。途中で出力が止まって見えるのは正常)"
sudo -H -u rtmvp npm ci --no-audit --no-fund
echo "PWAをビルドします"
sudo -H -u rtmvp npm run build
[ -f app/dist/index.html ] || fail "PWAのビルド結果が見つかりません"
echo "ビルド成功: $(ls -1 app/dist | tr '\n' ' ')"

step "3. 環境変数"
mkdir -p /etc/rt-mvp
if [ -f /etc/rt-mvp/env ]; then
  echo "既にあるので上書きしません: /etc/rt-mvp/env"
else
  # APIキーは空のまま。モックで動くので、まず疎通を通すことを優先する
  cat > /etc/rt-mvp/env <<'ENV'
HOST=127.0.0.1
PORT=8787
DATA_DIR=/var/lib/rt-mvp/data
LOG_DIR=/var/lib/rt-mvp/logs
CORS_ORIGINS=
ENV
  chmod 600 /etc/rt-mvp/env
  echo "作成しました(APIキーは後から追記)"
fi

step "4. systemd"
cat > /etc/systemd/system/rt-mvp.service <<'UNIT'
[Unit]
Description=RealTime AI MVP Gateway Server
After=network-online.target
Wants=network-online.target

[Service]
User=rtmvp
WorkingDirectory=/opt/rt-mvp/src/real_time_ai_mvp_project/server
EnvironmentFile=/etc/rt-mvp/env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
# 書いたファイルを他ユーザーに読ませない。既にサイトが同居しているサーバーへ
# 入れるため、既定の umask 022(=0644)では商談の記録が丸見えになる
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now rt-mvp >/dev/null
systemctl restart rt-mvp
sleep 4

echo "--- healthz ---"
if curl -fsS --max-time 5 http://127.0.0.1:8787/healthz; then
  echo
  echo ">>> 手順1〜4は完了です <<<"
else
  echo
  echo "起動していません。ログ:"
  journalctl -u rt-mvp -n 40 --no-pager || true
  exit 1
fi

step "5の準備. 既存nginxの状態(この出力を共有すること)"
echo "--- sites-enabled ---"
ls -l /etc/nginx/sites-enabled/ 2>/dev/null || echo "なし"
echo "--- server_name / listen / root ---"
nginx -T 2>/dev/null | grep -E "server_name|listen |root " | head -40 || echo "取得できず"
echo "--- 証明書 ---"
certbot certificates 2>/dev/null || echo "certbot 未導入"

echo
echo "次は nginx の設定(DEPLOY.md 手順5)。**上の出力を確認してから**行うこと。"
