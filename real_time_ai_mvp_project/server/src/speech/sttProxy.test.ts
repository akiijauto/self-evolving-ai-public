import { describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@rt-mvp/protocol";
import { SttProxy } from "./sttProxy.js";
import {
  SpeechEmitter,
  type SpeechOpts,
  type SpeechProvider,
  type SpeechStream,
} from "./types.js";

/**
 * 手で操作できる SpeechStream。
 * 「上流がいつ ready になるか」「いつ落ちるか」をテストから決める。
 */
class FakeStream implements SpeechStream {
  readonly emitter = new SpeechEmitter();
  readonly pushed: Uint8Array[] = [];
  ready = false;
  closed = false;

  push(chunk: Uint8Array): void {
    this.pushed.push(chunk);
  }

  on: SpeechStream["on"] = (event, listener) => {
    this.emitter.on(event, listener);
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.emitter.emit("close", { reason: "closed" });
  }

  becomeReady(): void {
    this.ready = true;
  }

  fail(message: string, retryable: boolean): void {
    this.emitter.emit("error", { message, retryable });
  }

  finalize(text: string, speaker: string | null = "A"): void {
    this.emitter.emit("final", { text, speaker, startMs: 0, endMs: 1_000, confidence: 0.9 });
  }

  partial(text: string): void {
    this.emitter.emit("partial", { text, speaker: "A", startMs: 0, endMs: 500 });
  }
}

class FakeProvider implements SpeechProvider {
  readonly name = "fake";
  readonly streams: FakeStream[] = [];

  open(_sessionId: string, _opts: SpeechOpts): SpeechStream {
    const stream = new FakeStream();
    this.streams.push(stream);
    return stream;
  }
}

const OPTS: SpeechOpts = {
  mimeType: "audio/webm;codecs=opus",
  sampleRate: 48000,
  channels: 1,
  language: "ja",
  diarize: true,
};

function makeProxy(overrides: Partial<ConstructorParameters<typeof SttProxy>[0]> = {}) {
  const provider = new FakeProvider();
  const finals: TranscriptSegment[] = [];
  const partials: string[] = [];
  const errors: string[] = [];

  const proxy = new SttProxy({
    sessionId: "sess_test",
    provider,
    opts: OPTS,
    onFinal: (segment) => finals.push(segment),
    onPartial: (partial) => partials.push(partial.text),
    onError: (message) => errors.push(message),
    retryDelayMs: 100,
    ...overrides,
  });

  return { proxy, provider, finals, partials, errors };
}

/** 最新のストリーム */
function latest(provider: FakeProvider): FakeStream {
  const stream = provider.streams.at(-1);
  if (!stream) throw new Error("ストリームが作られていません");
  return stream;
}

describe("SttProxy", () => {
  describe("中継", () => {
    it("上流が ready になるまでチャンクを送らない", () => {
      const { proxy, provider } = makeProxy();
      proxy.push(new Uint8Array([1, 2, 3]));
      expect(latest(provider).pushed).toHaveLength(0);
    });

    it("ready になったら送る", () => {
      const { proxy, provider } = makeProxy();
      latest(provider).becomeReady();
      proxy.push(new Uint8Array([1, 2, 3]));
      expect(latest(provider).pushed).toHaveLength(1);
    });

    it("close 後は送らない", async () => {
      const { proxy, provider } = makeProxy();
      latest(provider).becomeReady();
      await proxy.close();
      proxy.push(new Uint8Array([1]));
      expect(latest(provider).pushed).toHaveLength(0);
    });
  });

  describe("確定した文字起こし", () => {
    it("seq を1から連番で振る", () => {
      const { provider, finals } = makeProxy();
      const stream = latest(provider);
      stream.finalize("一つ目");
      stream.finalize("二つ目");

      expect(finals.map((s) => s.seq)).toEqual([1, 2]);
      expect(finals.map((s) => s.text)).toEqual(["一つ目", "二つ目"]);
    });

    it("話者ラベルを保持する", () => {
      const { provider, finals } = makeProxy();
      latest(provider).finalize("こんにちは", "B");
      expect(finals[0]?.speaker).toBe("B");
    });

    it("話者分離が無くても処理を続ける", () => {
      const { provider, finals } = makeProxy();
      latest(provider).finalize("こんにちは", null);
      expect(finals[0]?.speaker).toBeNull();
    });

    it("未確定は partial として渡す", () => {
      const { provider, partials } = makeProxy();
      latest(provider).partial("こんに");
      latest(provider).partial("こんにちは");
      expect(partials).toEqual(["こんに", "こんにちは"]);
    });
  });

  describe("再接続用のbacklog", () => {
    it("指定 seq より後だけを返す", () => {
      const { proxy, provider } = makeProxy();
      const stream = latest(provider);
      stream.finalize("1");
      stream.finalize("2");
      stream.finalize("3");

      expect(proxy.backlogAfter(1).map((s) => s.text)).toEqual(["2", "3"]);
      expect(proxy.backlogAfter(0)).toHaveLength(3);
      expect(proxy.backlogAfter(3)).toHaveLength(0);
    });

    it("上限を超えたら古い方から捨てる", () => {
      const { proxy, provider } = makeProxy({ backlogLimit: 3 });
      const stream = latest(provider);
      for (const text of ["1", "2", "3", "4", "5"]) stream.finalize(text);

      const backlog = proxy.backlogAfter(0);
      expect(backlog.map((s) => s.text)).toEqual(["3", "4", "5"]);
      // seq は捨てても振り直さない
      expect(backlog.map((s) => s.seq)).toEqual([3, 4, 5]);
    });
  });

  describe("WebMヘッダの保持", () => {
    it("最初のチャンクを保持し、張り直した上流へ送り直す", async () => {
      vi.useFakeTimers();
      try {
        const { proxy, provider } = makeProxy();
        const first = latest(provider);
        first.becomeReady();

        const header = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
        proxy.push(header);
        proxy.push(new Uint8Array([9, 9]));
        expect(first.pushed).toHaveLength(2);

        // 上流が落ちる → 張り直し
        first.fail("接続断", true);
        await vi.advanceTimersByTimeAsync(150);

        const second = latest(provider);
        expect(second).not.toBe(first);

        // ready になるとヘッダが差し込まれる
        second.becomeReady();
        await vi.advanceTimersByTimeAsync(50);

        expect(second.pushed).toHaveLength(1);
        expect(Array.from(second.pushed[0] as Uint8Array)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ヘッダを保持していなければ何も送らない", async () => {
      vi.useFakeTimers();
      try {
        const { provider } = makeProxy();
        latest(provider).fail("接続断", true);
        await vi.advanceTimersByTimeAsync(150);

        const second = latest(provider);
        second.becomeReady();
        await vi.advanceTimersByTimeAsync(50);
        expect(second.pushed).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("障害時の挙動", () => {
    it("再試行可能なエラーは張り直す", async () => {
      vi.useFakeTimers();
      try {
        const { provider, errors } = makeProxy();
        latest(provider).fail("一時的な障害", true);
        await vi.advanceTimersByTimeAsync(150);

        expect(provider.streams).toHaveLength(2);
        expect(errors).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("close イベントで再試行が二重に走らない", async () => {
      vi.useFakeTimers();
      try {
        const { provider } = makeProxy();
        // fail が close も誘発するが、張り直しは1回だけであるべき
        latest(provider).fail("一時的な障害", true);
        await vi.advanceTimersByTimeAsync(150);
        expect(provider.streams).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("再試行しても直らなければ諦め、1度だけ通知する", async () => {
      vi.useFakeTimers();
      try {
        const { proxy, provider, errors } = makeProxy({ maxRetries: 2 });

        for (let i = 0; i < 5; i += 1) {
          latest(provider).fail("落ちている", true);
          await vi.advanceTimersByTimeAsync(500);
        }

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("録音は続いています");
        expect(proxy.degraded).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("再試行不可のエラーは即座に諦める", () => {
      const { provider, errors } = makeProxy();
      latest(provider).fail("資格情報が不正です", false);

      expect(errors).toHaveLength(1);
      expect(provider.streams).toHaveLength(1);
    });

    it("諦めた後も push で落ちない(録音は続く)", () => {
      const { proxy, provider } = makeProxy();
      latest(provider).fail("資格情報が不正です", false);
      expect(() => proxy.push(new Uint8Array([1, 2]))).not.toThrow();
    });

    it("復帰したら degraded が戻る", async () => {
      vi.useFakeTimers();
      try {
        const { proxy, provider } = makeProxy();
        latest(provider).fail("一時的な障害", true);
        expect(proxy.degraded).toBe(true);

        await vi.advanceTimersByTimeAsync(150);
        latest(provider).finalize("復帰しました");
        expect(proxy.degraded).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("一時停止と再開", () => {
    it("suspend で上流を閉じ、再試行もしない", async () => {
      vi.useFakeTimers();
      try {
        const { proxy, provider } = makeProxy();
        const first = latest(provider);
        first.becomeReady();
        proxy.push(new Uint8Array([0x1a, 0x45]));

        proxy.suspend();
        expect(first.closed).toBe(true);

        // 意図した停止なので、どれだけ待っても張り直さない
        await vi.advanceTimersByTimeAsync(10_000);
        expect(provider.streams).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resume 後は古いヘッダを差し込まず、新しい録音のヘッダから受け直す", async () => {
      vi.useFakeTimers();
      try {
        const { proxy, provider, finals } = makeProxy();
        const first = latest(provider);
        first.becomeReady();
        const oldHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
        proxy.push(oldHeader);
        await vi.advanceTimersByTimeAsync(50);

        proxy.suspend();
        proxy.resume();

        const second = latest(provider);
        expect(second).not.toBe(first);
        second.becomeReady();
        await vi.advanceTimersByTimeAsync(50);

        // 古いヘッダは流れない。再開時はクライアントが録音を新規に始め直し、
        // 最初のチャンクに新しいヘッダが入る。古いヘッダ+時間の飛んだ音声は
        // 実機のDeepgramがエラーも出さずに沈黙した
        expect(second.pushed).toHaveLength(0);

        const newHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa4]);
        proxy.push(newHeader);
        proxy.push(new Uint8Array([9, 9]));
        expect(second.pushed).toHaveLength(2);
        expect(Array.from(second.pushed[0] as Uint8Array)).toEqual([0x1a, 0x45, 0xdf, 0xa4]);

        second.finalize("再開後の発話");
        expect(finals.map((s) => s.text)).toEqual(["再開後の発話"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("接続が整う前の音声は捨てず、整い次第 順に流す(セッション開始10秒ロスの再発防止)", async () => {
      vi.useFakeTimers();
      try {
        const { proxy, provider } = makeProxy();
        const stream = latest(provider);

        // 上流のWebSocketが開く前にチャンクが届く(実機では0.2秒で最初のチャンクが来る)
        proxy.push(new Uint8Array([0x1a, 0x45]));
        proxy.push(new Uint8Array([1]));
        proxy.push(new Uint8Array([2]));
        expect(stream.pushed).toHaveLength(0);

        stream.becomeReady();
        await vi.advanceTimersByTimeAsync(50);

        // ヘッダの二重送信はせず、届いた順のまま流す
        expect(stream.pushed).toHaveLength(3);
        expect(Array.from(stream.pushed[0] as Uint8Array)).toEqual([0x1a, 0x45]);
        expect(Array.from(stream.pushed[1] as Uint8Array)).toEqual([1]);
        expect(Array.from(stream.pushed[2] as Uint8Array)).toEqual([2]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("諦めた後でも resume で復旧できる(手動の復旧経路)", async () => {
      vi.useFakeTimers();
      try {
        const { proxy, provider, finals } = makeProxy({ maxRetries: 1 });

        // 再試行を使い切って諦める
        for (let i = 0; i < 3; i += 1) {
          latest(provider).fail("落ちている", true);
          await vi.advanceTimersByTimeAsync(500);
        }
        expect(proxy.degraded).toBe(true);

        // 一時停止 → 再開。人の明示操作なので、もう一度だけ信じる
        proxy.suspend();
        proxy.resume();

        const revived = latest(provider);
        revived.becomeReady();
        revived.finalize("復旧した");
        expect(proxy.degraded).toBe(false);
        expect(finals.map((s) => s.text)).toEqual(["復旧した"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("close 後の resume は何もしない", async () => {
      const { proxy, provider } = makeProxy();
      proxy.suspend();
      await proxy.close();
      proxy.resume();
      expect(provider.streams).toHaveLength(1);
    });
  });
});
