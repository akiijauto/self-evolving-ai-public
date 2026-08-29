import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AudioFormat, AudioStats, EndReason, SessionStatus, SessionView } from "@rt-mvp/protocol";
import { log } from "../log.js";

/**
 * セッションの管理。
 *
 * セッションの状態遷移はこのファイルに閉じ込め、HTTPとWebSocketの
 * どちらから触っても同じ規則が効くようにする。
 *
 * `persistDir` を渡すと、トークンを含むメタ情報をJSONで保存する。
 * サーバーが再起動しても、**手元のトークンでMarkdownの閲覧・ZIP持ち帰りが
 * できなくならない**ためのもの(Markdownはファイルにあるのに、トークンが
 * メモリにしか無いと読む手段ごと失われる)。
 * 再起動をまたいだ録音の継続は狙わない。実行中だったセッションは
 * `server_restart` で終了扱いにする。
 */

export interface Session {
  id: string;
  token: string;
  /**
   * 生成MVPの閲覧だけに使うトークン。
   *
   * `token` と分ける。プレビューURLは **QRコードとして画面に映り、顧客の端末の
   * 履歴にも残る。** 同じ値でAPIとWebSocketを通していたら、その1本を写真に撮るだけで
   * 商談の全文取得・議事録の改ざん・録音の停止までできてしまう。
   * こちらは `preview` の用途でしか通らない。
   */
  previewToken: string;
  title: string | null;
  clientInfo: string | null;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  endedAt: number | null;
  endReason: EndReason | null;
  /** start で宣言された音声フォーマット。未宣言なら null */
  audioFormat: AudioFormat | null;
  /** 音声送信が一時停止中か */
  paused: boolean;
  chunks: number;
  bytes: number;
  lastChunkAt: number | null;
  /** 同時に接続してよいのは1本まで。後勝ちで前の接続を切る */
  connectionId: string | null;
}

export type TokenCheck = "ok" | "not_found" | "unauthorized" | "ended";

