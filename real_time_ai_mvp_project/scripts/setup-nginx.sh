#!/usr/bin/env bash
#
# nginx の vhost 追加と証明書取得(DEPLOY.md の手順5)。
#
#   sudo bash setup-nginx.sh mvp.example.jp
#
# **既にサイトが動いているサーバーを想定している。**
# 既存の設定ファイルは読むだけで、書き換えない。新しいファイルを1つ足すだけ。
# 危ないと判断したら、何もせずに理由を出して止まる。
#
# 何度流しても同じ結果になる(証明書は取得済みならそのまま使う)。
set -euo pipefail

DOMAIN="${1:-${RTMVP_DOMAIN:-}}"
SRC=/opt/rt-mvp/src
ROOT="$SRC/real_time_ai_mvp_project/app/dist"
NAME=rt-mvp
BACKUP="/etc/nginx.bak.$(date +%Y%m%d-%H%M%S)"

step() { echo; echo "=============== $* ==============="; }
fail() { echo; echo "!!! ここで止めました: $*"; exit 1; }

step "0. 前提の確認"
[ "$(id -u)" -eq 0 ] || fail "root で実行してください(sudo bash setup-nginx.sh <ドメイン>)"
[ -n "$DOMAIN" ] || fail "ドメインを渡してください: sudo bash setup-nginx.sh mvp.example.jp"
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]* | -* | *.) fail "ドメイン名として読めません: $DOMAIN" ;;
esac
command -v nginx >/dev/null || fail "nginx が入っていません"
[ -f "$ROOT/index.html" ] || fail "PWAのビルド結果がありません: $ROOT
  先に setup-vps.sh(手順1〜4)を通してください"

# Gateway が上がっていないと、vhost を足しても 502 になる。先に確かめる
curl -fsS --max-time 5 http://127.0.0.1:8787/healthz >/dev/null \
  || fail "Gateway が 127.0.0.1:8787 で応答しません(systemctl status rt-mvp)"
echo "Gateway: 応答あり / PWA: $ROOT"

# 名前が引けること。ワイルドカードDNSでも引ければよい
# `|| true` が要る。pipefail のせいで、引けなかったときに getent の終了コードが
# 代入の status になり、下の fail まで届かず黙って終わってしまう
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
[ -n "$RESOLVED" ] || fail "$DOMAIN が名前解決できません。DNSのAレコードを先に用意してください"
echo "DNS: $DOMAIN -> $RESOLVED"

step "1. 既存設定の確認(読むだけ)"
# Debian系(sites-enabled)と nginx.org 系(conf.d)の両方に対応する
if [ -d /etc/nginx/sites-enabled ] && nginx -T 2>/dev/null | grep -q "sites-enabled"; then
  LAYOUT=sites
  AVAIL=/etc/nginx/sites-available/$NAME
  ENABLED=/etc/nginx/sites-enabled/$NAME
else
  LAYOUT=confd
  AVAIL=/etc/nginx/conf.d/$NAME.conf
  ENABLED="$AVAIL"
fi
echo "設定の置き場: $LAYOUT ($AVAIL)"

DUMP="$(nginx -T 2>/dev/null || true)"
[ -n "$DUMP" ] || fail "nginx -T が読めません。今の設定が壊れている可能性があります"

# 既に別のファイルがこのドメインを名乗っていたら、取り合いになる。触らずに止める
OTHERS="$(printf '%s\n' "$DUMP" \
  | awk -v d="$DOMAIN" '
      /^# configuration file/ { f=$4; sub(/:$/,"",f) }
      /server_name/ { if (index($0, d) && f !~ /rt-mvp/) print "  " f ": " $0 }
  ')"
if [ -n "$OTHERS" ]; then
  echo "$OTHERS"
  fail "$DOMAIN が既に別の設定で使われています。どちらを残すか決めてから手で作業してください"
fi

# default_server の有無は情報として出す。こちらの設定には付けないので衝突しない
printf '%s\n' "$DUMP" | grep -E "listen .*default_server" | sed 's/^/  既存の default_server: /' || true
echo "→ こちらの設定に default_server は付けません(衝突しません)"

# IPv6 の待ち受けは、既存設定が既に張れているときだけ真似る。
# IPv6を持たないホストで listen [::]:80 を書くと nginx -t ごと落ちる
if printf '%s\n' "$DUMP" | grep -qE "listen[[:space:]]+\[::\]:80"; then
  LISTEN6="    listen [::]:80;"
  echo "→ 既存設定が IPv6 を待ち受けているので、こちらも合わせます"
