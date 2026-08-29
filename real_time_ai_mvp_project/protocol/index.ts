/**
 * クライアントとサーバーが共有する通信プロトコル。
 *
 * 正本は ARCHITECTURE.md の「API一覧」「WebSocket仕様」。
 * このファイルはそれを型として写したものであり、片方だけを変更しないこと。
 *
 * 受信側は未知の `type` を無視すること(前方互換のため)。
 * メッセージはSprintごとに増える。
 */

// ── HTTP API ───────────────────────────────────────────────

export interface CreateSessionRequest {
  title?: string;
  clientInfo?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  /** WebSocket の接続先。相対パスではなく絶対URLで返す */
  wsUrl: string;
  token: string;
  /** ISO 8601 */
  expiresAt: string;
}

export type SessionStatus = "active" | "generating" | "ended" | "failed";

export interface SessionView {
  sessionId: string;
  status: SessionStatus;
  /** ISO 8601 */
  startedAt: string;
  endedAt: string | null;
  title: string | null;
  /** 生成物のURL。まだ何も生成していなければ空 */
  artifacts: string[];
  /** 受信した音声の統計。Sprint 2 の疎通確認に使う */
  audio: AudioStats;
}

export interface AudioStats {
  chunks: number;
  bytes: number;
  /** 最後にチャンクを受け取った時刻(ISO 8601)。未受信なら null */
  lastChunkAt: string | null;
}

export interface EndSessionRequest {
  reason: EndReason;
}

/**
 * セッション終了の理由。REQUIREMENTS.md FR-8 に対応。
 * `server_restart` はサーバーの再起動時に、実行中だったセッションへ
 * サーバー自身が付ける(クライアントは送れない)。
 */
export type EndReason = "button" | "keyword" | "silence" | "client_gone" | "server_restart";

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// ── WebSocket: Client → Server ──────────────────────────────

export interface AudioFormat {
  /** MediaRecorder の mimeType をそのまま渡す(例: audio/webm;codecs=opus) */
  mimeType: string;
  codec: "opus" | "unknown";
  sampleRate: number;
  channels: number;
  /** 1チャンクあたりのミリ秒。既定250 */
  timesliceMs: number;
}

export type ClientMessage =
  /** 音声送信の開始を宣言。以降バイナリフレームを送ってよい */
  | { type: "start"; audio: AudioFormat }
  /** 音声送信の一時停止。以降バイナリフレームを送ってはならない */
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop"; reason: EndReason }
  /**
   * トリガー検出への応答。**明示的な承認が必要**で、自動承認はしない。
   * `approved: false` ならジョブを捨てる(誤検知のキャンセル)。
   */
  | { type: "confirm_generate"; jobId: string; approved: boolean }
  /** 生存確認。30秒ごと */
  | { type: "ping" };

// ── WebSocket: Server → Client ──────────────────────────────

export type ServerMessage =
  /** 接続確立時に1度だけ送る。再接続時も送る */
  | { type: "session.ready"; sessionId: string; status: SessionStatus; audio: AudioStats }
  /** 音声受信の統計。疎通確認用に一定間隔で送る */
  | { type: "session.stats"; audio: AudioStats }
  | { type: "session.ended"; reason: EndReason }
  /** 未確定の文字起こし。次の partial または final で置き換わる */
  | { type: "transcript.partial"; text: string; speaker: string | null; at: string }
  /** 確定した文字起こし。追記され、以後変わらない */
  | { type: "transcript.final"; segment: TranscriptSegment }
  /** 再接続時に、切断中の確定分をまとめて送る */
  | { type: "transcript.backlog"; segments: TranscriptSegment[] }
  /** Markdownが更新された。クライアントは本文を取り直す */
  | { type: "document.updated"; name: string; updatedAt: string }
  /**
   * トリガーキーワードを検出した。**この時点では何も始まっていない。**
   * クライアントが confirm_generate を返すまで生成しない。
   */
  | { type: "trigger.detected"; jobId: string; phrase: string }
  /** 生成ジョブの進捗。failed のときは failure に理由が入る */
  | { type: "job.progress"; jobId: string; step: JobStep; status: JobStatus; failure?: JobFailure }
  /** 生成物ができ、閲覧できるようになった */
  // previewToken は生成MVPを開くためだけのもの。操作用のトークンとは別物で、
  // QRコードに載るのはこちら(ARCHITECTURE.md「生成MVPの配信」)
  | {
      type: "artifact.ready";
      kind: "mvp";
      buildId: string;
      url: string;
      previewToken: string;
      expiresAt: string;
    }
  | { type: "error"; code: ErrorCode; message: string; recoverable: boolean }
  | { type: "pong" };

