import type { IncomingMessage, ServerResponse } from "node:http";
import type { CreateSessionResponse, EndReason } from "@rt-mvp/protocol";
import { config } from "../config.js";
import { log } from "../log.js";
import { ConflictError, type Orchestrator } from "../agents/orchestrator.js";
import { DocumentError } from "../markdown/store.js";
import { createZip, type ZipEntry } from "./zip.js";
import type { SlidingWindowLimiter } from "./rateLimit.js";
import type { InputSource, SessionDocuments } from "../markdown/sessionDocuments.js";
import { viewOf, type Session, type SessionStore } from "../sessions/store.js";
import { closeStt } from "../ws/gateway.js";

/**
 * HTTP API。ARCHITECTURE.md の「API一覧」に対応する。
 *
 * 認証は `Authorization: Bearer <session token>`。
 * `POST /sessions` だけがトークンを持たずに呼べる(トークンを配る側のため)。
 *
 * 生成MVPの配信(`/preview/...`)はここではなく preview.ts が担当する。
 * 認証の渡し方が違う(クエリかCookie)ため、入口を分けている。
 */

const MAX_BODY_BYTES = 64 * 1024;

/** Markdownの上書きに使う本文の上限。1商談分の文字起こしが収まる大きさ */
const MAX_MARKDOWN_BYTES = 1024 * 1024;

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: SessionStore,
  docs?: SessionDocuments,
  orchestrator?: Orchestrator,
  /** セッション作成の回数制限。省略時は無制限(テストや使い捨ての起動) */
  createLimiter?: SlidingWindowLimiter,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return true;
  }

  if (path === "/healthz" && req.method === "GET") {
    // 件数を返すのはサーバー内から直接叩かれたときだけ。
    // 外から無認証で読めると、**商談をやっているかどうかが分かってしまう。**
    //
    // `sessions` は保持中の全件(終了済みを含む。保持期間30日)。
    // 「商談中は更新しない」の判定に使うのは `active` のほう。
    // ここを取り違えると、一度商談をしたあと30日間まったく更新できなくなる
    const proxied = req.headers["x-forwarded-for"] !== undefined;
    json(
      res,
      200,
      proxied ? { ok: true } : { ok: true, sessions: store.size, active: store.activeCount },
    );
    return true;
  }

  if (path === "/api/v1/sessions" && req.method === "POST") {
    // トークン無しで叩ける唯一の入口なので、ここだけ回数制限を掛ける
    if (createLimiter && !createLimiter.tryAcquire()) {
      log.warn("session.create_rate_limited", {});
      res.setHeader("Retry-After", String(createLimiter.retryAfterSeconds()));
      json(res, 429, {
        error: { code: "rate_limited", message: "セッションの作成が多すぎます。時間を置いてください" },
      });
      return true;
    }

    const body = await readJson(req, res);
    if (body === undefined) return true;

    const title = typeof body.title === "string" ? body.title.slice(0, 200) : undefined;
    const clientInfo =
      typeof body.clientInfo === "string" ? body.clientInfo.slice(0, 500) : undefined;

    const session = store.create({ title, clientInfo });
    log.info("session.created", { sessionId: session.id, title: session.title });

    // 商談の記録はここから始まる。meeting.md と空の transcript.md を用意する
    if (docs) await docs.open(session);

    const response: CreateSessionResponse = {
      sessionId: session.id,
      wsUrl: buildWsUrl(req, session.id),
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
    json(res, 201, response);
    return true;
  }

  const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch && req.method === "GET") {
    const session = authorize(req, res, store, sessionMatch[1] as string);
    if (!session) return true;

    // 生成済みのURLがあれば載せる。ジョブIDを覚えていなくても辿り着ける
    const job = orchestrator?.latestJob(session.id);
    json(res, 200, {
      ...viewOf(session),
      artifacts: job?.url ? [job.url] : [],
      job: job ?? null,
    });
    return true;
  }

  const endMatch = /^\/api\/v1\/sessions\/([^/]+)\/end$/.exec(path);
  if (endMatch && req.method === "POST") {
    const session = authorize(req, res, store, endMatch[1] as string);
    if (!session) return true;

    const body = await readJson(req, res);
    if (body === undefined) return true;
    const reason = normalizeReason(body.reason);

    store.end(session.id, reason);
    // 上流の音声認識も閉じる。終了ボタンはWebSocketを介さずに押されうる
    void closeStt(session.id);
    log.info("session.ended", {
      sessionId: session.id,
      reason,
      chunks: session.chunks,
      bytes: session.bytes,
    });
    if (docs) await docs.close(session);
    // 商談後のサマリとアクション。終了ボタンはWebSocketを介さずに押されうる
    void orchestrator?.runClosing(session).catch(() => undefined);

    json(res, 200, viewOf(session));
    return true;
  }

  // ── Markdown(Sprint 4) ───────────────────────────

  const listMatch = /^\/api\/v1\/sessions\/([^/]+)\/documents$/.exec(path);
  if (listMatch && req.method === "GET") {
    const session = authorize(req, res, store, listMatch[1] as string);
    if (!session) return true;
    if (!docs) return notConfigured(res);

    json(res, 200, { documents: await docs.store.list(session.id) });
    return true;
  }

  const documentMatch = /^\/api\/v1\/sessions\/([^/]+)\/documents\/([^/]+)$/.exec(path);
  if (documentMatch && (req.method === "GET" || req.method === "PUT")) {
    const session = authorize(req, res, store, documentMatch[1] as string);
    if (!session) return true;
    if (!docs) return notConfigured(res);

    const name = decodeURIComponent(documentMatch[2] as string);

    if (req.method === "GET") {
      const text = await docs.store.read(session.id, name);
      if (text === null) {
        json(res, 404, {
          error: { code: "not_found", message: `${name} はまだありません` },
        });
        return true;
      }
      markdown(res, text);
      return true;
    }

    const text = await readText(req, res, MAX_MARKDOWN_BYTES);
    if (text === undefined) return true;

    try {
      const info = await docs.put(session, name, text);
      log.info("documents.put", { sessionId: session.id, name, size: info.size });
      json(res, 200, { name: info.name, updatedAt: info.updatedAt });
    } catch (error) {
      respondDocumentError(res, error);
    }
    return true;
  }

  const inputsMatch = /^\/api\/v1\/sessions\/([^/]+)\/inputs$/.exec(path);
  if (inputsMatch && req.method === "POST") {
    const session = authorize(req, res, store, inputsMatch[1] as string);
    if (!session) return true;
    if (!docs) return notConfigured(res);

    const body = await readJson(req, res);
    if (body === undefined) return true;

    const source = normalizeSource(body.source);
    if (source === null) {
      json(res, 400, {
        error: { code: "bad_request", message: "source は manual / circleback / notion のいずれか" },
      });
      return true;
    }
    if (typeof body.payload !== "string" || body.payload.trim() === "") {
      json(res, 400, { error: { code: "bad_request", message: "payload が必要です" } });
      return true;
    }

    try {
      const result = await docs.input(session, {
        source,
        payload: body.payload,
        target: typeof body.target === "string" ? body.target : undefined,
        speaker: typeof body.speaker === "string" ? body.speaker : undefined,
      });
      json(res, 202, { accepted: true, normalizedTo: result.normalizedTo });
    } catch (error) {
      respondDocumentError(res, error);
    }
    return true;
  }

  // ── 生成ジョブ ───────────────────────────────────

  const generateMatch = /^\/api\/v1\/sessions\/([^/]+)\/generate$/.exec(path);
  if (generateMatch && req.method === "POST") {
    const session = authorize(req, res, store, generateMatch[1] as string);
    if (!session) return true;
    if (!orchestrator) return notConfigured(res);

    const body = await readJson(req, res);
    if (body === undefined) return true;

    // 明示承認を必須にする(RETROSPECTIVE.md「誤トリガーは明示承認で防ぐ」)。
    // 会話からのトリガーは WebSocket の confirm_generate を通る
    if (body.confirm !== true) {
      json(res, 400, {
        error: { code: "bad_request", message: "confirm: true が必要です" },
      });
      return true;
    }

    try {
      const job = orchestrator.startGeneration(session);
      log.info("job.started", { sessionId: session.id, jobId: job.jobId });
      json(res, 202, job);
    } catch (error) {
      if (error instanceof ConflictError) {
        json(res, 409, { error: { code: "conflict", message: error.message } });
        return true;
      }
      throw error;
    }
    return true;
  }

  const jobMatch = /^\/api\/v1\/sessions\/([^/]+)\/jobs\/([^/]+)$/.exec(path);
  if (jobMatch && req.method === "GET") {
    const session = authorize(req, res, store, jobMatch[1] as string);
    if (!session) return true;
    if (!orchestrator) return notConfigured(res);

    const job = orchestrator.jobOf(session.id, jobMatch[2] as string);
    if (!job) {
      json(res, 404, { error: { code: "not_found", message: "ジョブが見つかりません" } });
      return true;
    }
    json(res, 200, job);
    return true;
  }

  const exportMatch = /^\/api\/v1\/sessions\/([^/]+)\/export\.zip$/.exec(path);
  if (exportMatch && req.method === "GET") {
    const session = authorize(req, res, store, exportMatch[1] as string);
    if (!session) return true;
    if (!docs) return notConfigured(res);

    // 生成が失敗しても、そこまでのMarkdownは持ち帰れるようにする
    const entries: ZipEntry[] = [];
    for (const info of await docs.store.list(session.id)) {
      const body = await docs.store.read(session.id, info.name);
      if (body !== null) entries.push({ name: info.name, content: body });
    }

    const zip = createZip(entries);
    log.info("export.zip", { sessionId: session.id, files: entries.length, bytes: zip.length });
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(zip.length),
      "content-disposition": `attachment; filename="${session.id}.zip"`,
      "cache-control": "no-store",
    });
    res.end(zip);
    return true;
  }

  return false;
}

