/**
 * 音声認識プロバイダの抽象。
 *
 * ARCHITECTURE.md の「交換可能性」に対応する。
 * Deepgram / Google STT / Whisper系 のいずれでも、この形を満たせば差し替えられる。
 * STT Proxy より上の層(WebSocketゲートウェイ、クライアント)は
 * どの実装が動いているかを知らない。
 */

export interface SpeechOpts {
  /** 音声の形式。MediaRecorder の mimeType をそのまま渡す */
  mimeType: string;
  sampleRate: number;
  channels: number;
  /** 認識対象の言語。初期は日本語のみ */
  language: string;
  /** 話者分離を要求するか。対応していないプロバイダは無視してよい */
  diarize: boolean;
}

export interface PartialEvent {
  text: string;
  speaker: string | null;
  /** セッション開始からのミリ秒 */
  startMs: number;
  endMs: number;
}

export interface FinalEvent extends PartialEvent {
  /** プロバイダが返す信頼度(0〜1)。取得できない場合は null */
  confidence: number | null;
}

export interface SpeechErrorEvent {
  message: string;
  /** 再試行して回復する見込みがあるか */
  retryable: boolean;
}

export interface SpeechStreamEvents {
  partial: PartialEvent;
  final: FinalEvent;
  error: SpeechErrorEvent;
  close: { reason: string };
}

export interface SpeechStream {
  /**
   * 音声チャンクを送る。
   *
   * 注意: MediaRecorder が作るWebMは、最初のチャンクにだけヘッダが入る。
   * 呼び出し側(STT Proxy)がヘッダを保持し、上流を張り直すときに
   * 先頭へ差し込む責務を持つ。プロバイダ実装はそれを前提にしてよい。
   */
  push(chunk: Uint8Array): void;

  on<K extends keyof SpeechStreamEvents>(
    event: K,
    listener: (payload: SpeechStreamEvents[K]) => void,
  ): void;

  close(): Promise<void>;

  /** 上流へ送れる状態か。false のあいだ push は捨てられる */
  readonly ready: boolean;
}

export interface SpeechProvider {
  /** 実装の識別子。ログとヘルスチェックに使う */
  readonly name: string;
  open(sessionId: string, opts: SpeechOpts): SpeechStream;
}

/** 実装が共通で使う、購読者の管理 */
export class SpeechEmitter {
  readonly #listeners = new Map<string, ((payload: never) => void)[]>();

  on<K extends keyof SpeechStreamEvents>(
    event: K,
    listener: (payload: SpeechStreamEvents[K]) => void,
  ): void {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener as (payload: never) => void);
    this.#listeners.set(event, list);
  }

  emit<K extends keyof SpeechStreamEvents>(event: K, payload: SpeechStreamEvents[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (p: SpeechStreamEvents[K]) => void)(payload);
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
