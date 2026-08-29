import type { CreateSessionResponse, EndReason, JobView, SessionView } from "@rt-mvp/protocol";

/**
 * Gateway Server の HTTP API クライアント。
 * ARCHITECTURE.md の「API一覧」に対応する。
 */

/**
 * API のベースURL。
 * 開発時は vite の proxy が /api を Gateway Server へ転送するため空文字でよい。
 * 別ホストに置く場合は VITE_API_BASE_URL を設定する。
 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "network", "サーバーに接続できません。通信環境を確認してください。");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "unknown",
      body?.error?.message ?? `リクエストが失敗しました (${response.status})`,
    );
  }

  return (await response.json()) as T;
}

export function createSession(input: {
  title?: string;
  clientInfo?: string;
}): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * セッション作成以外はトークンが要る(ARCHITECTURE.md の API一覧)。
 * トークンは `POST /api/v1/sessions` のレスポンスで得たもの。
 */
function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export function getSession(sessionId: string, token: string): Promise<SessionView> {
  return request<SessionView>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    headers: auth(token),
  });
}

export function endSession(
  sessionId: string,
  token: string,
  reason: EndReason,
): Promise<SessionView> {
  return request<SessionView>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/end`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ reason }),
  });
}

/**
 * 生成ジョブを手動で始める。
 *
 * 合図の言葉が拾われない(認識誤り・言い回し違い)場面の逃げ道。
 * ボタンのタップが明示承認にあたる(RETROSPECTIVE.md「誤トリガーは明示承認で防ぐ」)。
 * 進捗は WebSocket の job.progress で流れてくるので、戻り値は使わなくてよい。
 */
export function startGeneration(sessionId: string, token: string): Promise<JobView> {
  return request<JobView>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/generate`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ confirm: true }),
  });
}

/**
 * Markdownの全文を置き換える。誤認識の訂正に使う
 * (例: 「あいこ」が「アイコン」と書き起こされた議題を直す)。
 * 直した内容は、以後の生成にそのまま使われる。
 */
export async function putDocument(
  sessionId: string,
  token: string,
  name: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/documents/${encodeURIComponent(name)}`,
    { method: "PUT", headers: { ...auth(token), "content-type": "text/markdown" }, body: text },
  );
  if (!response.ok) throw new ApiError(response.status, "unknown", "保存できませんでした");
}

export interface DocumentInfo {
  name: string;
  updatedAt: string;
  size: number;
}

/** セッションに溜まっているMarkdownの一覧 */
export function listDocuments(sessionId: string, token: string): Promise<{ documents: DocumentInfo[] }> {
  return request<{ documents: DocumentInfo[] }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/documents`,
    { headers: auth(token) },
  );
}

/** Markdown本文。まだ生成されていなければ null */
export async function getDocument(
  sessionId: string,
  token: string,
  name: string,
): Promise<string | null> {
  const response = await fetch(
    `${BASE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/documents/${encodeURIComponent(name)}`,
    { headers: auth(token) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status, "unknown", "Markdownを取得できません");
  return response.text();
}

/**
 * 成果物をまとめて取得し、保存させる。
 *
 * `<a href>` では `Authorization` を付けられないため、取得してから保存する。
 * トークンをURLへ載せない(コピーやログに残さない)ための選択。
 */
export async function downloadExport(sessionId: string, token: string): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/export.zip`,
    { headers: auth(token) },
  );
  if (!response.ok) throw new ApiError(response.status, "unknown", "ダウンロードできません");

  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sessionId}.zip`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 相対パスで返された wsUrl を絶対URLへ直す。
 * サーバーは Host ヘッダから組み立てるが、vite の proxy 経由だと
 * サーバー自身のホスト名になるため、ブラウザから見えるホストへ寄せる。
 */
export function resolveWsUrl(wsUrl: string, sessionId: string): string {
  if (BASE_URL) return wsUrl;

  // 開発時: PWA と同じオリジンの /ws/... を使い、vite proxy に流す
  const secure = window.location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${window.location.host}/ws/v1/sessions/${sessionId}`;
}