else
  LISTEN6=""
  echo "→ 既存設定に IPv6 の待ち受けが無いので、IPv4 のみにします"
fi

step "1.5. アクセス制限(任意)"
# 無認証で触れるのは「PWA本体」と「セッション作成」の2つだけ。
# それ以外の /api/ はセッショントークン必須、/preview/ と /ws/ も同様。
# つまりこの2つを塞げば、URLを見つけられても商談の枠を潰されない。
#
#   RTMVP_BASIC_USER=eigyo bash setup-nginx.sh mvp.example.jp   # かける
#   RTMVP_BASIC_USER=none  bash setup-nginx.sh mvp.example.jp   # 外す
#
# 一度かけたら、次から指定しなくても維持する(再実行で黙って外れると危ない)
HTPASSWD=/etc/nginx/.htpasswd-rt-mvp
AUTH_USER="${RTMVP_BASIC_USER:-}"
if [ -z "$AUTH_USER" ] && [ -f "$HTPASSWD" ]; then
  AUTH_USER="$(cut -d: -f1 "$HTPASSWD" | head -1)"
  echo "既にアクセス制限がかかっています(利用者: $AUTH_USER)。維持します"
fi

if [ "$AUTH_USER" = none ]; then
  rm -f "$HTPASSWD"
  AUTH_LINES=""
  echo "アクセス制限を外します。**誰でもPWAを開いてセッションを作れる状態になります**"
elif [ -n "$AUTH_USER" ]; then
  if [ ! -f "$HTPASSWD" ] || ! grep -q "^$AUTH_USER:" "$HTPASSWD"; then
    if [ -n "${RTMVP_BASIC_PASS:-}" ]; then
      pass="$RTMVP_BASIC_PASS"
    else
      # 端末から直接読む。`| tee` でログを取っていても画面には出さない
      printf "%s のパスワード: " "$AUTH_USER" > /dev/tty
      read -rs pass < /dev/tty; echo > /dev/tty
      printf "もう一度: " > /dev/tty
      read -rs pass2 < /dev/tty; echo > /dev/tty
      [ "$pass" = "$pass2" ] || fail "パスワードが一致しません"
    fi
    [ -n "$pass" ] || fail "パスワードが空です"
    # コマンドライン引数で渡すと ps から見えるので、標準入力から食わせる
    printf '%s:%s\n' "$AUTH_USER" "$(printf '%s' "$pass" | openssl passwd -apr1 -stdin)" \
      > "$HTPASSWD"
    unset pass pass2
    chmod 640 "$HTPASSWD"
    chown root:www-data "$HTPASSWD" 2>/dev/null || true
    echo "作成しました: $HTPASSWD"
  fi
  AUTH_LINES="        auth_basic \"rt-mvp\";
        auth_basic_user_file $HTPASSWD;"
  echo "PWA本体とAPIに認証をかけます(QRで開く /preview/ は対象外)"
else
  AUTH_LINES=""
  echo "アクセス制限なし。かけるなら RTMVP_BASIC_USER=<利用者名> を付けて実行し直す"
fi

step "2. バックアップ"
cp -a /etc/nginx "$BACKUP"
echo "戻したいとき: rm -rf /etc/nginx && mv $BACKUP /etc/nginx && systemctl reload nginx"
echo "取得先: $BACKUP"

