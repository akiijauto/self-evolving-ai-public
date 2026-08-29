import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CloseCode, type ClientMessage, type ServerMessage } from "@rt-mvp/protocol";
import { AgentHistory } from "../agents/history.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { TemplateCodeProvider } from "../codegen/templateCodeProvider.js";
import { LocalStaticDeployProvider } from "../deploy/localStaticDeployProvider.js";
import { MockLLMProvider } from "../llm/mockLLMProvider.js";
import { MarkdownStore } from "../markdown/store.js";
import { SessionDocuments } from "../markdown/sessionDocuments.js";
import { handleApi } from "../http/api.js";
import { SessionStore } from "../sessions/store.js";
import {
  SpeechEmitter,
  type SpeechProvider,
  type SpeechStream,
} from "../speech/types.js";
import { attachGateway, sendToSession } from "./gateway.js";

/**
 * 実際にHTTPサーバーとWebSocketを立てて検証する結合テスト。
 * Sprint 2 の完了条件のうち、サーバー側で確かめられるものを網羅する。
 */

let server: Server;
let store: SessionStore;
let port: number;

beforeEach(async () => {
  store = new SessionStore({ ttlMs: 60_000 });
  server = createServer((req, res) => {
    void handleApi(req, res, store).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  attachGateway(server, store);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("ポートを取得できません");
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createSession(): Promise<{ sessionId: string; token: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "テスト商談" }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { sessionId: string; token: string };
  return body;
}

/**
 * 受信メッセージをバッファするテスト用クライアント。
 *
 * session.ready は接続直後に届くため、待ち受けを後から張ると取りこぼす。
 * 生成と同時に listener を張り、届いたものを溜めておく。
 */
class TestClient {
  readonly messages: ServerMessage[] = [];
  #closeCode: number | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.messages.push(JSON.parse(raw.toString("utf8")) as ServerMessage);
    });
    ws.on("close", (code: number) => {
      this.#closeCode = code;
    });
  }

  static connect(sessionId: string, token: string | null): TestClient {
    const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
    return new TestClient(new WebSocket(`ws://127.0.0.1:${port}/ws/v1/sessions/${sessionId}${query}`));
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  sendAudio(bytes: number): void {
    this.ws.send(Buffer.alloc(bytes));
  }

  /** 既に届いていればそれを返し、まだなら届くまで待つ */
  async waitFor<T extends ServerMessage["type"]>(
    type: T,
    timeoutMs = 3_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.messages.find((m) => m.type === type);
      if (hit) return hit as Extract<ServerMessage, { type: T }>;
      if (Date.now() > deadline) throw new Error(`${type} が届きませんでした`);
      await sleep(10);
    }
  }

  waitClose(timeoutMs = 3_000): Promise<number> {
    if (this.#closeCode !== null) return Promise.resolve(this.#closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("切断されませんでした")), timeoutMs);
      this.ws.once("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.ws.close();
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** サーバーが受信を処理し終えるのを待つ */
async function settle(): Promise<void> {
  await sleep(80);
}

const AUDIO = {
  mimeType: "audio/webm;codecs=opus",
  codec: "opus" as const,
  sampleRate: 48000,
  channels: 1,
  timesliceMs: 250,
};

describe("HTTP API", () => {
  it("セッションを作成し、wsUrl と token を返す", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await response.json()) as Record<string, string>;

    expect(response.status).toBe(201);
    expect(body.sessionId).toMatch(/^sess_/);
    expect(body.token).toBeTruthy();
    expect(body.wsUrl).toContain(`/ws/v1/sessions/${body.sessionId}`);
    expect(new Date(body.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("セッションの状態を取得できる", async () => {
    const { sessionId, token } = await createSession();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.status).toBe("active");
    expect(body.title).toBe("テスト商談");
    expect(body.audio).toEqual({ chunks: 0, bytes: 0, lastChunkAt: null });
  });

  it("トークンを漏らさない", async () => {
    const { sessionId, token } = await createSession();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await response.text()).not.toContain(token);
  });

  it("存在しないセッションは 404", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/sess_missing`);
    expect(response.status).toBe(404);
  });

  it("壊れたJSONは 400", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{壊れた",
    });
    expect(response.status).toBe(400);
  });

  it("healthz が応答する", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    // サーバー内から直接叩いたときは件数も返す。更新スクリプトが
    // 「商談中は更新しない」の判定に使う
    expect(await response.json()).toMatchObject({
      ok: true,
      sessions: expect.any(Number),
      // `sessions` は終了済みも数える。判定に使えるのはこちら
      active: expect.any(Number),
    });
  });

  it("healthz は外向きには稼働件数を返さない", async () => {
    // 無認証で読めるので、返すと商談をやっているかどうかが外から分かる。
    // nginx は転送時に X-Forwarded-For を付ける
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("同時接続", () => {
  it("後から来た接続が前の接続を切る", async () => {
    // 宣言だけで実際には切っていなかった。切らずに配信先だけ差し替えると、
    // 前の画面は「接続中」のまま更新だけが止まり、原因の分からない沈黙になる
    const { sessionId, token } = await createSession();
    const first = TestClient.connect(sessionId, token);
    await first.open();
    await first.waitFor("session.ready");

    const second = TestClient.connect(sessionId, token);
    await second.open();
    await second.waitFor("session.ready");

    expect(await first.waitClose()).toBe(CloseCode.SUPERSEDED);
    second.close();
  });
});

describe("WebSocket 認証", () => {
  it("正しいトークンで接続でき、session.ready が届く", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();

    const ready = await client.waitFor("session.ready");
    expect(ready.sessionId).toBe(sessionId);
    expect(ready.status).toBe("active");
    client.close();
  });

  it("不正なトークンは 4401 で切られる(完了条件)", async () => {
    const { sessionId } = await createSession();
    const client = TestClient.connect(sessionId, "wrong-token");
    expect(await client.waitClose()).toBe(CloseCode.UNAUTHORIZED);
  });

  it("トークンなしも 4401", async () => {
    const { sessionId } = await createSession();
    const client = TestClient.connect(sessionId, null);
    expect(await client.waitClose()).toBe(CloseCode.UNAUTHORIZED);
  });

  it("存在しないセッションは 4404", async () => {
    const client = TestClient.connect("sess_missing", "any");
    expect(await client.waitClose()).toBe(CloseCode.NOT_FOUND);
  });

  it("終了済みセッションは 4409", async () => {
    const { sessionId, token } = await createSession();
    store.end(sessionId, "button");
    const client = TestClient.connect(sessionId, token);
    expect(await client.waitClose()).toBe(CloseCode.ENDED);
  });

  it("パスが違えば接続を受け付けない", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/nope`);
    await new Promise<void>((resolve) => {
      ws.once("error", () => resolve());
      ws.once("close", () => resolve());
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("音声チャンクの受信", () => {
  it("start 後のチャンクを記録する(完了条件: 連続して届く)", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.send({ type: "start", audio: AUDIO });
    for (let i = 0; i < 5; i += 1) client.sendAudio(100);
    await settle();

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { audio: { chunks: number; bytes: number } };
    expect(body.audio.chunks).toBe(5);
    expect(body.audio.bytes).toBe(500);
    client.close();
  });

  it("start 前のチャンクは拒否する", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.sendAudio(100);

    const error = await client.waitFor("error");
    expect(error.code).toBe("not_started");
    expect(store.get(sessionId)?.chunks).toBe(0);
    client.close();
  });

  it("pause 中のチャンクは破棄する(完了条件: pause 中は送られない)", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.send({ type: "start", audio: AUDIO });
    client.sendAudio(100);
    await settle();

    client.send({ type: "pause" });
    client.sendAudio(100);

    const error = await client.waitFor("error");
    expect(error.code).toBe("unexpected_audio");
    expect(store.get(sessionId)?.chunks).toBe(1);
    client.close();
  });

  it("resume 後は再び受け付ける", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.send({ type: "start", audio: AUDIO });
    client.send({ type: "pause" });
    client.send({ type: "resume" });
    client.sendAudio(100);
    await settle();

    expect(store.get(sessionId)?.chunks).toBe(1);
    client.close();
  });
});

describe("制御メッセージ", () => {
  it("ping に pong を返す", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();

    client.send({ type: "ping" });
    await client.waitFor("pong");
    client.close();
  });

  it("stop でセッションが終了し、正常コードで閉じる", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.send({ type: "stop", reason: "button" });

    const ended = await client.waitFor("session.ended");
    expect(ended.reason).toBe("button");
    expect(await client.waitClose()).toBe(CloseCode.NORMAL);
    expect(store.get(sessionId)?.status).toBe("ended");
  });

  it("解釈できないメッセージはエラーを返すが切断しない", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.ws.send("{壊れた");

    const error = await client.waitFor("error");
    expect(error.code).toBe("bad_message");
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("未実装の type もエラーとして扱う(Sprint 6 の confirm_generate など)", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.ws.send(JSON.stringify({ type: "confirm_generate", jobId: "job_1" }));

    expect((await client.waitFor("error")).code).toBe("bad_message");
    client.close();
  });
});

describe("再接続", () => {
  it("切断後に同じトークンで繋ぎ直せる(完了条件)", async () => {
    const { sessionId, token } = await createSession();

    const first = TestClient.connect(sessionId, token);
    await first.open();
    await first.waitFor("session.ready");
    first.send({ type: "start", audio: AUDIO });
    first.sendAudio(100);
    await settle();
    first.close();
    await first.waitClose();

    const second = TestClient.connect(sessionId, token);
    await second.open();
    const ready = await second.waitFor("session.ready");

    // 統計が引き継がれている = セッションが継続している
    expect(ready.audio.chunks).toBe(1);

    second.send({ type: "start", audio: AUDIO });
    second.sendAudio(200);
    await settle();

    expect(store.get(sessionId)?.chunks).toBe(2);
    expect(store.get(sessionId)?.bytes).toBe(300);
    second.close();
  });

  it("再接続時に一時停止は引き継がない", async () => {
    const { sessionId, token } = await createSession();

    const first = TestClient.connect(sessionId, token);
    await first.open();
    first.send({ type: "start", audio: AUDIO });
    first.send({ type: "pause" });
    await settle();
    first.close();
    await first.waitClose();

    const second = TestClient.connect(sessionId, token);
    await second.open();
    await second.waitFor("session.ready");
    second.send({ type: "start", audio: AUDIO });
    second.sendAudio(100);
    await settle();

    expect(store.get(sessionId)?.chunks).toBe(1);
    second.close();
  });
});

describe("再接続時のジョブ状態の復元", () => {
  // 確認UI・進捗・完成通知はWSで一度しか流れない。タブレットのブラウザは
  // バックグラウンドのタブを破棄するため、リロード後に消えたままだと
  // 営業担当に打つ手が無くなる(本番のタブレットで実際に起きた)
  let dataDir: string;
  let docs: SessionDocuments;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    // 既定のサーバー(orchestratorなし)を、フル構成で立て直す
    await new Promise<void>((resolve) => server.close(() => resolve()));
    dataDir = await mkdtemp(join(tmpdir(), "rt-mvp-gw-"));
    const markdown = new MarkdownStore({ dataDir });
    docs = new SessionDocuments(markdown);
    orchestrator = new Orchestrator({
      docs,
      llm: new MockLLMProvider(),
      code: new TemplateCodeProvider(),
      deploy: new LocalStaticDeployProvider({ dataDir }),
      history: new AgentHistory(markdown),
      notify: sendToSession,
      intervalMs: 60_000,
      thresholdChars: 400,
    });
    server = createServer((req, res) => {
      void handleApi(req, res, store, docs, orchestrator).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    attachGateway(server, store, undefined, docs, orchestrator);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("ポートを取得できません");
    port = address.port;
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("承認待ちのまま接続し直すと、確認を出し直す", async () => {
    const { sessionId, token } = await createSession();
    const session = store.get(sessionId);
    if (!session) throw new Error("セッションがありません");

    const first = TestClient.connect(sessionId, token);
    await first.open();
    await first.waitFor("session.ready");
    orchestrator.proposeGeneration(session, "アプリ作って");
    await first.waitFor("trigger.detected");
    first.close();
    await first.waitClose();

    const second = TestClient.connect(sessionId, token);
    await second.open();
    const detected = await second.waitFor("trigger.detected");
    expect(detected.phrase).toBe("アプリ作って");
    // 応答すれば通常どおり走り出せる
    expect(orchestrator.resolveProposal(session, detected.jobId, false)?.status).toBe("cancelled");
    second.close();
    // 裏で走る議事録の書き込みを待つ。後片付けと競合させない
    await sleep(120);
  });

  it("生成が終わったあとに接続し直すと、完成通知を出し直す", async () => {
    const { sessionId, token } = await createSession();
    const session = store.get(sessionId);
    if (!session) throw new Error("セッションがありません");
    await docs.appendTranscript(session, {
      seq: 1,
      text: "在庫はExcelで管理していて、担当者しか触れない状態です。",
      speaker: "A",
      startMs: 0,
      endMs: 4_000,
      at: new Date().toISOString(),
    });

    const job = orchestrator.startGeneration(session);
    const deadline = Date.now() + 5_000;
    while (orchestrator.jobOf(sessionId, job.jobId)?.status !== "succeeded") {
      if (Date.now() > deadline) throw new Error("生成が終わりませんでした");
      await sleep(20);
    }

    const client = TestClient.connect(sessionId, token);
    await client.open();
    const progress = await client.waitFor("job.progress");
    expect(progress.status).toBe("succeeded");
    const artifact = await client.waitFor("artifact.ready");
    expect(artifact.buildId).toBeTruthy();
    expect(artifact.url).toBeTruthy();
    expect(artifact.previewToken).toBe(session.previewToken);
    client.close();
  });

  it("確認に応答済みなら、接続し直しても確認は出ない", async () => {
    const { sessionId, token } = await createSession();
    const session = store.get(sessionId);
    if (!session) throw new Error("セッションがありません");

    const job = orchestrator.proposeGeneration(session, "アプリ作って");
    if (!job) throw new Error("確認が作られませんでした");
    orchestrator.resolveProposal(session, job.jobId, false);

    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");
    await settle();
    expect(client.messages.some((m) => m.type === "trigger.detected")).toBe(false);
    client.close();
    // 裏で走る議事録の書き込みを待つ。後片付けと競合させない
    await sleep(120);
  });
});

describe("一時停止→再開の文字起こし", () => {
  /** テストから操作できる SpeechStream(sttProxy.test.ts と同じ発想) */
  class FakeStream implements SpeechStream {
    readonly emitter = new SpeechEmitter();
    readonly pushed: Uint8Array[] = [];
    ready = false;
    closed = false;

    push(chunk: Uint8Array): void {
      this.pushed.push(chunk);
    }

    on: SpeechStream["on"] = (event, listener) => {
      this.emitter.on(event, listener);
    };

    async close(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      this.ready = false;
      this.emitter.emit("close", { reason: "closed" });
    }
  }

  class FakeProvider implements SpeechProvider {
    readonly name = "fake";
    readonly streams: FakeStream[] = [];

    open(): SpeechStream {
      const stream = new FakeStream();
      this.streams.push(stream);
      return stream;
    }
  }

  let provider: FakeProvider;

  beforeEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store = new SessionStore({ ttlMs: 60_000 });
    provider = new FakeProvider();
    server = createServer((req, res) => {
      void handleApi(req, res, store).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    attachGateway(server, store, provider);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("ポートを取得できません");
    port = address.port;
  });

  async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("条件が満たされませんでした");
      await sleep(10);
    }
  }

  it("一時停止で上流を意図的に閉じ、再開後の発話が文字起こしされる", async () => {
    const { sessionId, token } = await createSession();
    const client = TestClient.connect(sessionId, token);
    await client.open();
    await client.waitFor("session.ready");

    client.send({ type: "start", audio: AUDIO });
    await waitUntil(() => provider.streams.length === 1);
    const first = provider.streams[0] as FakeStream;
    first.ready = true;

    // 最初のチャンク(WebMヘッダ相当)が届く
    client.sendAudio(100);
    await waitUntil(() => first.pushed.length === 1);

    // 一時停止 → 上流は意図的に閉じられる。張り直しは走らない
    client.send({ type: "pause" });
    await waitUntil(() => first.closed);
    await sleep(150);
    expect(provider.streams).toHaveLength(1);

    // 再開 → 新しい上流が張られる。古いヘッダは差し込まれない
    // (クライアントは再開時に録音を新規に始め直し、新しいヘッダを送ってくる)
    client.send({ type: "resume" });
    await waitUntil(() => provider.streams.length === 2);
    const second = provider.streams[1] as FakeStream;
    second.ready = true;
    await sleep(100);
    expect(second.pushed).toHaveLength(0);

    // 新しい録音の最初のチャンク(=新ヘッダ)から中継され、文字起こしが届く
    client.sendAudio(120);
    await waitUntil(() => second.pushed.length === 1);
    expect((second.pushed[0] as Uint8Array).byteLength).toBe(120);
    client.sendAudio(80);
    await waitUntil(() => second.pushed.length === 2);
    second.emitter.emit("final", {
      text: "再開後の発話",
      speaker: "話者1",
      startMs: 0,
      endMs: 1000,
      confidence: 0.9,
    });
    const final = await client.waitFor("transcript.final");
    expect(final.segment.text).toBe("再開後の発話");

    client.close();
  });
});
