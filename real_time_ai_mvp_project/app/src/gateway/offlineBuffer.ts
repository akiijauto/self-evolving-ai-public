import { OFFLINE_BUFFER_MS } from "@rt-mvp/protocol";

/**
 * 切断中の音声を保持するバッファ。
 *
 * ARCHITECTURE.md の再接続仕様:
 * 「切断中の音声はクライアント側で最大60秒バッファし、再接続後に送信する。
 *   それを超える分は破棄する。」
 *
 * 古い方から捨てる。商談は続いているので、直近の発話を優先する。
 */

export interface BufferedChunk {
  data: Blob;
  /** このチャンクが表す音声の長さ(ミリ秒) */
  durationMs: number;
}

export class OfflineBuffer {
  readonly #chunks: BufferedChunk[] = [];
  readonly #maxDurationMs: number;
  #durationMs = 0;
  #droppedChunks = 0;

  constructor(maxDurationMs: number = OFFLINE_BUFFER_MS) {
    this.#maxDurationMs = maxDurationMs;
  }

  push(chunk: BufferedChunk): void {
    this.#chunks.push(chunk);
    this.#durationMs += chunk.durationMs;

    // 上限を超えたら古い方から捨てる。
    // ただし最後の1つは必ず残す。単一チャンクが上限より長い場合に
    // 音声が全く残らなくなるのを避けるため。
    while (this.#durationMs > this.#maxDurationMs && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (!dropped) break;
      this.#durationMs -= dropped.durationMs;
      this.#droppedChunks += 1;
    }
  }

  /** 保持している全チャンクを取り出し、バッファを空にする */
  drain(): BufferedChunk[] {
    const chunks = this.#chunks.splice(0, this.#chunks.length);
    this.#durationMs = 0;
    return chunks;
  }

  clear(): void {
    this.#chunks.length = 0;
    this.#durationMs = 0;
  }

  get size(): number {
    return this.#chunks.length;
  }

  /** 保持している音声の長さ(ミリ秒) */
  get durationMs(): number {
    return this.#durationMs;
  }

  /** 上限を超えて捨てたチャンク数。ユーザーへの警告表示に使う */
  get droppedChunks(): number {
    return this.#droppedChunks;
  }
}
