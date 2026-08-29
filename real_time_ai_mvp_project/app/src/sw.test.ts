import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `app/public/sw.js` の fetch ハンドラの検証。
 *
 * sw.js はモジュールではなく Service Worker のグローバル(`self` / `caches` / `fetch` /
 * `Response`)に依存した素のスクリプトなので、それらを引数として渡して評価し、
 * `self.addEventListener` で登録されたハンドラを捕まえて直接呼ぶ。
 */

const ORIGIN = "https://demo.example";

const SW_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../public/sw.js"),
  "utf8",
);

type StubResponse = {
  /** どの応答が保存されたかを見分けるための目印 */
  body: string;
  ok: boolean;
  type: string;
  clone: () => StubResponse;
};

function makeResponse(body: string, ok = true, type = "basic"): StubResponse {
  return { body, ok, type, clone: () => makeResponse(body, ok, type) };
}

const ResponseStub = { error: () => makeResponse("network-error", false, "error") };

type StubRequest = { url: string; method: string; mode: string };

function makeRequest(path: string, mode = "no-cors", method = "GET"): StubRequest {
  return { url: new URL(path, ORIGIN).href, method, mode };
}

/** キーはURL文字列でも Request でも来るので、絶対URLに揃える(本物の Cache API と同じ) */
function cacheKey(request: string | StubRequest): string {
  return new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
}

