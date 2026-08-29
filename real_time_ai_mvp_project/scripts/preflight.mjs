#!/usr/bin/env node
/**
 * 商談前の疎通確認。VPS構築の直後と、商談当日の朝に走らせる。
 *
 *   node scripts/preflight.mjs https://mvp.example.jp
 *
 * 「商談中に初めて気づく」類の設定漏れを、機械的に先に見つけることが目的。
 * 何も壊さない(セッションは作るが、その場で終了させる)。
 */

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (base === "") {
  console.error("使い方: node scripts/preflight.mjs https://mvp.example.jp");
  process.exit(2);
}

/**
 * 端末から直接パスワードを読む。**`read -rs` をシェルで使わせない。**
 *
 * `read -rs PW && PREFLIGHT_BASIC=... node ...` を1行で貼り付けると、
 * `read` が**後続のコマンド文字列をパスワードとして飲み込む。**
 * 利用者は一度も入力していないのに全項目が401で落ち、
 * 「パスワードが違う」と表示される — 実際には認証設定は正しい。
 * 本番で実際に起きた。
 *
 * `/dev/tty` から読むので、パイプやリダイレクトの影響も受けない。
 */
function askPassword(user) {
  let fd;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    console.error(
      `PREFLIGHT_BASIC に利用者名だけが指定されていますが、端末がないため入力を求められません。\n` +
        `  PREFLIGHT_BASIC=${user}:パスワード の形で渡してください`,
    );
    process.exit(2);
  }

  writeSync(fd, `${user} のパスワード: `);
  // 打った文字を画面に出さない。stty が無い環境では素通しにする(入力は続行できる)
  const stty = (arg) => {
    try {
      execFileSync("stty", [arg], { stdio: [fd, "ignore", "ignore"] });
      return true;
    } catch {
      return false;
    }
  };
  const muted = stty("-echo");

  const buffer = Buffer.alloc(1);
  const chars = [];
  for (;;) {
    let read;
    try {
      read = readSync(fd, buffer, 0, 1, null);
    } catch {
      break;
    }
    if (read === 0) break;
    const ch = buffer[0];
    if (ch === 0x0a || ch === 0x0d) break;
    chars.push(ch);
  }

  if (muted) stty("echo");
  writeSync(fd, "\n");
  closeSync(fd);
  return Buffer.from(chars).toString("utf8");
}

// nginx側で Basic 認証をかけている場合。かけていなければ空のまま。
//
//   PREFLIGHT_BASIC=eigyo node scripts/preflight.mjs https://mvp.example.jp
//     → パスワードは実行後に聞く(履歴にもプロセス一覧にも残らない。**こちらを使う**)
//
//   PREFLIGHT_BASIC=eigyo:パスワード node scripts/preflight.mjs https://mvp.example.jp
//     → 対話できない場面(cron 等)向け。~/.bash_history に平文で残る
//
// QRで開く /preview/ と、音声の /ws/ には認証をかけない設計なので、
// ここで要るのは PWA と /api/ の分だけ。
const rawBasic = process.env.PREFLIGHT_BASIC ?? "";
const basic =
  rawBasic !== "" && !rawBasic.includes(":") ? `${rawBasic}:${askPassword(rawBasic)}` : rawBasic;
const authHeaders = basic
  ? { authorization: `Basic ${Buffer.from(basic, "utf8").toString("base64")}` }
  : {};

/** 認証情報を毎回付ける。付け忘れると認証をかけた瞬間に全項目が落ちる */
const get = (url, init = {}) =>
  fetch(url, { ...init, headers: { ...authHeaders, ...(init.headers ?? {}) } });

/** Basic認証で弾かれたのか、本当に壊れているのかを取り違えないための注記 */
const authHint = (res) =>
  res.status === 401 && (res.headers.get("www-authenticate") ?? "").toLowerCase().includes("basic")
    ? basic
      ? " ← Basic認証の利用者名かパスワードが違う"
      : " ← Basic認証がかかっている。PREFLIGHT_BASIC=利用者名 を付けて実行する(パスワードは後で聞かれる)"
    : "";

const results = [];
const record = (name, ok, detail, fatal = true) =>
  results.push({ name, ok, detail, fatal });

const timeout = (ms) => AbortSignal.timeout(ms);

// ── 1. HTTPS でなければマイクもPWAも動かない ──────────────
{
  const isHttps = base.startsWith("https://");
  record(
    "HTTPSで配信されている",
    isHttps,
    isHttps
      ? "OK"
      : "http:// では getUserMedia が使えず、PWAもインストールできない。TLSを先に通すこと",
  );

  if (isHttps) {
    // http でアクセスしたときに https へ送られるか(営業担当が手打ちする経路)
    try {
      const plain = base.replace("https://", "http://");
      const res = await get(plain, { redirect: "manual", signal: timeout(8000) });
      const location = res.headers.get("location") ?? "";
      record(
        "http:// から https:// へ転送される",
        res.status >= 300 && res.status < 400 && location.startsWith("https://"),
        `status=${res.status} location=${location || "(なし)"}`,
        false,
      );
    } catch (error) {
      record("http:// から https:// へ転送される", false, String(error), false);
    }
  }
}

