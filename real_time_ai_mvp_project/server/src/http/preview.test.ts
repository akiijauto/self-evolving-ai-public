import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHistory } from "../agents/history.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { TemplateCodeProvider } from "../codegen/templateCodeProvider.js";
import { LocalStaticDeployProvider } from "../deploy/localStaticDeployProvider.js";
import { MockLLMProvider } from "../llm/mockLLMProvider.js";
import { MarkdownStore } from "../markdown/store.js";
import { SessionDocuments } from "../markdown/sessionDocuments.js";
import { SessionStore } from "../sessions/store.js";
import { handleApi } from "./api.js";
import { handlePreview } from "./preview.js";
import { createZip } from "./zip.js";

/**
 * 生成 → 配信 → 閲覧の通し検証。
 * ROADMAP.md Sprint 6 の完了条件のうち、サーバー側で確かめられるものを網羅する。
 */

let server: Server;
let store: SessionStore;
let docs: SessionDocuments;
let deploy: LocalStaticDeployProvider;
let orchestrator: Orchestrator;
let dataDir: string;
let port: number;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "rt-mvp-preview-"));
  const markdown = new MarkdownStore({ dataDir });
  store = new SessionStore({ ttlMs: 60_000 });
  docs = new SessionDocuments(markdown);
  deploy = new LocalStaticDeployProvider({ dataDir });

  orchestrator = new Orchestrator({
    docs,
    llm: new MockLLMProvider(),
    code: new TemplateCodeProvider(),
    deploy,
    history: new AgentHistory(markdown),
    notify: () => undefined,
    intervalMs: 60_000,
    thresholdChars: 400,
  });

  server = createServer((req, res) => {
    void handlePreview(req, res, store, deploy)
      .then((served) => (served ? true : handleApi(req, res, store, docs, orchestrator)))
      .then((handled) => {
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
  await rm(dataDir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${port}`;

interface Created {
  sessionId: string;
  token: string;
}

async function createSession(): Promise<Created> {
  const response = await fetch(`${base()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "テスト商談" }),
  });
  return (await response.json()) as Created;
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/**
 * プレビューを開くためのトークン。操作用(API / WebSocket)とは別物。
 * 実際のクライアントは artifact.ready メッセージで受け取る。
 */
const preview = (sessionId: string): string =>
  encodeURIComponent(store.get(sessionId)?.previewToken ?? "");

/** 会話を入れて課題を作り、生成を最後まで走らせる */
async function generate(session: Created): Promise<{ jobId: string; url: string }> {
  const stored = store.get(session.sessionId);
  if (!stored) throw new Error("セッションがありません");

  await docs.appendTranscript(stored, {
    seq: 1,
    text: "在庫はExcelで管理していて、担当者しか触れない状態です。",
    speaker: "A",
    startMs: 0,
    endMs: 4_000,
    at: new Date().toISOString(),
  });
  await orchestrator.runIssueAgent(stored);

  const started = await fetch(`${base()}/api/v1/sessions/${session.sessionId}/generate`, {
    method: "POST",
    headers: { ...auth(session.token), "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  const job = (await started.json()) as { jobId: string };

  const deadline = Date.now() + 10_000;
  for (;;) {
    const view = orchestrator.jobOf(session.sessionId, job.jobId);
    if (view?.status === "succeeded") return { jobId: job.jobId, url: view.url as string };
    if (view?.status === "failed") throw new Error(`生成が失敗しました: ${view.error}`);
    if (Date.now() > deadline) throw new Error("生成が終わりません");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("生成から配信まで", () => {
  it("URLが払い出され、トークン付きで開ける", async () => {
    const session = await createSession();
    const { url } = await generate(session);

    expect(url).toMatch(new RegExp(`^/preview/${session.sessionId}/build_[0-9a-f]{32}/$`));

    const response = await fetch(`${base()}${url}?t=${preview(session.sessionId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<table");
  });

  it("トークンなしは401", async () => {
    const session = await createSession();
    const { url } = await generate(session);

    expect((await fetch(`${base()}${url}`)).status).toBe(401);
  });

  it("別セッションのトークンでは開けない", async () => {
    const session = await createSession();
    const other = await createSession();
    const { url } = await generate(session);

    expect((await fetch(`${base()}${url}?t=${preview(other.sessionId)}`)).status).toBe(401);
  });

  it("操作用のトークンではプレビューを開けない", async () => {
    // このURLはQRとして画面に映り、開いた端末の履歴にも残る。
    // 操作用と同じ値だったら、写真1枚で商談の全文が読めてしまう
    const session = await createSession();
    const { url } = await generate(session);

    const response = await fetch(`${base()}${url}?t=${encodeURIComponent(session.token)}`);
    expect(response.status).toBe(401);
  });

  it("プレビュー用のトークンではAPIもWebSocketも通らない", async () => {
    const session = await createSession();
    await generate(session);
    const token = decodeURIComponent(preview(session.sessionId));

    const documents = await fetch(
      `${base()}/api/v1/sessions/${session.sessionId}/documents`,
      { headers: auth(token) },
    );
    expect(documents.status).toBe(401);

    const zip = await fetch(`${base()}/api/v1/sessions/${session.sessionId}/export.zip`, {
      headers: auth(token),
    });
    expect(zip.status).toBe(401);
  });

  it("初回のクエリでCookieを渡し、以降はクエリ無しで読める", async () => {
    // ページ内のCSSや画像に毎回クエリを付けるのは現実的でない
    const session = await createSession();
    const { url } = await generate(session);

    const first = await fetch(`${base()}${url}?t=${preview(session.sessionId)}`);
    const cookie = first.headers.get("set-cookie");
    expect(cookie).toContain("rt_preview=");
    expect(cookie).toContain("HttpOnly");

    const asset = await fetch(`${base()}${url}styles.css`, {
      headers: { cookie: (cookie ?? "").split(";")[0] as string },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/css");
  });

  it("配信ディレクトリの外は読めない", async () => {
    const session = await createSession();
    const { url } = await generate(session);
    const token = preview(session.sessionId);

    for (const attempt of ["../../../etc/passwd", "..%2f..%2fmeeting.md", "../builds"]) {
      const response = await fetch(`${base()}${url}${attempt}?t=${token}`);
      expect(response.status).toBe(404);
    }
  });

  it("外部を参照しない指示をヘッダーでも掛ける", async () => {
    const session = await createSession();
    const { url } = await generate(session);

    const response = await fetch(`${base()}${url}?t=${preview(session.sessionId)}`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    // connect-src はフォーム送信とbase差し替えを止めない。そこも塞ぐ
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("知らないビルドIDは404", async () => {
    const session = await createSession();
    await generate(session);

    const response = await fetch(
      `${base()}/preview/${session.sessionId}/build_${"0".repeat(32)}/?t=${preview(session.sessionId)}`,
    );
    expect(response.status).toBe(404);
  });

  it("セッションが失効すると配信も止まる", async () => {
    const session = await createSession();
    const { url } = await generate(session);
    await endSession(session);

    // 保持期間を過ぎたセッションは掃除で消える。成果物も一緒に消す
    await sleep(5);
    expect(store.sweep(0)).toContain(session.sessionId);
    await deploy.remove(session.sessionId);

    expect((await fetch(`${base()}${url}?t=${preview(session.sessionId)}`)).status).toBe(401);
  });

  it("商談終了後も開ける", async () => {
    // 終了を理由に閉じてしまうと、商談後に見せられない
    const session = await createSession();
    const { url } = await generate(session);
    await endSession(session);

    expect((await fetch(`${base()}${url}?t=${preview(session.sessionId)}`)).status).toBe(200);
  });
});

/** 終了させ、商談後のサマリ生成が終わるまで待つ(片付けと書き込みを競合させない) */
async function endSession(session: Created): Promise<void> {
  await fetch(`${base()}/api/v1/sessions/${session.sessionId}/end`, {
    method: "POST",
    headers: { ...auth(session.token), "content-type": "application/json" },
    body: JSON.stringify({ reason: "button" }),
  });

  const deadline = Date.now() + 5_000;
  while ((await docs.store.read(session.sessionId, "todo.md")) === null) {
    if (Date.now() > deadline) throw new Error("商談後の生成が終わりません");
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("生成物", () => {
  it("レビュー結果が review.md に残る", async () => {
    const session = await createSession();
    await generate(session);

    const review = await docs.store.read(session.sessionId, "review.md");
    expect(review).toContain("## 判定: pass");
    expect(review).toContain("### 自動検査");
  });

  it("ai_instruction.md が用意される", async () => {
    const session = await createSession();
    await generate(session);

    const instruction = await docs.store.read(session.sessionId, "ai_instruction.md");
    expect(instruction).toContain("ビルド工程を持たせない");
  });

  it("セッション状態に成果物のURLが載る", async () => {
    const session = await createSession();
    const { url } = await generate(session);

    const response = await fetch(`${base()}/api/v1/sessions/${session.sessionId}`, {
      headers: auth(session.token),
    });
    const body = (await response.json()) as { artifacts: string[]; job: { status: string } };

    expect(body.artifacts).toEqual([url]);
    expect(body.job.status).toBe("succeeded");
  });
});

describe("持ち帰り(ZIP)", () => {
  it("Markdownをまとめて渡す", async () => {
    const session = await createSession();
    await generate(session);

    const response = await fetch(`${base()}/api/v1/sessions/${session.sessionId}/export.zip`, {
      headers: auth(session.token),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(session.sessionId);

    const zip = Buffer.from(await response.arrayBuffer());
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(zip.includes(Buffer.from("requirements.md"))).toBe(true);
    expect(zip.includes(Buffer.from("issues.md"))).toBe(true);
  });

  it("トークンなしでは渡さない", async () => {
    const session = await createSession();

    expect((await fetch(`${base()}/api/v1/sessions/${session.sessionId}/export.zip`)).status).toBe(401);
  });

  it("生成に失敗していてもMarkdownは持ち帰れる", async () => {
    const session = await createSession();

    const response = await fetch(`${base()}/api/v1/sessions/${session.sessionId}/export.zip`, {
      headers: auth(session.token),
    });
    const zip = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(zip.includes(Buffer.from("meeting.md"))).toBe(true);
  });
});

describe("ZIPの構造", () => {
  it("署名と件数が揃う", () => {
    const zip = createZip([
      { name: "a.md", content: "あ" },
      { name: "b/c.md", content: "い" },
    ]);

    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    // 末尾22バイトが End of central directory
    const end = zip.subarray(zip.length - 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(8)).toBe(2);
    expect(end.readUInt16LE(10)).toBe(2);
  });

  it("空でも壊れない", () => {
    const zip = createZip([]);

    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
  });

  it("日本語のファイル名をUTF-8フラグ付きで書く", () => {
    const zip = createZip([{ name: "議事録.md", content: "x" }]);

    // ローカルヘッダの汎用フラグ(offset 6)に UTF-8 ビットが立つ
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
    expect(zip.includes(Buffer.from("議事録.md", "utf8"))).toBe(true);
  });
});
