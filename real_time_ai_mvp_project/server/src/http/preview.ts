import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, extname, sep } from "node:path";
import type { LocalStaticDeployProvider } from "../deploy/localStaticDeployProvider.js";
import { log } from "../log.js";
import type { SessionStore } from "../sessions/store.js";

/**
 * 生成MVPの配信。ARCHITECTURE.md の「生成MVPの配信」に対応する。
 *
 * ```
 * GET /preview/{sessionId}/{buildId}/*
 * ```
 *
 * **プレビュー用トークンを持つアクセスだけを通す。**
 * 初回は `?t=<previewToken>` を付けて開き、以降はCookieで通す。
 * ページ内のCSSや画像に毎回クエリを付けるのは現実的でないため。
 *
 * ここで使うトークンは操作用(API / WebSocket)とは別物。このURLはQRコードとして
 * 画面に映り、顧客の端末の履歴にも残るので、**写真1枚から商談の全文が読めては困る。**
 */

const PREVIEW_PATH = /^\/preview\/([^/]+)\/([^/]+)(\/.*)?$/;

/** Cookieは preview 配下だけに限る。APIのトークンとは別の入口にしない */
const COOKIE = "rt_preview";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export async function handlePreview(
  req: IncomingMessage,
  res: ServerResponse,
  store: SessionStore,
  deploy: LocalStaticDeployProvider,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = PREVIEW_PATH.exec(url.pathname);
  if (!match) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }

  const sessionId = match[1] as string;
  const buildId = match[2] as string;
  const rest = match[3] ?? "/";

  const token = url.searchParams.get("t") ?? cookieToken(req);
  // 終了済みでも見せる。商談後に開き直せなければ意味がない。
  // 拒むのは、トークンが違うときと有効期限が切れたとき
  if (store.verify(sessionId, token, { allowEnded: true, purpose: "preview" }) !== "ok") {
    log.warn("preview.rejected", { sessionId, buildId, hasToken: token !== null });
    deny(res);
    return true;
  }

  let dir: string;
  try {
    dir = deploy.dirOf(sessionId, buildId);
  } catch {
    notFound(res);
    return true;
  }

  const relative = normalize(decodeURIComponent(rest));
  let target = join(dir, relative);
  // normalize のあとに確かめる。`..` を含む要求はここで落ちる。
  // 区切りは `/` 決め打ちにしない(Windowsでは `\`。全要求が404になる)
  if (target !== dir && !target.startsWith(dir + sep)) {
    notFound(res);
    return true;
  }

  let size: number;
  try {
    let stats = await stat(target);
    if (stats.isDirectory()) {
      // ディレクトリを指されたら index.html を返す
      target = join(target, "index.html");
      stats = await stat(target);
    }
    size = stats.size;
  } catch {
    notFound(res);
    return true;
  }

  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(size),
    // 生成物は商談ごとに変わる。古いものを掴ませない
    "cache-control": "no-store",
    // 生成コードは外部を参照しない。ブラウザ側でも閉じておく。
    //
    // `connect-src 'none'` は fetch/XHR/sendBeacon を止めるが、
    // **フォーム送信と <base> の差し替えは止めない。** 生成コードは商談の会話から
    // 作られるので、外へ出す経路は正規表現の検査ではなくCSPで塞ぐ
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; " +
      "form-action 'none'; base-uri 'none'; object-src 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };

  // クエリで来たトークンをCookieへ移す。以降の読み込みはクエリ無しで通る
  if (url.searchParams.has("t")) {
    // Secure を落とさない。この Cookie はプレビューを開く鍵そのもので、
    // 平文HTTPへ一度でも誘導されれば送信されてしまう。
    // 開発中(http://localhost)だけは付けないと Cookie が保存されない
    const secure = isSecureRequest(req) ? " Secure;" : "";
    headers["set-cookie"] =
      `${COOKIE}=${encodeURIComponent(url.searchParams.get("t") ?? "")}; ` +
      `Path=/preview/${sessionId}/;${secure} HttpOnly; SameSite=Lax`;
  }

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  createReadStream(target).pipe(res);
  return true;
}

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (raw === undefined) return null;

  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

/**
 * HTTPSで届いたリクエストか。
 * 本番はnginxがTLSを終端するので、直接の接続ではなく転送ヘッダを見る。
 */
function isSecureRequest(req: IncomingMessage): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  if (proto !== undefined) return proto === "https";
  // 転送ヘッダが無い = プロキシを介していない。Node自身がTLSを張っているかで判断する
  return "encrypted" in req.socket;
}

function deny(res: ServerResponse): void {
  const body = "このURLを開くにはセッションのトークンが必要です。";
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("見つかりません");
}