function createCacheStorage() {
  const stores = new Map<string, Map<string, StubResponse>>();

  return {
    async open(name: string) {
      const entries = stores.get(name) ?? new Map<string, StubResponse>();
      stores.set(name, entries);
      return {
        async put(request: string | StubRequest, response: StubResponse) {
          entries.set(cacheKey(request), response);
        },
        async match(request: string | StubRequest) {
          return entries.get(cacheKey(request));
        },
        async addAll(urls: string[]) {
          for (const url of urls) entries.set(cacheKey(url), makeResponse(`precache:${url}`));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async match(request: string | StubRequest) {
      for (const entries of stores.values()) {
        const hit = entries.get(cacheKey(request));
        if (hit) return hit;
      }
      return undefined;
    },
    /** テストから中身を覗くため */
    peek(path: string): StubResponse | undefined {
      for (const entries of stores.values()) {
        const hit = entries.get(cacheKey(path));
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

/** 保存は respondWith の解決を待たずに走るので、マイクロタスクを流し切ってから確かめる */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadServiceWorker() {
  const caches = createCacheStorage();
  const listeners = new Map<string, (event: never) => void>();
  const requested: string[] = [];
  let network: (request: StubRequest) => Promise<StubResponse> = async () => {
    throw new Error("network の応答がテストで設定されていない");
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, handler: (event: never) => void) {
      listeners.set(type, handler);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const evaluate = new Function("self", "caches", "fetch", "Response", SW_SOURCE);
  evaluate(
    self,
    caches,
    (request: StubRequest) => {
      requested.push(request.url);
      return network(request);
    },
    ResponseStub,
  );

  function listener(type: string) {
    const handler = listeners.get(type);
    if (!handler) throw new Error(`${type} リスナーが登録されていない`);
    return handler as unknown as (event: unknown) => void;
  }

  return {
    caches,
    requested,
    /** ネットワークが返す応答を差し替える。reject させればオフライン */
    serve(handler: (request: StubRequest) => Promise<StubResponse>) {
      network = handler;
    },
    async install() {
      const pending: Promise<unknown>[] = [];
      listener("install")({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
      await Promise.all(pending);
    },
    /** respondWith されなければ null(= Service Worker が介入していない) */
    async fetch(request: StubRequest): Promise<StubResponse | null> {
      const captured: { response?: Promise<StubResponse> } = {};
      listener("fetch")({
        request,
        respondWith: (response: Promise<StubResponse>) => {
          captured.response = response;
        },
      });
      const result = captured.response ? await captured.response : null;
      await flush();
      return result;
    },
  };
}

/** インストール済み + `/` を一度開いてアプリシェルを保存した状態 */
async function warmed() {
  const sw = loadServiceWorker();
  sw.serve(async () => makeResponse("app-shell"));
  await sw.install();
  await sw.fetch(makeRequest("/", "navigate"));
  return sw;
}

describe("Service Worker: 生成MVP(/preview/)の素通し", () => {
  it("/preview/ へのナビゲーションは /index.html を汚さない", async () => {
    const sw = await warmed();
    expect(sw.caches.peek("/index.html")?.body).toBe("app-shell");

    sw.serve(async () => makeResponse("generated-mvp"));
    const response = await sw.fetch(makeRequest("/preview/sess-1/build-1/", "navigate"));

    expect(response).toBeNull();
    expect(sw.caches.peek("/index.html")?.body).toBe("app-shell");
  });

  it("/preview/ 配下のアセットはキャッシュされない", async () => {
    const sw = await warmed();

    sw.serve(async () => makeResponse("generated-app-js"));
    const response = await sw.fetch(makeRequest("/preview/sess-1/build-1/app.js"));

    expect(response).toBeNull();
    expect(sw.caches.peek("/preview/sess-1/build-1/app.js")).toBeUndefined();
  });

  it("/preview/ は Service Worker から fetch すらされない", async () => {
    const sw = await warmed();
    const before = sw.requested.length;

    await sw.fetch(makeRequest("/preview/sess-1/build-1/styles.css"));

    expect(sw.requested.length).toBe(before);
  });

  it("API と WebSocket も素通しする", async () => {
    const sw = await warmed();

    expect(await sw.fetch(makeRequest("/api/v1/sessions"))).toBeNull();
    expect(await sw.fetch(makeRequest("/ws/session"))).toBeNull();
    expect(sw.caches.peek("/api/v1/sessions")).toBeUndefined();
  });
});

describe("Service Worker: PWA本体のキャッシュ", () => {
  it("/ のナビゲーションは /index.html として保存される", async () => {
    const sw = loadServiceWorker();
    sw.serve(async () => makeResponse("app-shell"));
    await sw.install();

    const response = await sw.fetch(makeRequest("/", "navigate"));

    expect(response?.body).toBe("app-shell");
    expect(sw.caches.peek("/index.html")?.body).toBe("app-shell");
  });

  it("/index.html を直接開いた場合も保存される", async () => {
    const sw = loadServiceWorker();
    sw.serve(async () => makeResponse("app-shell-direct"));
    await sw.install();

    await sw.fetch(makeRequest("/index.html", "navigate"));

    expect(sw.caches.peek("/index.html")?.body).toBe("app-shell-direct");
  });

  it("オフラインでも / はキャッシュから返る", async () => {
    const sw = await warmed();

    sw.serve(async () => {
      throw new Error("offline");
    });
    const response = await sw.fetch(makeRequest("/", "navigate"));

    expect(response?.body).toBe("app-shell");
  });

  it("ハッシュ付きアセットは従来どおり cache-first で保存される", async () => {
    const sw = await warmed();

    sw.serve(async () => makeResponse("bundle"));
    expect((await sw.fetch(makeRequest("/assets/index-abc123.js")))?.body).toBe("bundle");
    expect(sw.caches.peek("/assets/index-abc123.js")?.body).toBe("bundle");

    // 2回目はネットワークに出ない
    const before = sw.requested.length;
    expect((await sw.fetch(makeRequest("/assets/index-abc123.js")))?.body).toBe("bundle");
    expect(sw.requested.length).toBe(before);
  });

  it("GET 以外と別オリジンには介入しない", async () => {
    const sw = await warmed();

    const crossOrigin = { url: "https://other.example/x.js", method: "GET", mode: "no-cors" };
    expect(await sw.fetch(makeRequest("/api-like", "no-cors", "POST"))).toBeNull();
    expect(await sw.fetch(crossOrigin)).toBeNull();
  });
});
