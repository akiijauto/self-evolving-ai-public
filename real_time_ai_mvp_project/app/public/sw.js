/**
 * Service Worker — アプリシェルのオフラインキャッシュ。
 *
 * Sprint 1 の完了条件「オフラインで起動する」を満たすための最小実装。
 * 音声データやAPIレスポンスは一切キャッシュしない(Sprint 2以降も同様)。
 */

// v1 のキャッシュには生成MVPのHTMLやアセットが紛れ込んでいる可能性があるため、
// 名前を変えて activate 時に丸ごと捨てる。
const CACHE_NAME = "rt-mvp-shell-v2";

/** ビルド後に必ず存在するファイル。ハッシュ付きアセットは fetch 時に動的キャッシュする。 */
const SHELL_ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

/**
 * Service Worker が一切触らないパス。
 *
 * `/preview/` は商談中に生成したMVPの配信先で、サーバ側でセッショントークンを検証している。
 * Cache API は Cache-Control を見ないので、一度でも保存すると
 * セッション失効後や実体削除後もトークン検証を通らずに配信され続けてしまう。
 * `/api/` `/ws/` も同様に、キャッシュした応答を返してよい相手ではない。
 */
const BYPASS_PATH = /^\/(preview|api|ws)(\/|$)/;

/**
 * navigate の応答を `/index.html`(= PWA本体)として保存してよいURLか。
 *
 * 生成MVPも同じオリジンの `/preview/...` から配信されるため、URLを見ずに保存すると
 * 前回商談のデモアプリがPWA本体として残り、次のオフライン起動でそれが立ち上がる。
 */
function isAppShellNavigation(url) {
  return url.pathname === "/" || url.pathname === "/index.html";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PATH.test(url.pathname)) return;

  // ナビゲーションは network-first。オフライン時のみキャッシュにフォールバックする。
  if (request.mode === "navigate") {
    const isShell = isAppShellNavigation(url);
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isShell) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        // PWA本体以外のナビゲーションにアプリシェルを返すと別物が表示されるので、
        // フォールバックさせるのも本体のときだけにする。
        .catch(() =>
          isShell
            ? caches.match("/index.html").then((hit) => hit ?? Response.error())
            : Response.error(),
        ),
    );
    return;
  }

  // 静的アセットは cache-first。Viteのハッシュ付きファイル名が更新を保証する。
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