/**
 * トリガーとして拾う言い回し。
 *
 * 検出の実体はサーバー側(正規化した部分一致)だが、一覧をここへ置くのは
 * **画面の「使い方」にも同じ一覧を出す**ため。二重管理にすると、
 * 片方だけ増えて「画面に書いてある言葉が拾われない」が起きる。
 */
export const TRIGGER_PHRASES: readonly string[] = [
  "アプリ作って",
  "アプリつくって",
  "アプリ作れる",
  "アプリにして",
  "アプリ作成",
  "これ作って",
  "この内容で作って",
  "この内容でつくって",
  "試作作って",
  "試作品作って",
  "プロトタイプ作って",
  "デモ作って",
  "画面作って",
  "動くもの作って",
  "形にして",
];

/** 生成ジョブの段階。AGENTS.md の実行順序に対応する */
export type JobStep = "requirements" | "ui" | "code" | "review" | "deploy";

/**
 * 生成が失敗した理由。**画面にそのまま出せる言葉で持つ。**
 *
 * 営業担当は失敗の種類によって取る行動が違う:
 * 一時的な混雑なら言い直せばよく、内容起因なら話題を変える必要があり、
 * 設定起因なら言い直しても無駄で管理者に連絡するしかない。
 * 「生成できませんでした」だけでは、この判断ができない。
 */
export interface JobFailure {
  /** 営業担当に見せる説明と対処 */
  message: string;
  /** 合図の言葉を言い直せばやり直せる見込みがあるか */
  retryable: boolean;
  /** 技術的な詳細。問い合わせ・調査用 */
  detail: string;
}

export type JobStatus =
  /** トリガーを検出しただけ。承認されるまで何も始めない */
  | "awaiting_approval"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  /** 誤検知として捨てられた */
  | "cancelled";

export interface JobView {
  jobId: string;
  status: JobStatus;
  step: JobStep;
  /** トリガー検出で作られた場合の言い回し。手動開始なら null */
  phrase: string | null;
  /** 失敗した場合の理由。成功時は null */
  error: string | null;
  /** 失敗した場合の、画面に出せる理由と対処。成功時は null */
  failure: JobFailure | null;
  /** 生成したビルドのID。まだ無ければ null */
  buildId: string | null;
  /** 閲覧用URL。まだ無ければ null */
  url: string | null;
  /** コード生成の試行回数(レビューによる差し戻しを含む) */
  attempt: number;
  startedAt: string;
  endedAt: string | null;
}

/** コード生成の上限。商談中の時間に収めるため(AGENTS.md: 最大3回) */
export const MAX_CODE_ATTEMPTS = 3;

/** 確定した文字起こしの1単位 */
export interface TranscriptSegment {
  /** サーバーが採番する連番。再接続時の重複排除に使う */
  seq: number;
  text: string;
  /** 話者ラベル。話者分離が使えない場合は null */
  speaker: string | null;
  /** 発話開始・終了(セッション開始からのミリ秒) */
  startMs: number;
  endMs: number;
  /** 確定時刻(ISO 8601) */
  at: string;
}

