import {
  SpeechEmitter,
  type SpeechOpts,
  type SpeechProvider,
  type SpeechStream,
} from "./types.js";

/**
 * 開発・テスト用の音声認識モック。
 *
 * 実際には音を聞かず、受け取った音声の量に応じて台本を進める。
 * 「partial が伸びていき、やがて final に確定する」という
 * 実APIと同じ振る舞いを再現することが目的。
 *
 * これがあることで、STT の資格情報なしに
 * Sprint 3 の完了条件のほとんどを検証できる。
 */

export interface MockScriptLine {
  /** 確定させる文 */
  text: string;
  speaker: string | null;
  /** この行を話し終えるまでのミリ秒 */
  durationMs: number;
}

/** 在庫管理のヒアリングを模した既定の台本 */
export const DEFAULT_SCRIPT: MockScriptLine[] = [
  { text: "在庫の管理は今どうされていますか。", speaker: "A", durationMs: 3_000 },
  { text: "Excelで管理していて、担当者しか触れない状態です。", speaker: "B", durationMs: 4_000 },
  { text: "更新はどのくらいの頻度ですか。", speaker: "A", durationMs: 2_500 },
  { text: "毎朝1回です。ただ実態とズレることが多くて。", speaker: "B", durationMs: 4_000 },
  { text: "担当者が不在のときはどうされていますか。", speaker: "A", durationMs: 3_000 },
  { text: "確認が止まってしまいます。そこが一番困っています。", speaker: "B", durationMs: 4_500 },
  // トリガー検出まで台本に含める。モックだけで最後まで通せるようにするため
  { text: "では、この内容でアプリ作ってみましょうか。", speaker: "A", durationMs: 3_500 },
];

export interface MockSpeechOptions {
  script?: MockScriptLine[];
  /** partial を出す間隔 */
  partialIntervalMs?: number;
  /** open してから ready になるまでの遅延。接続の再現 */
  connectDelayMs?: number;
  /** open を必ず失敗させる。障害時の挙動を試すため */
  failOnOpen?: boolean;
  /** 台本を最後まで話したら先頭へ戻る。長時間テスト用 */
  loop?: boolean;
}

class MockSpeechStream implements SpeechStream {
  readonly #emitter = new SpeechEmitter();
  readonly #script: MockScriptLine[];
  readonly #partialIntervalMs: number;
  readonly #loop: boolean;

  #ready = false;
  #closed = false;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #partialTimer: ReturnType<typeof setInterval> | null = null;

  /** 台本上の位置 */
  #lineIndex = 0;
  /** 現在の行を話し始めてからの経過(ミリ秒) */
  #lineElapsedMs = 0;
  /** セッション開始からの経過(ミリ秒)。音声を受け取った量から算出する */
  #totalMs = 0;
  #lineStartMs = 0;
  #lastPartialText = "";

  constructor(options: Required<Omit<MockSpeechOptions, "failOnOpen">> & { failOnOpen: boolean }) {
    this.#script = options.script;
    this.#partialIntervalMs = options.partialIntervalMs;
    this.#loop = options.loop;

    if (options.failOnOpen) {
      // 呼び出し側が on() を登録する時間を与えるため、次のtickで通知する
      setTimeout(() => {
        this.#emitter.emit("error", {
          message: "音声認識サービスに接続できません(モック設定 failOnOpen)",
          retryable: true,
        });
      }, 0);
      return;
    }

    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#closed) return;
      this.#ready = true;
      this.#startPartials();
    }, options.connectDelayMs);
  }

  get ready(): boolean {
    return this.#ready;
  }

  /**
   * 音声チャンクを受け取る。
   * 実際の音は見ず、「1チャンク = timeslice ぶんの時間が経過した」とみなして台本を進める。
   */
  push(chunk: Uint8Array): void {
    if (!this.#ready || this.#closed) return;
    if (chunk.byteLength === 0) return;

    // チャンクの間隔は既定250ms。バイト数ではなく件数で時間を進める。
    const advanceMs = 250;
    this.#totalMs += advanceMs;
    this.#lineElapsedMs += advanceMs;

    const line = this.#script[this.#lineIndex];
    if (!line) return;

    if (this.#lineElapsedMs >= line.durationMs) {
      this.#finalizeLine(line);
    }
  }

  on: SpeechStream["on"] = (event, listener) => {
    this.#emitter.on(event, listener);
  };

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    if (this.#connectTimer !== null) clearTimeout(this.#connectTimer);
    if (this.#partialTimer !== null) clearInterval(this.#partialTimer);
    this.#emitter.emit("close", { reason: "closed by caller" });
    this.#emitter.clear();
  }

  // ── 内部 ──────────────────────────────────────

  #startPartials(): void {
    this.#partialTimer = setInterval(() => {
      if (!this.#ready || this.#closed) return;
      const line = this.#script[this.#lineIndex];
      if (!line) return;

      // 経過に応じて文の頭から少しずつ見せる。実APIの partial と同じ見え方。
      const ratio = Math.min(1, this.#lineElapsedMs / line.durationMs);
      const shown = line.text.slice(0, Math.max(1, Math.floor(line.text.length * ratio)));
      if (shown === this.#lastPartialText) return;
      this.#lastPartialText = shown;

      this.#emitter.emit("partial", {
        text: shown,
        speaker: line.speaker,
        startMs: this.#lineStartMs,
        endMs: this.#totalMs,
      });
    }, this.#partialIntervalMs);
  }

  #finalizeLine(line: MockScriptLine): void {
    this.#emitter.emit("final", {
      text: line.text,
      speaker: line.speaker,
      startMs: this.#lineStartMs,
      endMs: this.#totalMs,
      confidence: 0.95,
    });

    this.#lineIndex += 1;
    if (this.#lineIndex >= this.#script.length && this.#loop) this.#lineIndex = 0;
    this.#lineElapsedMs = 0;
    this.#lineStartMs = this.#totalMs;
    this.#lastPartialText = "";
  }
}

export class MockSpeechProvider implements SpeechProvider {
  readonly name = "mock";
  readonly #options: Required<Omit<MockSpeechOptions, "failOnOpen">> & { failOnOpen: boolean };

  constructor(options: MockSpeechOptions = {}) {
    this.#options = {
      script: options.script ?? DEFAULT_SCRIPT,
      partialIntervalMs: options.partialIntervalMs ?? 400,
      connectDelayMs: options.connectDelayMs ?? 50,
      failOnOpen: options.failOnOpen ?? false,
      loop: options.loop ?? true,
    };
  }

  open(_sessionId: string, _opts: SpeechOpts): SpeechStream {
    return new MockSpeechStream(this.#options);
  }
}
