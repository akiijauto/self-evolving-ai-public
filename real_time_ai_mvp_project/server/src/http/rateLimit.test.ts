import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../sessions/store.js";
import { handleApi } from "./api.js";
import { SlidingWindowLimiter } from "./rateLimit.js";

describe("SlidingWindowLimiter", () => {
  it("窓の中では limit 回まで通す", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.retryAfterSeconds()).toBe(1);
  });

  it("窓が過ぎれば枠が戻る", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    now = 1_000;
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("limit 0 は無制限", () => {
    const limiter = new SlidingWindowLimiter({ limit: 0, windowMs: 1_000 });
    for (let i = 0; i < 100; i += 1) expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.retryAfterSeconds()).toBe(0);
  });
});

describe("POST /sessions の回数制限", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000 });
    server = createServer((req, res) => {
      void handleApi(req, res, store, undefined, undefined, limiter).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("ポートを取得できません");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function create(): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  it("上限を超えると 429 と Retry-After を返す", async () => {
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);

    const limited = await create();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("既存セッションへのアクセスは制限に巻き込まれない", async () => {
    const first = await create();
    const { sessionId, token } = (await first.json()) as { sessionId: string; token: string };
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(429);

    // 作成はもう塞がっているが、取得は通る
    const got = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.status).toBe(200);
  });
});