step "3. vhost を1つ足す"
cat > "$AVAIL" <<EOF
# rt-mvp: リアルタイムAI商談支援。PWA・API・生成MVPを同一オリジンで出す。
# 既存サイトと同居させるため、server_name は必ず書き、default_server は付けない。
server {
    listen 80;
$LISTEN6
    server_name $DOMAIN;

    # certbot がこの server を書き換えて 443 を足す

    root $ROOT;
    index index.html;

    # 本文はMarkdown全文置換の1MBが最大なので2mで十分
    client_max_body_size 2m;

    # プレビューのCookieは生成MVPを開く鍵そのもの。平文HTTPへ一度でも
    # 誘導されると送信されてしまうので、ブラウザ側にHTTPSを強制させる。
    # 80番の応答では無視されるだけなので、両方のserverに入っていて構わない
    add_header Strict-Transport-Security "max-age=31536000" always;

    # 無認証で叩けるAPIはセッション作成だけ。ここにだけ認証をかける。
    #
    # **/api/ 全体にかけてはいけない。** PWAは以降のAPI呼び出しで
    # \`Authorization: Bearer <セッショントークン>\` を送る。Authorizationヘッダは
    # 1つしか無いのでBasic認証と奪い合いになり、**全ての呼び出しが401になる**
    # (録音は始まるのに議事録が一切読めない状態になる)。
    #
    # 認証は location の中にだけ書く。server 直下に書くと
    # certbot が更新時に足す /.well-known/acme-challenge/ まで塞いで
    # **証明書の自動更新が静かに失敗する。**
    location = /api/v1/sessions {
$AUTH_LINES
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
    }

    # 残りの /api/ はセッショントークン必須(Gateway側で検証)。認証は重ねない
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
    }

    # 監視用。認証はかけない。
    # X-Forwarded-For を付けるのは転送であることの目印。これがあるとGatewayは
    # 稼働セッション数を返さない(商談の有無を外から観測させない)
    location /healthz {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header X-Forwarded-For \$remote_addr;
    }

    # 音声のWebSocket。セッショントークンで検証済みなので認証はかけない
    # (WebSocketのハンドシェイクにBasic認証の資格情報が乗るかはブラウザ依存で、
    #  かけると商談中に繋がらない環境が出かねない)
    # 商談1件ぶん張りっぱなしになるので読みタイムアウトを長く
    location /ws/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 生成MVPの配信。トークン検証はGateway側で行う(操作用とは別の previewToken)。
    # **ここに認証をかけてはいけない。** QRを読んだ直後にパスワード入力が挟まり、
    # 「QRを読めば開く」という体験そのものが壊れる
    location /preview/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # ── PWAの配信とキャッシュ方針 ─────────────────────
    #
    # 更新を確実に端末へ届けるための決め事。ヘッダが無いとブラウザが
    # 勝手な寿命でキャッシュし、**サーバーを更新しても端末は古いアプリを
    # 動かし続ける**(直したはずの不具合が実機でまだ出る、が実際に起きた)。
    #
    # - index.html と sw.js は「使う前に毎回確認」(no-cache)
    # - ハッシュ付きアセットは中身が変われば名前も変わるので、長期でよい
    #
    # add_header は location に1つでも書くと server 直下のぶんを引き継がない。
    # HSTS をここでも繰り返すのはそのため
    location = /index.html {
$AUTH_LINES
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Cache-Control "no-cache" always;
        try_files \$uri =404;
    }

    location = /sw.js {
$AUTH_LINES
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Cache-Control "no-cache" always;
        try_files \$uri =404;
    }

    location /assets/ {
$AUTH_LINES
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }

    # それ以外はPWA(/ へのアクセスは try_files の内部転送で
    # 上の location = /index.html を通り、同じキャッシュ方針になる)
    location / {
$AUTH_LINES
        try_files \$uri /index.html;
    }
}
EOF
if [ "$LAYOUT" = sites ]; then ln -sfn "$AVAIL" "$ENABLED"; fi

# nginx を通らない設定を reload すると、既存サイトごと落ちる。必ず先に検査する
if ! nginx -t; then
  rm -f "$ENABLED"
  if [ "$LAYOUT" = sites ]; then rm -f "$AVAIL"; fi
  if nginx -t >/dev/null 2>&1; then
    echo "追加した設定を取り消しました。既存の設定は元のままです"
  fi
  fail "設定が通りませんでした(上の nginx -t の出力を参照)"
fi
systemctl reload nginx
echo "反映しました"

# 既存サイトを奪っていないか、名前を指定して確かめる
curl -fsS --max-time 5 -H "Host: $DOMAIN" http://127.0.0.1/healthz >/dev/null \
  || fail "$DOMAIN 宛の /healthz が返りません。別のserverが先に拾っている可能性があります"
echo "$DOMAIN の /healthz: OK(HTTP)"

step "4. 証明書(Let's Encrypt)"
if ! command -v certbot >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
fi

# 手順3でファイルを作り直しているため、再実行時は certbot が足した443ブロックが
# 消えている。取得済みなら「入れ直す」までやらないと、再実行でHTTPSが落ちる
CERTNAME="$(certbot certificates 2>/dev/null | awk -v d="$DOMAIN" '
  /Certificate Name:/ { n = $3 }
  /Domains:/ { for (i = 2; i <= NF; i++) if ($i == d) { print n; exit } }
