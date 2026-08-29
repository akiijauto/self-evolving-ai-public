import type { TranscriptSegment } from "@rt-mvp/protocol";
import { log } from "../log.js";
import type { SpeechOpts, SpeechProvider, SpeechStream } from "./types.js";

/**
 * 音声チャンクを音声認識へ中継し、結果を確定/未確定に整理する。
 *
 * セッションに1つ存在し、クライアントのWebSocket接続とは独立して生き続ける。
 * クライアントが切断・再接続しても、上流の認識ストリームは維持される。
 *
 * ## WebMヘッダの保持について
 *
 * MediaRecorder が作るWebMは、**最初のチャンクにだけヘッダが入る**。
 * 2つ目以降を単体で認識APIへ送っても解釈できない。
 * そのため最初のチャンクを保持しておき、上流を張り直すたびに先頭へ差し込む。
 * これを怠ると、STTが一度でも切れた瞬間から文字起こしが無音になる。
 *
 * ただし**一時停止→再開は例外。** 再開時はクライアントが録音を新規に始め直し、
 * 最初のチャンクに新しいヘッダが入る。古いヘッダを差し込んでから新しいストリームを
 * 流すと、実機ではDeepgramがエラーも出さずに沈黙した(ヘッダの重複と
 * タイムスタンプの不連続を解釈できない)。suspend でヘッダを捨てるのはそのため。
 *
 * ## 接続が整う前の音声について
 *
 * 上流のWebSocketが開くまで0.5〜1秒かかる。この間のチャンクを捨てると、
 * **最初のチャンク(=ヘッダ)がまず届かない。** 実機ではヘッダ無しの音声を
 * 受けたDeepgramが約10秒で切断し、毎セッション開始直後に「再試行するまで
 * 文字起こしが出ない」10秒のロスが起きていた。整うまでは短く溜めて、
 * 整い次第ヘッダ→溜めた分の順で流す。
 */

export interface SttProxyOptions {
  sessionId: string;
  provider: SpeechProvider;
  opts: SpeechOpts;
  /** 確定した文字起こしの通知先 */
  onFinal: (segment: TranscriptSegment) => void;
  /** 未確定の文字起こしの通知先 */
  onPartial: (partial: { text: string; speaker: string | null; at: string }) => void;
  /** 回復不能なエラーの通知先。文字起こしのみ停止し、セッションは続く */
  onError: (message: string) => void;
  /** 上流の再接続を諦めるまでの回数 */
  maxRetries?: number;
  /** 再接続の待ち時間(試行回数に比例して伸ばす) */
  retryDelayMs?: number;
  /** 保持する確定分の上限。再接続時の再送に使う */
  backlogLimit?: number;
}

/**
 * 接続が整うまで溜めるチャンク数の上限(250ms × 40 = 約10秒)。
 * これ以上溜めて流し込むと、時系列のずれた音声で認識がかえって乱れる。
 * 超えたら古い方から捨てる。
 */
const PENDING_LIMIT = 40;

export class SttProxy {
  readonly #options: Required<SttProxyOptions>;
  readonly #segments: TranscriptSegment[] = [];

  #stream: SpeechStream | null = null;
  /** 最初のチャンク(WebMヘッダを含む)。上流を張り直すときに先頭へ送る */
  #headerChunk: Uint8Array | null = null;
  /** 接続が整う前に届いた音声。整い次第、ヘッダに続けて流す */
  #pending: Uint8Array[] = [];
  /** #pending の先頭にヘッダそのものが入っているか。二重送信を防ぐ */
  #pendingHasHeader = false;
  /** ヘッダと溜めた分を流し終えたストリーム。live 中継へ移ってよい印 */
  #primedStream: SpeechStream | null = null;
  #seq = 0;
  #retries = 0;
  #closed = false;
  /** 一時停止中。上流は意図的に閉じてあり、resume() まで何もしない */
  #suspended = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #headerTimer: ReturnType<typeof setInterval> | null = null;
  /** 上流が使えない状態。文字起こしのみ停止し、音声の受信は続ける */
  #degraded = false;
  /** 諦めた後は onError を繰り返さない */
  #gaveUp = false;