export type ErrorCode =
  /** pause 中にバイナリフレームが届いた(クライアントの不具合) */
  | "unexpected_audio"
  /** JSONとして解釈できない、または未知のメッセージ */
  | "bad_message"
  /** start 前にバイナリフレームが届いた */
  | "not_started"
  /** 音声認識APIに接続できない。録音と受信は継続する */
  | "stt_unavailable"
  /** LLMに接続できない。文字起こしは継続する(Markdownの更新だけが止まる) */
  | "llm_unavailable"
  | "internal";

// ── WebSocket: クローズコード ────────────────────────────────

export const CloseCode = {
  /** 正常終了。クライアントは再接続しない */
  NORMAL: 1000,
  /** サーバー内部エラー。バックオフ後に再接続 */
  INTERNAL: 1011,
  /** トークン不正・期限切れ。セッション再作成 */
  UNAUTHORIZED: 4401,
  /** セッションが存在しない。セッション再作成 */
  NOT_FOUND: 4404,
  /** セッションは既に終了済み。再接続しない */
  ENDED: 4409,
  /** レート制限。バックオフ後に再接続 */
  RATE_LIMITED: 4429,
  /** 同じセッションに新しい接続が来た。**再接続してはならない** */
  SUPERSEDED: 4408,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** このコードで切られたら再接続しても無駄。セッションを作り直す */
export function requiresNewSession(code: number): boolean {
  return code === CloseCode.UNAUTHORIZED || code === CloseCode.NOT_FOUND;
}

/** このコードで切られたら再接続してはならない */
export function isTerminalClose(code: number): boolean {
  // SUPERSEDED を含める。張り直すと、新しい接続を今度はこちらが追い出し、
  // 2つの端末が交互に相手を切り続ける
  return (
    code === CloseCode.NORMAL || code === CloseCode.ENDED || code === CloseCode.SUPERSEDED
  );
}

// ── 既定値 ────────────────────────────────────────────────

/** 音声チャンクの送出間隔。ARCHITECTURE.md の WebSocket 仕様に準拠 */
export const AUDIO_TIMESLICE_MS = 250;

/** 生存確認の間隔 */
export const PING_INTERVAL_MS = 30_000;

/** 切断中にクライアントが保持する音声の上限。これを超えた分は捨てる */
export const OFFLINE_BUFFER_MS = 60_000;

// ── 型ガード ──────────────────────────────────────────────

const CLIENT_MESSAGE_TYPES = new Set([
  "start",
  "pause",
  "resume",
  "stop",
  "confirm_generate",
  "ping",
]);

/**
 * 受信したJSONが ClientMessage かを検証する。
 * サーバーは信頼できない入力を受け取るため、必ずこれを通すこと。
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !CLIENT_MESSAGE_TYPES.has(type)) return null;

  if (type === "start") {
    const audio = (value as { audio?: unknown }).audio;
    if (!isAudioFormat(audio)) return null;
    return { type: "start", audio };
  }

  if (type === "confirm_generate") {
    const jobId = (value as { jobId?: unknown }).jobId;
    const approved = (value as { approved?: unknown }).approved;
    if (typeof jobId !== "string" || typeof approved !== "boolean") return null;
    return { type: "confirm_generate", jobId, approved };
  }

  if (type === "stop") {
    const reason = (value as { reason?: unknown }).reason;
    const valid: EndReason[] = ["button", "keyword", "silence", "client_gone"];
    if (typeof reason !== "string" || !valid.includes(reason as EndReason)) return null;
    return { type: "stop", reason: reason as EndReason };
  }

  return { type } as ClientMessage;
}

function isAudioFormat(value: unknown): value is AudioFormat {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.mimeType === "string" &&
    (a.codec === "opus" || a.codec === "unknown") &&
    typeof a.sampleRate === "number" &&
    typeof a.channels === "number" &&
    typeof a.timesliceMs === "number"
  );
}