')"

if [ -n "$CERTNAME" ]; then
  echo "取得済みの証明書を使います: $CERTNAME"
  certbot install --nginx --cert-name "$CERTNAME" \
    || fail "既存の証明書を設定へ入れ直せませんでした。$BACKUP に控えがあります"
else
  # メールアドレスと規約の同意を聞かれる。ここは対話のまま通す
  certbot --nginx -d "$DOMAIN" || fail "証明書の取得に失敗しました。
  80番が外から届いているか(ufw / Xserverのパケットフィルタ)を確認してください。
  既存の設定は $BACKUP に控えてあります"
fi

nginx -t || fail "証明書の設定後に nginx -t が通りませんでした。$BACKUP に控えがあります"
systemctl reload nginx

# reload 直後は古いworkerがまだ応答する。待たずに確認すると
# **認証がかかっているのに「かかっていない」と報告する。** 落ち着くまで待つ
sleep 3

step "5. 確認"
# reload 直後は443の待ち受けが間に合わないことがある。数回試してから諦める
https_up=no
for _ in 1 2 3 4 5; do
  if body="$(curl -fsS -m 10 "https://$DOMAIN/healthz" 2>/dev/null)"; then
    https_up=yes
    break
  fi
  sleep 2
done
echo "--- https://$DOMAIN/healthz ---"
if [ "$https_up" = yes ]; then
  echo "$body"
else
  echo "外からのHTTPSが通りません(443がふさがれている可能性)"
fi
echo

if [ -n "$AUTH_LINES" ]; then
  echo "--- アクセス制限 ---"
  # 応答が取れないまま「合格」と出すと、確認になっていない。届かなければ失敗にする
  [ "$https_up" = yes ] || fail "HTTPSが通らないので、アクセス制限の確認ができません"
  # reload 直後は接続が一度だけ落ちることがある。000 は判定材料にならないので取り直す
  probe() {
    local code
    code="$(curl -s -o /dev/null -m 10 -w "%{http_code}" "$@")"
    if [ "$code" = 000 ]; then
      sleep 2
      code="$(curl -s -o /dev/null -m 10 -w "%{http_code}" "$@")"
    fi
    printf '%s' "$code"
  }
  echo "  PWA本体        : $(probe "https://$DOMAIN/")  ← 401 なら効いている"
  echo "  セッション作成 : $(probe -X POST -H 'content-type: application/json' \
    -d '{}' "https://$DOMAIN/api/v1/sessions")  ← 401 なら効いている"
  echo "  /healthz       : $(probe "https://$DOMAIN/healthz")  ← 200 のままでよい(監視用)"

  # PWAは Authorization: Bearer を送る。ここに Basic 認証が残っていると
  # nginx が奪い合って401を返し、**録音は始まるのに議事録が読めない**状態になる
  bearer="$(curl -s -m 10 -D - -o /dev/null -H "Authorization: Bearer dummy" \
    "https://$DOMAIN/api/v1/sessions/none/documents" || true)"
  [ -n "$bearer" ] || fail "/api/ の確認ができませんでした(応答なし)"
  if printf '%s' "$bearer" | grep -qi "^www-authenticate"; then
    fail "セッション操作のAPIにBasic認証がかかっています。
  PWAが送る Authorization: Bearer と競合し、商談中に議事録が読めなくなります"
  fi
  echo "  セッション操作 : Basic認証なし(Bearerトークンが通る)"

  # QRで開く経路。ここに認証がかかっていたら体験が壊れる
  hdr="$(curl -s -m 10 -D - -o /dev/null "https://$DOMAIN/preview/none/none/" || true)"
  [ -n "$hdr" ] || fail "/preview/ から応答がありません。確認できていないので先へ進めません"
  if printf '%s' "$hdr" | grep -qi "^www-authenticate"; then
    fail "/preview/ に認証がかかっています。QRを読んでも開けません"
  fi
  echo "  /preview/      : 認証なし(QRで開ける。previewToken で保護)"
  echo
fi
echo "他のサイトが生きているかも見ておくこと:"
printf '%s\n' "$DUMP" | grep -E "^\s*server_name" | sort -u | sed 's/^/  /'

echo
echo ">>> 手順5は完了です <<<"
echo "次: node $SRC/real_time_ai_mvp_project/scripts/preflight.mjs https://$DOMAIN"