/**
 * トークンを検証し、セッションを返す。失敗時はレスポンスを書いて undefined。
 *
 * 終了済みでも通す。商談が終わったあとにMarkdownを読み書きできることが
 * Sprint 4 の完了条件のひとつで、音声の受け口(WebSocket)だけが終了済みを拒む。
 */
function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  store: SessionStore,
  sessionId: string,
): Session | undefined {
  const check = store.verify(sessionId, bearerToken(req), { allowEnded: true });

  if (check === "not_found") {
    json(res, 404, { error: { code: "not_found", message: "セッションが見つかりません" } });
    return undefined;
  }
  if (check !== "ok") {
    json(res, 401, { error: { code: "unauthorized", message: "トークンが不正です" } });
    return undefined;
  }
  return store.get(sessionId);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = firstHeader(req.headers.authorization);
  if (!header) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

function respondDocumentError(res: ServerResponse, error: unknown): void {
  if (error instanceof DocumentError) {
    // 名前が無いのは404、書き込み規則の違反は409。
    // どちらもクライアントが直せる要求の誤り。
    const status = error.check === "unknown_document" ? 404 : 409;
    json(res, status, { error: { code: error.check, message: error.message } });
    return;
  }
  throw error;
}

function notConfigured(res: ServerResponse): boolean {
  json(res, 503, {
    error: { code: "internal", message: "Markdown Store が構成されていません" },
  });
  return true;
}

function normalizeReason(value: unknown): EndReason {
  const valid: EndReason[] = ["button", "keyword", "silence", "client_gone"];
  return typeof value === "string" && valid.includes(value as EndReason)
    ? (value as EndReason)
    : "button";
}

function normalizeSource(value: unknown): InputSource | null {
  const valid: InputSource[] = ["manual", "circleback", "notion"];
  return typeof value === "string" && valid.includes(value as InputSource)
    ? (value as InputSource)
    : null;
}

/**
 * WebSocket の接続先を組み立てる。
 * リバースプロキシ配下でも正しいスキームになるよう x-forwarded-proto を見る。
 */
function buildWsUrl(req: IncomingMessage, sessionId: string): string {
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const secure = forwardedProto === "https" || forwardedProto === "wss";
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
  return `${secure ? "wss" : "ws"}://${host}/ws/v1/sessions/${sessionId}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value?.split(",")[0]?.trim();
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
}

/** 本文をJSONとして読む。失敗時はレスポンスを返して undefined を戻す */
async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const raw = await readText(req, res, MAX_BODY_BYTES);
  if (raw === undefined) return undefined;
  if (raw === "") return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      json(res, 400, { error: { code: "bad_request", message: "JSONオブジェクトが必要です" } });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    json(res, 400, { error: { code: "bad_request", message: "JSONとして解釈できません" } });
    return undefined;
  }
}

/** 本文をテキストとして読む。上限を超えたらレスポンスを返して undefined を戻す */
async function readText(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      json(res, 413, { error: { code: "too_large", message: "リクエストが大きすぎます" } });
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function markdown(res: ServerResponse, text: string): void {
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}