// ── 2. Gateway が生きているか ──────────────────────────
let healthOk = false;
try {
  const res = await get(`${base}/healthz`, { signal: timeout(8000) });
  const body = await res.json();
  healthOk = res.ok && body.ok === true;
  // 稼働セッション数は外からは返らない(商談の有無を観測させないため)
  record("Gateway が応答する (/healthz)", healthOk, `status=${res.status}`);
} catch (error) {
  record("Gateway が応答する (/healthz)", false, String(error));
}

// ── 3. PWA が配信されているか ─────────────────────────
//
// nginx は `try_files $uri /index.html` で未知のパスをPWAへ落とす。
// つまり **配置し忘れたファイルも 200 で返る。** 中身まで見ないと気づけない。
for (const [name, path, check] of [
  ["PWA本体が返る", "/", (text) => text.includes("<div id=\"root\"") || text.includes("<script")],
  ["manifest が返る", "/manifest.webmanifest", (text) => text.includes("start_url")],
  [
    "Service Worker が返る",
    "/sw.js",
    (text) =>
      text.length > 0 &&
      // HTMLが返っていたら、それは index.html への落ち先。sw.js は配置されていない
      !/^\s*(<!doctype|<html)/i.test(text),
  ],
]) {
  try {
    const res = await get(`${base}${path}`, { signal: timeout(8000) });
    const text = await res.text();
    const ok = res.ok && check(text);
    // nginx のエラーページも <html> で始まる。成功応答のときだけ
    // 「index.html への落ち先」と判断しないと、401に誤った注記が付く
    const fellBack = res.ok && path !== "/" && /^\s*(<!doctype|<html)/i.test(text);
    record(
      name,
      ok,
      `status=${res.status} ${text.length}バイト` +
        (fellBack ? " ← index.html が返っている(ファイルが配置されていない)" : "") +
        authHint(res),
    );
  } catch (error) {
    record(name, false, String(error));
  }
}

// ── 4. セッションを作り、wsUrl が wss になるか ─────────────
let session = null;
if (healthOk) {
  try {
    const res = await get(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "preflight", clientInfo: "preflight script" }),
      signal: timeout(10000),
    });
    // 401はnginxがHTMLを返す。先にJSONへ通すと解析例外になり、
    // 「Basic認証で弾かれた」という肝心の理由が出なくなる
    if (!res.ok) {
      record("セッションを作成できる", false, `status=${res.status}${authHint(res)}`);
    } else {
      session = await res.json();

      record(
        "セッションを作成できる",
        res.status === 201 && Boolean(session.token),
        `status=${res.status}`,
      );
      record(
        "wsUrl が wss:// になっている",
        typeof session.wsUrl === "string" && session.wsUrl.startsWith("wss://"),
        `wsUrl=${session.wsUrl}` +
          (session.wsUrl?.startsWith("ws://")
            ? " ← リバースプロキシの X-Forwarded-Proto が渡っていない"
            : ""),
      );
    }
  } catch (error) {
    record("セッションを作成できる", false, String(error));
  }
}

// ── 5. WebSocket が Upgrade されるか(音声の経路) ──────────
if (session?.wsUrl) {
  const ok = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      // Node 22 の組み込み WebSocket を使う。追加の依存を持たない
      const ws = new WebSocket(`${session.wsUrl}?token=${encodeURIComponent(session.token)}`);
      ws.addEventListener("open", () => {
        ws.close();
        done({ ok: true, detail: "接続できた" });
      });
      ws.addEventListener("error", () => done({ ok: false, detail: "接続に失敗した" }));
      ws.addEventListener("close", (event) =>
        done({ ok: false, detail: `閉じられた code=${event.code}` }),
      );
      setTimeout(() => done({ ok: false, detail: "10秒で応答なし" }), 10_000);
    } catch (error) {
      done({ ok: false, detail: String(error) });
    }
  });

  record(
    "WebSocket が繋がる(音声の経路)",
    ok.ok,
    ok.ok
      ? ok.detail
      : `${ok.detail} ← nginx の Upgrade / Connection ヘッダ設定を確認すること`,
  );
}

// ── 6. 認証が効いているか ────────────────────────────
if (session?.sessionId) {
  try {
    const res = await get(`${base}/api/v1/sessions/${session.sessionId}/documents`, {
      headers: { authorization: "Bearer wrong-token" },
      signal: timeout(8000),
    });
    record("不正なトークンが弾かれる", res.status === 401, `status=${res.status}`);
  } catch (error) {
    record("不正なトークンが弾かれる", false, String(error));
  }

  // 後片付け。preflight のセッションを残さない
  try {
    await get(`${base}/api/v1/sessions/${session.sessionId}/end`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ reason: "button" }),
      signal: timeout(8000),
    });
  } catch {
    // 終了できなくても preflight の判定には影響しない
  }
}

// ── 出力 ──────────────────────────────────────────
console.log(`\npreflight: ${base}\n`);
let failed = 0;
for (const result of results) {
  const mark = result.ok ? "  OK  " : result.fatal ? " NG   " : " 注意 ";
  console.log(`${mark} ${result.name}\n         ${result.detail}`);
  if (!result.ok && result.fatal) failed += 1;
}

console.log(
  failed === 0
    ? "\nすべて通りました。商談で使える状態です。\n"
    : `\n${failed}件が通っていません。商談で使う前に直してください。\n`,
);
process.exit(failed === 0 ? 0 : 1);
