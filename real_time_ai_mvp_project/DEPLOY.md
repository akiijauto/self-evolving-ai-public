# デプロイ手順(Xserver VPS)

本番サーバーは Xserver VPS 1台。PWA・Gateway Server・生成MVPの配信を
**同一オリジン**で出す。分けない理由:

- TLS証明書が1枚で済む
- PWA→API のCORS設定が不要になる(`VITE_API_BASE_URL` 未設定 = 同一オリジンが既定)
- `wsUrl` は `X-Forwarded-Host` / `X-Forwarded-Proto` から自動で `wss://` になる
- QRのURLも同じホストになり、追加のDNS作業が無い

マイク(getUserMedia)とPWAインストールは **HTTPSでしか動かない**。
TLSは省略できない。

## サブドメインの推奨

既存取得済みのドメイン配下にサブドメインを1つ切る。ラベルの推奨:

| 候補 | 判定 | 理由 |
|---|---|---|
| **`mvp.`** | ★推奨 | 短い。体験の名前そのもの(その場でMVPが出てくる場所)。顧客のスマホや画面共有に映っても説明が要らず、口頭でも伝えやすい |
| `live.` | 次点 | 「その場で」感が出る。ただし配信サービスと紛らわしい |
| `lab.` | 次点 | 「試作の場」の含みは合うが、顧客向けにはやや内輪の語感 |
| `demo.` | 避けたい | 意味は明快だが「作り置きのデモ」に見え、「いま話した内容から作った」という核の驚きを弱める |
| `api.` `app.` | 避ける | 用途が伝わらない。営業の道具としては無個性 |
| 長い複合語(`sales-mvp-gen.` 等) | 避ける | QRの密度が上がり読み取りにくくなる。口頭で伝えられない |

以下、`mvp.example.jp` と書いてある箇所は自分のドメインに読み替える。
DNSは既存ドメインの管理画面で **Aレコード `mvp` → VPSのIPv4** を1本足すだけ。

## 構成

```
顧客/営業のブラウザ
   │ https / wss
   ▼
nginx (443, TLS終端)
   ├── /              → /opt/rt-mvp/app/dist(PWA、静的配信)
   ├── /api/          → 127.0.0.1:8787(Gateway)
   ├── /ws/           → 127.0.0.1:8787(WebSocket、音声)
   ├── /preview/      → 127.0.0.1:8787(生成MVPの配信)
   └── /healthz       → 127.0.0.1:8787
```

Gateway は **127.0.0.1 にだけ** バインドし、外へは nginx しか出さない。

## 0. まとめて流す(推奨)

手順1〜4と手順5は、それぞれスクリプトにしてある。手で1行ずつ打つより確実で、
**危ないと判断したら何もせずに止まる。**

まっさらなVPSには、まだこのリポジトリが無い。**最初に一度だけ手で clone する**
(以降はスクリプトが `git fetch` で更新する):

```bash
sudo apt update && sudo apt -y install git nginx ufw
sudo useradd --system --create-home --shell /usr/sbin/nologin rtmvp
sudo mkdir -p /opt/rt-mvp && sudo chown rtmvp:rtmvp /opt/rt-mvp
sudo -u rtmvp git clone https://github.com/akiijauto/self-evolving-ai-public.git /opt/rt-mvp/src

# ファイアウォール: 22/80/443 だけ開ける。8787は開けない
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

```bash
# 手順1〜4(Node・配置・ビルド・環境変数・systemd)。nginx には触れない
sudo bash /opt/rt-mvp/src/real_time_ai_mvp_project/scripts/setup-vps.sh

# 手順5(vhost追加 + 証明書)。既存サイトが動いていても安全に流せる
sudo bash /opt/rt-mvp/src/real_time_ai_mvp_project/scripts/setup-nginx.sh mvp.example.jp

# 疎通確認
node /opt/rt-mvp/src/real_time_ai_mvp_project/scripts/preflight.mjs https://mvp.example.jp

# 以降の更新(商談中なら何もせず止まる。失敗したら元の版へ戻す)
sudo bash /opt/rt-mvp/src/real_time_ai_mvp_project/scripts/update.sh mvp.example.jp
```

### アクセス制限(任意だが推奨)

TLS証明書は Certificate Transparency ログに載るため、**サブドメインの存在は
取得の数分後には公開情報になる。** 誰でもPWAを開いてセッションを作れる状態だと、
悪意が無くても `SESSION_CREATE_LIMIT`(既定30回/時間、サーバー全体でひとつの窓)を
使い切られ、商談の開始時に作れなくなる。

```bash
# かける(パスワードは対話で聞かれる。画面には出ない)
RTMVP_BASIC_USER=eigyo sudo -E bash scripts/setup-nginx.sh mvp.example.jp

