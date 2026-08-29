import {
  AUDIO_TIMESLICE_MS,
  PING_INTERVAL_MS,
  isTerminalClose,
  requiresNewSession,
  type AudioFormat,
  type ClientMessage,
  type EndReason,
  type ServerMessage,
} from "@rt-mvp/protocol";
import { backoffDelayWithJitterMs } from "./backoff";
import { OfflineBuffer } from "./offlineBuffer";

/**
 * Gateway Server との WebSocket 接続。
 *
 * 責務:
 * - 接続の維持と、切断時の指数バックオフ再接続
 * - 切断中の音声のバッファリングと、再接続後の送出
 * - 一時停止中に音声を送らないこと
 *
 * ARCHITECTURE.md の「WebSocket仕様」に従う。
 * 文字起こしの受信は Sprint 3 でこのクラスの onMessage に足す。
 */

export type ConnectionState =
  /** まだ接続していない */
  | "idle"
  | "connecting"
  | "open"
  /** 切断中。再接続を待っている */
  | "reconnecting"
  /** 再接続しても無駄な状態(セッション終了・トークン不正) */
  | "closed";

export interface GatewayClientOptions {
  wsUrl: string;
  token: string;
  /** テスト用に差し替える WebSocket 実装 */
  webSocketImpl?: typeof WebSocket;
  /** 1チャンクが表す音声の長さ。バッファの上限判定に使う */
  timesliceMs?: number;
  random?: () => number;
  onState?: (state: ConnectionState) => void;
  onMessage?: (message: ServerMessage) => void;
  /** 再接続しても回復しない状態になったときに呼ばれる */
  onFatal?: (reason: "unauthorized" | "not_found" | "ended") => void;
  /** バッファ上限を超えて音声を捨てたときに呼ばれる */
  onDropped?: (droppedChunks: number) => void;
}

export class GatewayClient {
  readonly #options: Required<Pick<GatewayClientOptions, "timesliceMs" | "random">> &
    GatewayClientOptions;
  readonly #WebSocketImpl: typeof WebSocket;
  readonly #buffer: OfflineBuffer;

  #socket: WebSocket | null = null;
  #state: ConnectionState = "idle";
  #attempt = 0;
  // ブラウザとテスト(Node)の両方で動くよう、window ではなくグローバルの timer を使う
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  /** 明示的に閉じた。再接続しない */
  #disposed = false;
  /** start を送ったか。再接続後に再送するため保持する */
  #audioFormat: AudioFormat | null = null;
  #paused = false;

  constructor(options: GatewayClientOptions) {
    this.#options = { timesliceMs: AUDIO_TIMESLICE_MS, random: Math.random, ...options };
    this.#WebSocketImpl = options.webSocketImpl ?? WebSocket;
    this.#buffer = new OfflineBuffer();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get bufferedChunks(): number {
    return this.#buffer.size;
  }

  get bufferedMs(): number {
    return this.#buffer.durationMs;
  }

  connect(): void {
    if (this.#disposed) return;
    if (this.#state === "connecting" || this.#state === "open") return;
    this.#openSocket();
  }

  /**
   * 音声送信の開始を宣言する。
   * 再接続後も同じフォーマットで start を送り直すため、値を保持する。
   */
  start(audio: AudioFormat): void {
    this.#audioFormat = audio;
    this.#paused = false;
    this.#send({ type: "start", audio });
  }

  pause(): void {
    this.#paused = true;
    // 切断中に溜めた音声も送らない。一時停止は「送らない」という意思表示のため。
    this.#buffer.clear();
    this.#send({ type: "pause" });
  }

  resume(): void {
    this.#paused = false;
    this.#send({ type: "resume" });
  }

  /**
   * トリガー検出への応答。
   * 承認は人がタップしたときにだけ送る。自動では送らない。
   */
  confirmGenerate(jobId: string, approved: boolean): void {
    this.#send({ type: "confirm_generate", jobId, approved });
  }

  stop(reason: EndReason): void {
    this.#send({ type: "stop", reason });
  }

  /**
   * 音声チャンクを送る。
   * - 一時停止中は送らず、バッファにも積まない
   * - 切断中はバッファへ積み、再接続時にまとめて送る
   */
  sendAudio(data: Blob): void {
    if (this.#paused) return;

    if (this.#state === "open" && this.#socket) {
      this.#socket.send(data);
      return;
    }

    const before = this.#buffer.droppedChunks;
    this.#buffer.push({ data, durationMs: this.#options.timesliceMs });
    const dropped = this.#buffer.droppedChunks - before;
    if (dropped > 0) this.#options.onDropped?.(this.#buffer.droppedChunks);
  }

  /** 接続を閉じ、以降再接続しない */
  dispose(): void {
    this.#disposed = true;
    this.#clearTimers();
    this.#buffer.clear();
    if (this.#socket) {
      this.#socket.onclose = null;
      this.#socket.onerror = null;
      this.#socket.onmessage = null;
      this.#socket.onopen = null;
      if (this.#socket.readyState === this.#WebSocketImpl.OPEN) this.#socket.close(1000, "client dispose");
      this.#socket = null;
    }
    this.#setState("closed");
  }

  // ── 内部 ────────────────────────────────────────────

  #openSocket(): void {
    this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");

    const url = new URL(this.#options.wsUrl);
    url.searchParams.set("token", this.#options.token);

    const socket = new this.#WebSocketImpl(url.toString());
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#setState("open");
      // 再接続時は start を送り直す。サーバー側の started は接続単位のため。
      if (this.#audioFormat) {
        this.#sendNow({ type: "start", audio: this.#audioFormat });
        if (this.#paused) this.#sendNow({ type: "pause" });
      }
      this.#flushBuffer();
      this.#startPing();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      // 未知の type は無視する(前方互換)
      this.#options.onMessage?.(message);
    };

    socket.onerror = () => {
      // onclose が続けて呼ばれるため、ここでは何もしない
    };

    socket.onclose = (event: CloseEvent) => {
      this.#clearTimers();
      this.#socket = null;

      if (this.#disposed) return;

      if (requiresNewSession(event.code)) {
        this.#setState("closed");
        this.#options.onFatal?.(event.code === 4401 ? "unauthorized" : "not_found");
        return;
      }

      if (isTerminalClose(event.code)) {
        this.#setState("closed");
        if (event.code === 4409) this.#options.onFatal?.("ended");
        return;
      }

      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    this.#setState("reconnecting");
    const delay = backoffDelayWithJitterMs(this.#attempt, this.#options.random);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#disposed) this.#openSocket();
    }, delay);
  }

  #flushBuffer(): void {
    if (this.#paused) {
      this.#buffer.clear();
      return;
    }
    for (const chunk of this.#buffer.drain()) {
      this.#socket?.send(chunk.data);
    }
  }

  #startPing(): void {
    this.#pingTimer = setInterval(() => {
      this.#sendNow({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  #clearTimers(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  /** 接続中のみ送る。切断中の制御メッセージは落とす(再接続時に状態から復元する) */
  #send(message: ClientMessage): void {
    if (this.#state !== "open") return;
    this.#sendNow(message);
  }

  #sendNow(message: ClientMessage): void {
    if (this.#socket?.readyState === this.#WebSocketImpl.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onState?.(state);
  }
}