/** トークンの用途。`operate` はAPIとWebSocket、`preview` は生成MVPの閲覧のみ */
export type TokenPurpose = "operate" | "preview";

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  /** 保存先。null ならメモリのみ(テストや使い捨ての起動) */
  readonly #persistDir: string | null;

  constructor(options: { ttlMs: number; now?: () => number; persistDir?: string }) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    this.#persistDir = options.persistDir ?? null;
    if (this.#persistDir !== null) this.#load(this.#persistDir);
  }

  create(input: { title?: string; clientInfo?: string }): Session {
    const now = this.#now();
    const session: Session = {
      id: `sess_${randomUUID().replace(/-/g, "")}`,
      // 推測不可能な長さにする。URLクエリに載るため URL-safe に。
      token: randomBytes(32).toString("base64url"),
      previewToken: randomBytes(32).toString("base64url"),
      title: input.title ?? null,
      clientInfo: input.clientInfo ?? null,
      status: "active",
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      endedAt: null,
      endReason: null,
      audioFormat: null,
      paused: false,
      chunks: 0,
      bytes: 0,
      lastChunkAt: null,
      connectionId: null,
    };
    this.#sessions.set(session.id, session);
    this.#persist(session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /**
   * トークンを検証する。
   * 文字列比較のタイミング差で総当たりされないよう timingSafeEqual を使う。
   *
   * `allowEnded` は終了済みセッションでも "ok" を返す。
   * 商談が終わったあともMarkdownは読めなければならない(ROADMAP.md Sprint 4)。
   * 音声の受け口(WebSocket)だけが終了済みを拒む。
   */
  verify(
    id: string,
    token: string | null,
    options?: { allowEnded?: boolean; purpose?: TokenPurpose },
  ): TokenCheck {
    const session = this.#sessions.get(id);
    if (!session) return "not_found";
    // 用途ごとに別のトークン。既定は操作用(API / WebSocket)。
    // preview のトークンでAPIを通してはいけないので、突き合わせる相手を切り替える
    const expected = options?.purpose === "preview" ? session.previewToken : session.token;
    if (token === null || !safeEqual(expected, token)) return "unauthorized";
    if (this.#now() > session.expiresAt) return "unauthorized";
    if (session.status === "ended" || session.status === "failed") {
      return options?.allowEnded === true ? "ok" : "ended";
    }
    return "ok";
  }

  end(id: string, reason: EndReason): Session | undefined {
    const session = this.#sessions.get(id);
    if (!session || session.status === "ended") return session;
    session.status = "ended";
    session.endedAt = this.#now();
    session.endReason = reason;
    session.paused = false;
    session.connectionId = null;
    // 終了時点の統計(chunks/bytes)ごと書き出す。途中経過は保存しない
    this.#persist(session);
    return session;
  }

  /** 音声チャンクの受信を記録する。戻り値は累積統計 */
  recordChunk(id: string, byteLength: number): AudioStats | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    session.chunks += 1;
    session.bytes += byteLength;
    session.lastChunkAt = this.#now();
    return statsOf(session);
  }

  /**
   * 期限切れ・終了済みで一定時間経ったセッションを捨てる。
   *
   * 戻り値は捨てたセッションID。Markdown Store の保持期間(30日)と
   * ここを揃えるため、呼び出し側が同じIDのディレクトリを消せるようにする。
   */
  sweep(retentionMs: number): string[] {
    const now = this.#now();
    const removed: string[] = [];
    for (const [id, session] of this.#sessions) {
      const endedLongAgo = session.endedAt !== null && now - session.endedAt > retentionMs;
      if (endedLongAgo || now > session.expiresAt + retentionMs) {
        this.#sessions.delete(id);
        this.#removePersisted(id);
        removed.push(id);
      }
    }
    return removed;
  }

  get size(): number {
    return this.#sessions.size;
  }

  /**
   * **実行中**の商談の数。
   *
   * `size` と混同しないこと。`size` は終了済みも数える(保持期間30日)。
   * 「いま商談をやっているか」を判定したい側が `size` を見ると、
   * 一度でも商談をした後は永久に「実行中」と読めてしまう。
   */
  get activeCount(): number {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (session.status === "active") count += 1;
    }
    return count;
  }

  // ── 永続化 ──────────────────────────────────────
  //
  // 同期I/Oを使う。書くのはセッションの作成時と終了時だけで、
  // 1商談あたり2回。非同期にして順序の問題を持ち込む価値が無い。

  #persist(session: Session): void {
    if (this.#persistDir === null) return;
    try {
      const target = join(this.#persistDir, `${session.id}.json`);
      const temp = join(this.#persistDir, `.${session.id}.${randomUUID()}.tmp`);
      // 接続IDは再起動後に意味を持たないので保存しない
      const record: PersistedSession = { ...session, connectionId: null };
      // トークンが平文で入る。既定のumaskだと0644になり、同居する他サイトの
      // 実行ユーザーから読める。書く側で明示的に絞る
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, target);
    } catch (error) {
      // 保存に失敗しても商談は止めない。メモリ上のセッションは生きている
      log.warn("sessions.persist_failed", {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #removePersisted(sessionId: string): void {
    if (this.#persistDir === null) return;
    try {
      rmSync(join(this.#persistDir, `${sessionId}.json`), { force: true });
    } catch {
      // 消し損ねても次の掃除でまた消そうとする
    }
  }

  /** 起動時に一度だけ呼ぶ。読めないファイルは飛ばして起動を続ける */
  #load(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(dir)) {
      const match = /^(sess_[0-9a-f]{32})\.json$/.exec(entry);
      if (!match) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, entry), "utf8"));
        const session = reviveSession(parsed);
        if (session === null) continue;

        // 実行中に落ちたセッションは終了扱いへ。録音は再開できないが、
        // トークンは生きているのでMarkdownの閲覧と持ち帰りはできる
        if (session.status === "active") {
          session.status = "ended";
          session.endedAt = this.#now();
          session.endReason = "server_restart";
          this.#persist(session);
          log.warn("sessions.recovered_as_ended", { sessionId: session.id });
        }
        this.#sessions.set(session.id, session);
      } catch (error) {
        log.warn("sessions.load_failed", {
          file: entry,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.#sessions.size > 0) log.info("sessions.loaded", { count: this.#sessions.size });
  }
}

/** 保存形。connectionId を持たない以外は Session と同じ */
type PersistedSession = Session;

/** 保存されたJSONを Session に戻す。必須項目が欠けていれば null */
function reviveSession(value: unknown): Session | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.token !== "string") return null;
  if (typeof raw.createdAt !== "number" || typeof raw.expiresAt !== "number") return null;

  return {
    id: raw.id,
    token: raw.token,
    // 分離前に保存されたセッションには previewToken が無い。
    // 操作用を流用すると分離した意味が消えるので、読み戻せない値を入れて
    // プレビューだけ通らないようにする(議事録の閲覧と持ち帰りは続けられる)
    previewToken: typeof raw.previewToken === "string" ? raw.previewToken : randomBytes(32).toString("base64url"),
    title: typeof raw.title === "string" ? raw.title : null,
    clientInfo: typeof raw.clientInfo === "string" ? raw.clientInfo : null,
    status: raw.status === "ended" || raw.status === "failed" ? raw.status : "active",
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    endedAt: typeof raw.endedAt === "number" ? raw.endedAt : null,
    endReason: typeof raw.endReason === "string" ? (raw.endReason as EndReason) : null,
    audioFormat: (raw.audioFormat ?? null) as AudioFormat | null,
    paused: false,
    chunks: typeof raw.chunks === "number" ? raw.chunks : 0,
    bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
    lastChunkAt: typeof raw.lastChunkAt === "number" ? raw.lastChunkAt : null,
    connectionId: null,
  };
}

export function statsOf(session: Session): AudioStats {
  return {
    chunks: session.chunks,
    bytes: session.bytes,
    lastChunkAt: session.lastChunkAt === null ? null : new Date(session.lastChunkAt).toISOString(),
  };
}

export function viewOf(session: Session): SessionView {
  return {
    sessionId: session.id,
    status: session.status,
    startedAt: new Date(session.createdAt).toISOString(),
    endedAt: session.endedAt === null ? null : new Date(session.endedAt).toISOString(),
    title: session.title,
    artifacts: [],
    audio: statsOf(session),
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