# 外す
RTMVP_BASIC_USER=none sudo -E bash scripts/setup-nginx.sh mvp.example.jp
```

一度かけたら、次から指定しなくても維持される。かけたあとの preflight は
資格情報が要る。**利用者名だけを渡すと、パスワードは実行後に聞かれる:**

```bash
PREFLIGHT_BASIC=eigyo node scripts/preflight.mjs https://mvp.example.jp
```

パスワードが履歴にもプロセス一覧にも残らないので、こちらを使う。
`PREFLIGHT_BASIC=eigyo:パスワード` の形も通るが、`~/.bash_history` に平文で残る。

**シェルの `read -rs` でパスワードを読む形にはしないこと。**

```bash
# こう書いてはいけない
read -rs PW && PREFLIGHT_BASIC="eigyo:$PW" node scripts/preflight.mjs https://mvp.example.jp
```

これを1行で貼り付けると、`read` が**後続のコマンド文字列をパスワードとして飲み込む。**
一度も入力していないのに全項目が401で落ち、「パスワードが違う」と表示される —
実際には認証設定は正しい。本番で実際に起きた。

**認証をかける範囲は2つだけ。** ここを広げてはいけない:

| 経路 | 認証 | 理由 |
|---|---|---|
| PWA本体 (`/`) | かける | 無認証で開ける入口 |
| セッション作成 (`= /api/v1/sessions`) | かける | 無認証で叩ける唯一のAPI |
| セッション操作 (`/api/`の残り) | **かけない** | PWAが `Authorization: Bearer` を送る。Authorizationヘッダは1つしか無いのでBasic認証と奪い合いになり、**録音は始まるのに議事録が一切読めなくなる**(実測で確認済み) |
| 生成MVP (`/preview/`) | **かけない** | QRを読んだ直後にパスワード入力が挟まると、商談の流れが切れる。プレビュー用トークン(操作用とは別の値)で守られており、これで開けるのは生成された試作品だけ。議事録も文字起こしも読めない |
| 音声 (`/ws/`) | **かけない** | セッショントークンで検証済み。WebSocketのハンドシェイクにBasic認証が乗るかはブラウザ依存 |
| `/healthz` | **かけない** | 監視用 |

`setup-nginx.sh` がやること:

- 既存設定を**読むだけ**で確認し、そのドメインを既に名乗る server があれば触らずに止まる
- `/etc/nginx` を丸ごと控えてから、新しいファイルを1つだけ足す
- `default_server` は付けない。IPv6の待ち受けは**既存設定が張れているときだけ**真似る
  (IPv6を持たないホストで `listen [::]:80` を書くと `nginx -t` ごと落ちるため)
- `nginx -t` が通らなければ、足した設定を自分で取り消してから止まる
- 証明書は取得済みなら取り直さず、設定へ入れ直す(再実行でHTTPSが落ちない)

### 止まって見えるとき

`setup-vps.sh` の手順1で長く止まることがある。**別のSSH窓**から確認する:

```bash
ps -eo pid,etime,cmd | grep -E "apt|dpkg|npm" | grep -v grep
fuser -v /var/lib/dpkg/lock-frontend
```

| 出るもの | 何が起きているか | どうするか |
|---|---|---|
| `needrestart/apt-pinvoke` | **これが一番多い。** 「どのサービスを再起動しますか」を対話で聞いて待っている | スクリプトが `NEEDRESTART_SUSPEND=1` で止める。既に詰まっているなら `kill <PID>` |
| `unattended-upgrades` が `apt` のロックを握っている | 初回起動直後のUbuntuが自動更新中 | 終わるまで待つ。スクリプトは最大10分待ってから諦める |
| 何も出ないのに進まない | IPv6が張られているのに外へ出られず、apt/curlが待っている | スクリプトが検出してIPv4に固定する。手で直すなら `echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4` |
| `npm ci` が動いている | 正常。依存関係の取得に数分かかる | 待つ |

`needrestart` は `| tee` でログを取っていても待ちに入る。`$is_tty` の判定が
`(-t STDERR || -t STDOUT || -t STDIN)` で、**標準入力が端末のままなら対話モードになる**ため
(`/usr/sbin/needrestart` 50行目)。更新待ちが溜まったサーバーで実際に1時間36分止まった。

止まった apt を片付けてからやり直す:

```bash
kill <apt のPID>                    # 元の窓は Ctrl-C
export NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive
dpkg --configure -a
apt-get -f install -y
```

以下は、中で何をしているかを読みたいとき・手で進めたいときのための説明。

## 1. 事前準備

- Xserver VPS: Ubuntu 24.04(22.04でも可)、メモリ2GB以上
  (推論・音声処理は外部APIへ委譲する設計なので2GBで足りる。ARCHITECTURE.md)
- DNSのAレコードが引けること: `dig +short mvp.example.jp`

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git nginx ufw

# Node 22(NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
node -v   # v22.x

# ファイアウォール: 22/80/443 だけ開ける。8787は開けない
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 2. アプリの配置とビルド

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin rtmvp
sudo mkdir -p /opt/rt-mvp /var/lib/rt-mvp
sudo chown rtmvp:rtmvp /opt/rt-mvp /var/lib/rt-mvp

sudo -u rtmvp git clone https://github.com/akiijauto/self-evolving-ai-public.git /opt/rt-mvp/src
cd /opt/rt-mvp/src/real_time_ai_mvp_project
sudo -u rtmvp npm ci
sudo -u rtmvp npm run build          # app/dist が生成される
```

