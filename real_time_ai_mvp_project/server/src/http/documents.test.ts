import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@rt-mvp/protocol";
import { MarkdownStore } from "../markdown/store.js";
import { SessionDocuments } from "../markdown/sessionDocuments.js";
import { MockSpeechProvider } from "../speech/mockSpeechProvider.js";
import { SessionStore } from "../sessions/store.js";
import { attachGateway } from "../ws/gateway.js";
import { handleApi } from "./api.js";

/**
 * Markdown関連のHTTP APIと、文字起こし→Markdownの経路を通しで検証する。
 * ROADMAP.md Sprint 4 の完了条件に対応する。
 */

let server: Server;
let store: SessionStore;
let docs: SessionDocuments;
let dataDir: string;
let port: number;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "rt-mvp-api-"));
  store = new SessionStore({ ttlMs: 60_000 });
  docs = new SessionDocuments(new MarkdownStore({ dataDir }));

  server = createServer((req, res) => {
    void handleApi(req, res, store, docs).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  attachGateway(server, store, new MockSpeechProvider(), docs);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("ポートを取得できません");
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${port}`;

const AUDIO = {
  mimeType: "audio/webm;codecs=opus",
  codec: "opus",
  sampleRate: 48_000,
  channels: 1,
  timesliceMs: 250,
} as const;

interface Created {
  sessionId: string;
  token: string;
}

async function createSession(title = "テスト商談"): Promise<Created> {
  const response = await fetch(`${base()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function docUrl({ sessionId }: Created, name?: string): string {
  const suffix = name === undefined ? "" : `/${encodeURIComponent(name)}`;
  return `${base()}/api/v1/sessions/${sessionId}/documents${suffix}`;
}

describe("認証", () => {
  it("トークンが無ければ401", async () => {
    const session = await createSession();
    const response = await fetch(docUrl(session));

    expect(response.status).toBe(401);
  });

  it("別セッションのトークンでは読めない", async () => {
    const first = await createSession();
    const second = await createSession();

    const response = await fetch(docUrl(first), { headers: auth(second.token) });

    expect(response.status).toBe(401);
  });

  it("存在しないセッションは404", async () => {
    const session = await createSession();
    const response = await fetch(
      `${base()}/api/v1/sessions/sess_00000000000000000000000000000000/documents`,
      { headers: auth(session.token) },
    );

    expect(response.status).toBe(404);
  });
});

describe("セッション開始時のMarkdown", () => {
  it("meeting.md と transcript.md ができる", async () => {
    const session = await createSession();

    const response = await fetch(docUrl(session), { headers: auth(session.token) });
    const body = (await response.json()) as { documents: { name: string }[] };

    expect(body.documents.map((d) => d.name)).toEqual(["meeting.md", "transcript.md"]);
  });

  it("meeting.md が DATAFLOW.md のスキーマに沿う", async () => {
    const session = await createSession("株式会社◯◯ 業務改善ヒアリング");

    const response = await fetch(docUrl(session, "meeting.md"), { headers: auth(session.token) });
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(text).toContain("# Meeting");
    expect(text).toContain(`- session_id: ${session.sessionId}`);
    expect(text).toContain("- title: 株式会社◯◯ 業務改善ヒアリング");
    expect(text).toContain("- status: active");
    expect(text).toContain("- ended_at:\n");
  });

  it("まだ無いドキュメントは404", async () => {
    const session = await createSession();

    const response = await fetch(docUrl(session, "summary.md"), { headers: auth(session.token) });

    expect(response.status).toBe(404);
  });
});

describe("手入力(PUT)", () => {
  it("全文置換ファイルは上書きできる", async () => {
    const session = await createSession();

    const put = await fetch(docUrl(session, "requirements.md"), {
      method: "PUT",
      headers: { ...auth(session.token), "content-type": "text/markdown" },
      body: "# Requirements\n\n## 目的\n在庫の可視化\n",
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { name: string }).name).toBe("requirements.md");

    const get = await fetch(docUrl(session, "requirements.md"), { headers: auth(session.token) });
    expect(await get.text()).toContain("在庫の可視化");
  });

  it("追記専用ファイルは409で拒む", async () => {
    // DATAFLOW.md:「追記専用。既存行を書き換えてはならない」
    const session = await createSession();

    const response = await fetch(docUrl(session, "transcript.md"), {
      method: "PUT",
      headers: { ...auth(session.token), "content-type": "text/markdown" },
      body: "# Realtime Transcript\n書き換え\n",
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("append_only");
  });

  it("登録簿に無い名前は404", async () => {
    const session = await createSession();

    const response = await fetch(docUrl(session, "secrets.md"), {
      method: "PUT",
      headers: { ...auth(session.token), "content-type": "text/markdown" },
      body: "x",
    });

    expect(response.status).toBe(404);
  });

  it("パスを遡る名前は届かない", async () => {
    const session = await createSession();

    const response = await fetch(
      `${base()}/api/v1/sessions/${session.sessionId}/documents/${encodeURIComponent("../../../etc/passwd")}`,
      {
        method: "PUT",
        headers: { ...auth(session.token), "content-type": "text/markdown" },
        body: "x",
      },
    );

    expect(response.status).toBe(404);
  });

  it("大きすぎる本文は413", async () => {
    const session = await createSession();

    const response = await fetch(docUrl(session, "requirements.md"), {
      method: "PUT",
      headers: { ...auth(session.token), "content-type": "text/markdown" },
      body: "a".repeat(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
  });
});

describe("入力アダプタ(POST /inputs)", () => {
  const post = (session: Created, body: unknown): Promise<Response> =>
    fetch(`${base()}/api/v1/sessions/${session.sessionId}/inputs`, {
      method: "POST",
      headers: { ...auth(session.token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("手入力を transcript.md へ追記する", async () => {
    const session = await createSession();

    const response = await post(session, { source: "manual", payload: "在庫はExcelで管理している" });

    expect(response.status).toBe(202);
    expect((await response.json()) as unknown).toEqual({
      accepted: true,
      normalizedTo: "transcript.md",
    });

    const text = await (
      await fetch(docUrl(session, "transcript.md"), { headers: auth(session.token) })
    ).text();
    expect(text).toContain("| 手入力");
    expect(text).toContain("在庫はExcelで管理している");
  });

  it("Notionの入力は context.md へ落ちる", async () => {
    const session = await createSession();

    const response = await post(session, { source: "notion", payload: "# Context\n過去案件のメモ" });

    expect(((await response.json()) as { normalizedTo: string }).normalizedTo).toBe("context.md");
    const text = await (
      await fetch(docUrl(session, "context.md"), { headers: auth(session.token) })
    ).text();
    expect(text).toContain("過去案件のメモ");
  });

  it("落とし先を明示できる", async () => {
    const session = await createSession();

    const response = await post(session, {
      source: "manual",
      payload: "# Issues\n\n## ISS-001 手で書いた課題",
      target: "issues.md",
    });

    expect(((await response.json()) as { normalizedTo: string }).normalizedTo).toBe("issues.md");
  });

  it("知らない入力元は400", async () => {
    const session = await createSession();

    expect((await post(session, { source: "slack", payload: "x" })).status).toBe(400);
  });

  it("本文が無ければ400", async () => {
    const session = await createSession();

    expect((await post(session, { source: "manual", payload: "  " })).status).toBe(400);
  });
});

describe("文字起こしからMarkdownまで", () => {
  it("確定テキストが transcript.md へ追記される", async () => {
    const session = await createSession();
    const client = new TestClient(session);
    await client.open();
    client.send({
      type: "start",
      audio: AUDIO,
    });

    const segments = await client.collectFinals(3);
    client.close();

    const text = await (
      await fetch(docUrl(session, "transcript.md"), { headers: auth(session.token) })
    ).text();

    expect(text.startsWith("# Realtime Transcript\n")).toBe(true);
    for (const segment of segments) {
      expect(text).toContain(segment.text);
    }
    // 見出しは1確定あたり1つ
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(segments.length);
  });

  it("再接続しても同じ行が二重に入らない", async () => {
    const session = await createSession();

    const first = new TestClient(session);
    await first.open();
    first.send({
      type: "start",
      audio: AUDIO,
    });
    const before = await first.collectFinals(2);
    first.close();

    // 再接続。backlog で同じ確定分が届いても、ファイルへは追記されない
    const second = new TestClient(session);
    await second.open();
    await second.waitForBacklog();
    second.close();

    const text = await (
      await fetch(docUrl(session, "transcript.md"), { headers: auth(session.token) })
    ).text();

    for (const segment of before) {
      expect(text.split(segment.text).length - 1).toBe(1);
    }
  });

  it("終了後もMarkdownを読め、meeting.md が確定する", async () => {
    const session = await createSession();
    const client = new TestClient(session);
    await client.open();
    client.send({
      type: "start",
      audio: AUDIO,
    });
    await client.collectFinals(1);

    const ended = await fetch(`${base()}/api/v1/sessions/${session.sessionId}/end`, {
      method: "POST",
      headers: { ...auth(session.token), "content-type": "application/json" },
      body: JSON.stringify({ reason: "button" }),
    });
    expect(ended.status).toBe(200);
    client.close();

    const meeting = await (
      await fetch(docUrl(session, "meeting.md"), { headers: auth(session.token) })
    ).text();
    expect(meeting).toContain("- status: ended");
    expect(meeting).toMatch(/- ended_at: \d{4}-\d{2}-\d{2}T/);

    // 終了済みでも一覧と本文は読める
    const list = await fetch(docUrl(session), { headers: auth(session.token) });
    expect(list.status).toBe(200);
  });
});

/** 音声を送りながら確定テキストを待つテスト用クライアント */
class TestClient {
  readonly #ws: WebSocket;
  readonly #finals: { seq: number; text: string }[] = [];
  #backlog = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(session: Created) {
    this.#ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/v1/sessions/${session.sessionId}?token=${encodeURIComponent(session.token)}`,
    );
    this.#ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString("utf8")) as ServerMessage;
      if (message.type === "transcript.final") this.#finals.push(message.segment);
      if (message.type === "transcript.backlog") this.#backlog = true;
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#ws.once("open", () => resolve());
      this.#ws.once("error", reject);
    });
  }

  send(message: ClientMessage): void {
    this.#ws.send(JSON.stringify(message));
    // モックは受け取った音声の量で台本を進める。250msごとに1チャンク送る
    this.#timer = setInterval(() => {
      if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(Buffer.alloc(512));
    }, 5);
  }

  /** 指定件数の確定が出るまで待つ */
  async collectFinals(count: number): Promise<{ seq: number; text: string }[]> {
    const deadline = Date.now() + 5_000;
    while (this.#finals.length < count) {
      if (Date.now() > deadline) throw new Error(`確定テキストが ${count} 件に届きません`);
      await sleep(10);
    }
    // 追記は送信の後に走るため、ファイルへ落ちるまで少し待つ
    await sleep(50);
    return this.#finals.slice(0, count);
  }

  async waitForBacklog(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!this.#backlog) {
      if (Date.now() > deadline) throw new Error("backlog が届きません");
      await sleep(10);
    }
    await sleep(50);
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#ws.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