  constructor(options: SttProxyOptions) {
    this.#options = {
      maxRetries: 3,
      retryDelayMs: 1_000,
      backlogLimit: 500,
      ...options,
    };
    this.#connect();
  }

  /** 上流が使えず、文字起こしが止まっているか */
  get degraded(): boolean {
    return this.#degraded;
  }

  get finalizedCount(): number {
    return this.#seq;
  }

  /**
   * 指定 seq より後の確定分を返す。
   * クライアントが再接続したとき、取りこぼした分を送るために使う。
   */
  backlogAfter(seq: number): TranscriptSegment[] {
    return this.#segments.filter((segment) => segment.seq > seq);
  }

  /** 音声チャンクを中継する */
  push(chunk: Uint8Array): void {
    if (this.#closed || this.#suspended || this.#gaveUp) return;

    const stream = this.#stream;

    // 整った直後の最初の live チャンクより先に、ヘッダと溜めた分を流す。
    // 20ms の見張りタイマーを待つと live が先に届いて順序が壊れる
    if (stream?.ready) this.#primeNow(stream);

    // 最初のチャンクだけは必ず控える。上流の張り直しに必要。
    if (this.#headerChunk === null) {
      this.#headerChunk = new Uint8Array(chunk);
      if (!stream?.ready) this.#pendingHasHeader = true;
    }

    if (!stream?.ready) {
      this.#pending.push(new Uint8Array(chunk));
      if (this.#pending.length > PENDING_LIMIT) {
        this.#pending.shift();
        // ヘッダを押し出したら、次の張り直しで #headerChunk から差し込む
        this.#pendingHasHeader = false;
      }
      return;
    }
    stream.push(chunk);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearTimers();
    const stream = this.#stream;
    this.#stream = null;
    await stream?.close();
  }

  /**
   * 一時停止。上流を**意図的に**閉じ、再開まで張り直さない。
   *
   * 停止中は無音なので、上流を開けたままにすると認識サービス側の
   * アイドル切断 → 再試行 → 3回で諦め、と進んでしまい、
   * **録音を再開しても文字起こしが二度と戻らない**(実機で発生)。
   * 意図した停止は失敗として数えない。認識サービスの課金も止まる。
   *
   * ヘッダと溜めた音声もここで捨てる。再開時はクライアントが録音を
   * 新規に始め直すので、次の最初のチャンクが新しいヘッダになる。
   */
  suspend(): void {
    if (this.#closed || this.#suspended) return;
    this.#suspended = true;
    this.#clearTimers();
    this.#detachStream();
    this.#headerChunk = null;
    this.#pending = [];
    this.#pendingHasHeader = false;
    log.info("stt.suspended", { sessionId: this.#options.sessionId });
  }

  /**
   * 再開。クライアントが新しく始めた録音のヘッダから受け直す。
   *
   * **諦め状態も解除する。** 再開は人の明示操作であり、
   * 「上流の調子が悪くて諦めた」あとの手動の復旧経路を兼ねる。
   */
  resume(): void {
    if (this.#closed || !this.#suspended) return;
    this.#suspended = false;
    this.#retries = 0;
    this.#gaveUp = false;
    this.#degraded = false;
    log.info("stt.resumed", { sessionId: this.#options.sessionId });
    this.#connect();
  }

  // ── 内部 ──────────────────────────────────────

  #connect(): void {
    if (this.#closed || this.#suspended) return;

    const stream = this.#options.provider.open(this.#options.sessionId, this.#options.opts);
    this.#stream = stream;

    /**
     * 既に捨てたストリームからのイベントは無視する。
     * close() が close イベントを起こすため、これがないと
     * 再試行が二重に走る。
     */
    const isCurrent = (): boolean => !this.#closed && this.#stream === stream;

    stream.on("partial", (event) => {
      if (!isCurrent()) return;
      this.#degraded = false;
      this.#options.onPartial({
        text: event.text,
        speaker: event.speaker,
        at: new Date().toISOString(),
      });
    });

    stream.on("final", (event) => {
      if (!isCurrent()) return;
      this.#degraded = false;
      this.#retries = 0;

      this.#seq += 1;
      const segment: TranscriptSegment = {
        seq: this.#seq,
        text: event.text,
        speaker: event.speaker,
        startMs: event.startMs,
        endMs: event.endMs,
        at: new Date().toISOString(),
      };

      this.#segments.push(segment);
      // 古い確定分は落とす。再接続時の再送に必要な分だけ持てばよい。
      if (this.#segments.length > this.#options.backlogLimit) {
        this.#segments.splice(0, this.#segments.length - this.#options.backlogLimit);
      }

      this.#options.onFinal(segment);
    });

    stream.on("error", (event) => {
      if (!isCurrent()) return;
      log.warn("stt.error", {
        sessionId: this.#options.sessionId,
        provider: this.#options.provider.name,
        message: event.message,
        retryable: event.retryable,
        retries: this.#retries,
      });
      if (event.retryable) this.#scheduleRetry(event.message);
      else this.#giveUp(event.message);
    });

    stream.on("close", () => {
      if (!isCurrent()) return;
      // 意図せず切れた。張り直す。
      this.#scheduleRetry("音声認識との接続が切れました");
    });

    this.#watchReady(stream);
  }

  /**
   * ready になり次第、ヘッダ → 溜めた音声の順で流す。
   *
   * 見張りが要るのは、新しいチャンクが来ないまま ready になる場合
   * (再接続時に溜まった分だけを流すとき)を取りこぼさないため。
   * live チャンクが先に届いた場合は push() 側が #primeNow を先に呼ぶ。
   */
  #watchReady(stream: SpeechStream): void {
    this.#clearHeaderTimer();
    const startedAt = Date.now();

    this.#headerTimer = setInterval(() => {
      if (this.#closed || this.#stream !== stream || this.#primedStream === stream) {
        this.#clearHeaderTimer();
        return;
      }
      if (Date.now() - startedAt > 10_000) {
        this.#clearHeaderTimer();
        return;
      }
      if (!stream.ready) return;

      this.#clearHeaderTimer();
      this.#primeNow(stream);
    }, 20);
  }

  /** ヘッダと溜めた分を流し、live 中継へ移る。ストリームごとに一度だけ */
  #primeNow(stream: SpeechStream): void {
    if (this.#primedStream === stream) return;
    this.#primedStream = stream;

    const header = this.#headerChunk;
    // 溜めた分の先頭がヘッダそのものなら、別途差し込むと二重になる
    if (header !== null && !this.#pendingHasHeader) {
      stream.push(header);
      log.info("stt.header_replayed", {
        sessionId: this.#options.sessionId,
        bytes: header.byteLength,
      });
    }

    const backlog = this.#pending;
    this.#pending = [];
    this.#pendingHasHeader = false;
    for (const chunk of backlog) stream.push(chunk);
    if (backlog.length > 0) {
      log.info("stt.pending_flushed", {
        sessionId: this.#options.sessionId,
        chunks: backlog.length,
      });
    }
  }

  #scheduleRetry(message: string): void {
    if (this.#closed || this.#suspended || this.#gaveUp) return;
    if (this.#retryTimer !== null) return;

    this.#retries += 1;
    if (this.#retries > this.#options.maxRetries) {
      this.#giveUp(message);
      return;
    }

    this.#degraded = true;
    this.#detachStream();

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      log.info("stt.retry", { sessionId: this.#options.sessionId, attempt: this.#retries });
      this.#connect();
    }, this.#options.retryDelayMs * this.#retries);
  }

  #giveUp(message: string): void {
    if (this.#gaveUp) return;
    this.#gaveUp = true;
    this.#degraded = true;
    this.#detachStream();
    this.#clearTimers();
    this.#pending = [];
    this.#pendingHasHeader = false;

    log.error("stt.gave_up", {
      sessionId: this.#options.sessionId,
      provider: this.#options.provider.name,
      message,
    });

    // ARCHITECTURE.md の縮退動作:
    // 文字起こしは止めるが、音声の受信とセッションは維持する。
    this.#options.onError(
      `音声認識に接続できません(${message})。録音は続いています。` +
        `一時停止→再開で接続し直せます。戻らなければ手入力へ切り替えてください。`,
    );
  }

  /** 現在のストリームを切り離す。以後そのストリームのイベントは無視される */
  #detachStream(): void {
    const stream = this.#stream;
    this.#stream = null;
    void stream?.close();
  }

  #clearTimers(): void {
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#clearHeaderTimer();
  }

  #clearHeaderTimer(): void {
    if (this.#headerTimer !== null) {
      clearInterval(this.#headerTimer);
      this.#headerTimer = null;
    }
  }
}