サーバーはビルド工程なし(tsx直実行)。PWAだけ `vite build` が要る。

## 3. 環境変数

**APIキーはリポジトリにも生成物にも含めない**(SECURITY方針)。
サーバー側の環境変数ファイルだけに置き、root以外から読めなくする。

```bash
sudo mkdir -p /etc/rt-mvp
sudo tee /etc/rt-mvp/env > /dev/null <<'EOF'
HOST=127.0.0.1
PORT=8787
DATA_DIR=/var/lib/rt-mvp/data
LOG_DIR=/var/lib/rt-mvp/logs

# 同一オリジン配信なのでCORSの許可リストは空でよい
CORS_ORIGINS=

# ── 実APIを使うとき(キーは自分の値に)───────────
SPEECH_PROVIDER=deepgram
DEEPGRAM_API_KEY=書き換える
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=書き換える

# 生成をLLMに任せる。**先に scripts/verify-codegen.mts を通すこと**(下記)
CODE_PROVIDER=llm
# CODE_ATTEMPTS は既定(3)のままでよい。実測では3往復しても承認からURLまで
# 約4分20秒で、10分の予算に5分以上残る(AGENTS.md「承認からURLまでの時間予算」)
EOF
sudo chmod 600 /etc/rt-mvp/env
```

キー未設定のまま起動しても落ちない。mockプロバイダのまま動き、
画面は縮退表示(「AIが停止しています」)になるだけで録音は続く。

起動ログで、実際にどのモデルが使われるかを確認できる。`defaultModel` は
指定の無いAgentの既定値であって、実行の中身ではない。**費用と所要時間を支配するのは
`agentModels` にある `claude-opus-5`(requirement / code / review)のほう。**

```bash
sudo journalctl -u rt-mvp -n 30 --no-pager | grep -E "llm.provider|code.provider|speech.provider"
```

### `CODE_PROVIDER=llm` にする前の検証(必須)

雛形と違い、LLM生成は**応答が期待した形で返るとは限りません**。ファイルを取り出せない、
`index.html` が無い、外部CDNを参照する、といった失敗が商談中に起きると、
そこで試作品が出せなくなります。切り替える前に必ず一度通してください。

```bash
cd /opt/rt-mvp/src/real_time_ai_mvp_project
sudo -u rtmvp env ANTHROPIC_API_KEY="$(sudo sed -n 's/^ANTHROPIC_API_KEY=//p' /etc/rt-mvp/env)" \
  npx tsx scripts/verify-codegen.mts
```

`>>> CODE_PROVIDER=llm で商談に出せます <<<` が出れば通っています(終了コード0)。
このスクリプトは**サーバーが本番で使う実装そのもの**(`LLMCodeProvider`・検証層・
Review Agent のプロンプト)を読み込んで動かすので、写しではありません。
1回で $0.3 ほどかかります。見本の要件定義を使い、**商談の実データは投入しません。**

失敗したら `CODE_PROVIDER=template` のままにしてください。雛形は推論しないぶん、
必ず動くものが出ます。

## 4. systemd

```bash
sudo tee /etc/systemd/system/rt-mvp.service > /dev/null <<'EOF'
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
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now rt-mvp
curl -s http://127.0.0.1:8787/healthz   # {"ok":true,...} が返ること
```

再起動しても、セッションのメタ情報(トークン)は
`DATA_DIR/session-meta/` から読み戻される。実行中だった商談は
`server_restart` で終了扱いになる(録音は再開しない)が、
Markdownの閲覧とZIP持ち帰りはそのままできる。

## 5. nginx + TLS

