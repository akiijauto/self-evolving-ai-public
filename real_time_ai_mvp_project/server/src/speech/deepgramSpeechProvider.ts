import { WebSocket } from "ws";
import { log } from "../log.js";
import {
  SpeechEmitter,
  type SpeechOpts,
  type SpeechProvider,
  type SpeechStream,
} from "./types.js";

/**
 * Deepgram のストリーミング音声認識に接続する実装。
 *
 * ⚠️ **この実装は実APIへの接続を確認していない。**
 * 開発環境に資格情報がないため、型・接続手順・イベント整形までを用意し、
 * 実接続の検証は API キーが用意できた時点で行う。
 * それまでの既定は MockSpeechProvider(SPEECH_PROVIDER=mock)。
 *
 * 差し替え可能性を保つため、Deepgram固有の事情はこのファイルに閉じ込める。
 * 上位(SttProxy 以上)はこのファイルの存在を知らない。
 */

const ENDPOINT = "wss://api.deepgram.com/v1/listen";

export interface DeepgramOptions {
  apiKey: string;
  /** 認識モデル。日本語は nova-2 系を想定 */
  model?: string;
  endpoint?: string;
}

class DeepgramStream implements SpeechStream {
  readonly #emitter = new SpeechEmitter();
  readonly #socket: WebSocket;
  #ready = false;
  #closed = false;

  constructor(url: string, apiKey: string) {
    this.#socket = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });

    this.#socket.on("open", () => {
      this.#ready = true;
    });

    this.#socket.on("message", (raw: Buffer) => {
      this.#handleMessage(raw.toString("utf8"));
    });

    this.#socket.on("error", (error: Error) => {
      this.#ready = false;
      this.#emitter.emit("error", { message: error.message, retryable: true });
    });

    this.#socket.on("close", (code: number, reason: Buffer) => {
      this.#ready = false;
      if (this.#closed) return;

      // 4xxは資格情報やパラメータの誤り。張り直しても直らない。
      const retryable = !(code >= 4000 && code < 4100);
      this.#emitter.emit("error", {
        message: `Deepgram が接続を閉じました (code=${code} ${reason.toString()})`,
        retryable,
      });
    });
  }

  get ready(): boolean {
    return this.#ready && this.#socket.readyState === WebSocket.OPEN;
  }

  push(chunk: Uint8Array): void {
    if (!this.ready) return;
    this.#socket.send(chunk);
  }

  on: SpeechStream["on"] = (event, listener) => {
    this.#emitter.on(event, listener);
  };

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    if (this.#socket.readyState === WebSocket.OPEN) {
      // 送信済みの音声を処理しきってから閉じてもらう
      this.#socket.send(JSON.stringify({ type: "CloseStream" }));
      this.#socket.close();
    }
    this.#emitter.emit("close", { reason: "closed by caller" });
    this.#emitter.clear();
  }

  #handleMessage(raw: string): void {
    let payload: DeepgramResult;
    try {
      payload = JSON.parse(raw) as DeepgramResult;
    } catch {
      return;
    }

    if (payload.type !== "Results") return;

    const alternative = payload.channel?.alternatives?.[0];
    if (!alternative || !alternative.transcript) return;

    const startMs = Math.round((payload.start ?? 0) * 1000);
    const endMs = startMs + Math.round((payload.duration ?? 0) * 1000);
    // 話者分離が有効なら単語に speaker が入る。先頭の話者を代表とする。
    const speaker = alternative.words?.[0]?.speaker;

    const base = {
      text: alternative.transcript,
      speaker: speaker === undefined ? null : `話者${speaker + 1}`,
      startMs,
      endMs,
    };

    if (payload.is_final) {
      this.#emitter.emit("final", { ...base, confidence: alternative.confidence ?? null });
    } else {
      this.#emitter.emit("partial", base);
    }
  }
}

interface DeepgramResult {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: {
      transcript?: string;
      confidence?: number;
      words?: { speaker?: number }[];
    }[];
  };
}

export class DeepgramSpeechProvider implements SpeechProvider {
  readonly name = "deepgram";
  readonly #options: Required<DeepgramOptions>;

  constructor(options: DeepgramOptions) {
    this.#options = {
      model: options.model ?? "nova-2",
      endpoint: options.endpoint ?? ENDPOINT,
      apiKey: options.apiKey,
    };
  }

  open(sessionId: string, opts: SpeechOpts): SpeechStream {
    const url = new URL(this.#options.endpoint);
    url.searchParams.set("model", this.#options.model);
    url.searchParams.set("language", opts.language);
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("channels", String(opts.channels));
    if (opts.diarize) url.searchParams.set("diarize", "true");

    log.info("stt.opening", { sessionId, provider: this.name, model: this.#options.model });
    return new DeepgramStream(url.toString(), this.#options.apiKey);
  }
}