> ⚠️ **既にnginxが動いているサーバーへ入れる場合は、先にここを読む。**
>
> この手順は「まっさらなVPS」を前提に書いてある。**すでに別のサイトが動いている
> サーバーで手順をそのままなぞると、動いているものを落としかねない。**
> まず今の状態を確かめる:
>
> ```bash
> ls -l /etc/nginx/sites-enabled/          # 何が有効になっているか
> sudo nginx -T | grep -E "server_name|listen|ssl_certificate " | head -40
> sudo certbot certificates                # 既に取得済みの証明書
> ```
>
> 確認すること:
>
> - **`default_server` が既にある場合、こちらの設定に付けない。** 同じ `listen` に
>   2つあると nginx が起動しなくなる
> - **`server_name` を必ず書く。** 書かないと最初のserverブロックが拾ってしまい、
>   既存サイトへのアクセスがこちらへ流れる
> - **既存の設定ファイルは触らない。** 新しいファイルを1つ足すだけにする
>
> 反映は必ず2段階で。`nginx -t` が通らないまま `reload` しない:
>
> ```bash
> sudo cp -a /etc/nginx /etc/nginx.bak.$(date +%Y%m%d)   # 戻せるようにする
> sudo nginx -t && sudo systemctl reload nginx
> ```
>
> `certbot --nginx -d <新しいサブドメイン>` は既存の証明書に影響しない
> (ドメインごとに別の証明書として発行される)。
>
> **`scripts/setup-nginx.sh` はここに書いた確認を全部やってから設定を足す。**
> 手で進めるより取りこぼしが少ない。
>
> `listen [::]:80` を無条件に書かないこと。IPv6を持たないホストでは
> `nginx -t` ごと落ち、**その状態で reload すると既存サイトも止まる**
> (nginx 1.24.0 で実際に再現した)。既存設定が `[::]:80` を張れているときだけ書く。


```bash
sudo tee /etc/nginx/sites-available/rt-mvp > /dev/null <<'EOF'
server {
    listen 80;
    # server_name は必ず書く。省略すると既存サイトへのアクセスまで拾ってしまう。
    # 既に default_server がある場合、ここには付けない
    server_name mvp.example.jp;

    # certbot がこの server を書き換えて 443 を足す

    root /opt/rt-mvp/src/real_time_ai_mvp_project/app/dist;
    index index.html;

    # HTTPのAPI。本文はMarkdown全文置換の1MBが最大なので2mで十分
    client_max_body_size 2m;

    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:8787;
    }

    # 音声のWebSocket。商談1件ぶん張りっぱなしになるので読みタイムアウトを長く
    location /ws/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 生成MVPの配信(顧客のスマホが開く)。Cookie認証はGateway側で行う
    location /preview/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # それ以外はPWA
    location / {
        try_files $uri /index.html;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/rt-mvp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Let's Encrypt
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d mvp.example.jp
```

certbot が 443 の server ブロックと 80→443 のリダイレクトを自動で足す。
更新も `certbot.timer` が面倒を見る(`sudo certbot renew --dry-run` で確認)。

## 6. 動作確認

1. `https://mvp.example.jp/healthz` → `{"ok":true}`
2. PWAを開いてマイク許可 → 録音開始 → 文字起こしがタブに出る
3. 「**この内容でアプリを作って**みましょう」→ 承認ダイアログに議事録が出る → 「作る」
   (拾われる言い回しは `server/src/agents/trigger.ts` の一覧が正本。
   「試しに作ってみましょう」のような言い方は**拾われない**)
4. QRを **自分のスマホの実機カメラ** で読んで `/preview/...` が開くこと
5. `sudo systemctl restart rt-mvp` 後も、終了した商談のMarkdownが読めること

## 7. 更新

```bash
cd /opt/rt-mvp/src
sudo -u rtmvp git pull
cd real_time_ai_mvp_project
sudo -u rtmvp npm ci && sudo -u rtmvp npm run build
sudo systemctl restart rt-mvp
```

商談の直前には更新しない。更新はセッションを `server_restart` で落とす。

## 8. バックアップと保持

- 消えて困るのは `/var/lib/rt-mvp/data`(Markdown・セッションメタ・生成物)と
  `/var/lib/rt-mvp/logs` だけ。音声データは設計上そこに**存在しない**ので小さい
- Markdownは30日で自動削除(`DOCUMENT_RETENTION_MS`)。それより長く残したいものは
  商談後にZIP(`export.zip`)で持ち帰る運用にする

## 9. 守ること

- `HOST=127.0.0.1` を変えない。Gatewayを直接インターネットへ出さない
- `/etc/rt-mvp/env` の権限は600のまま。キーをリポジトリへ書き戻さない
- 商談では実データ(顧客名・実在の数値)を投入しない(運用ルール)
- セッション作成は既定 30回/時間 に制限される(`SESSION_CREATE_LIMIT`)。
  展示会など連続商談で足りなければ引き上げる
