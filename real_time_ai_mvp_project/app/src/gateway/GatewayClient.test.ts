import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseCode, type AudioFormat, type ClientMessage } from "@rt-mvp/protocol";
import { GatewayClient, type ConnectionState } from "./GatewayClient";

/**
 * WebSocket のモック。
 * 実際の通信は張らず、open / close / message を手で起こす。
 */
class MockSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockSocket[] = [];

  readyState = MockSocket.CONNECTING;
  binaryType = "blob";
  sent: (string | Blob)[] = [];

  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(data: string | Blob): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // ── テストから状態を起こす ──
  open(): void {
    this.readyState = MockSocket.OPEN;
    this.onopen?.();
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** 送信された制御メッセージ(JSON)だけを取り出す */
  get controlMessages(): ClientMessage[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as ClientMessage);
  }

  get audioFrames(): Blob[] {
    return this.sent.filter((s): s is Blob => typeof s !== "string");
  }
}

const AUDIO: AudioFormat = {
  mimeType: "audio/webm;codecs=opus",
  codec: "opus",
  sampleRate: 48000,
  channels: 1,
  timesliceMs: 250,
};

function makeClient(overrides: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) {
  const states: ConnectionState[] = [];
  const fatals: string[] = [];
  const client = new GatewayClient({
    wsUrl: "ws://localhost:8787/ws/v1/sessions/sess_abc",
    token: "tok_secret",
    webSocketImpl: MockSocket as unknown as typeof WebSocket,
    random: () => 1, // ジッタを固定して待ち時間を決定的にする
    onState: (s) => states.push(s),
    onFatal: (r) => fatals.push(r),
    ...overrides,
  });
  return { client, states, fatals };
}

function latest(): MockSocket {
  const socket = MockSocket.instances.at(-1);
  if (!socket) throw new Error("ソケットが作られていません");
  return socket;
}

function chunk(bytes = 100): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

describe("GatewayClient", () => {
  beforeEach(() => {
    MockSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("接続", () => {
    it("token をクエリに載せて接続する", () => {
      const { client } = makeClient();
      client.connect();
      expect(latest().url).toBe("ws://localhost:8787/ws/v1/sessions/sess_abc?token=tok_secret");
    });

    it("open で state が open になる", () => {
      const { client, states } = makeClient();
      client.connect();
      latest().open();
      expect(client.state).toBe("open");
      expect(states).toEqual(["connecting", "open"]);
    });

    it("二重に connect しても接続は1本", () => {
      const { client } = makeClient();
      client.connect();
      client.connect();
      expect(MockSocket.instances).toHaveLength(1);
    });
  });

  describe("音声送信", () => {
    it("接続中は即座に送る(完了条件: チャンクが連続して届く)", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);

      client.sendAudio(chunk());
      client.sendAudio(chunk());

      expect(latest().audioFrames).toHaveLength(2);
    });

    it("start は接続時に送られる", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);
      expect(latest().controlMessages).toContainEqual({ type: "start", audio: AUDIO });
    });

    it("pause 中は音声を送らず、バッファにも積まない(完了条件)", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);
      client.pause();

      client.sendAudio(chunk());
      client.sendAudio(chunk());

      expect(latest().audioFrames).toHaveLength(0);
      expect(client.bufferedChunks).toBe(0);
      expect(latest().controlMessages).toContainEqual({ type: "pause" });
    });

    it("resume 後は再び送る", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);
      client.pause();
      client.resume();

      client.sendAudio(chunk());
      expect(latest().audioFrames).toHaveLength(1);
    });
  });

  describe("切断中のバッファリング", () => {
    it("切断中の音声を保持する", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);
      latest().serverClose(1006);

      client.sendAudio(chunk());
      client.sendAudio(chunk());

      expect(client.bufferedChunks).toBe(2);
      expect(client.bufferedMs).toBe(500);
    });

    it("再接続後にまとめて送る(完了条件: 60秒以内なら再送)", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);

      latest().serverClose(1006);
      client.sendAudio(chunk());
      client.sendAudio(chunk());
      client.sendAudio(chunk());

      vi.advanceTimersByTime(1_000);
      latest().open();

      expect(latest().audioFrames).toHaveLength(3);
      expect(client.bufferedChunks).toBe(0);
    });

    it("60秒を超えた分は捨て、通知する", () => {
      const dropped: number[] = [];
      const { client } = makeClient({ onDropped: (n) => dropped.push(n) });
      client.connect();
      latest().open();
      client.start(AUDIO);
      latest().serverClose(1006);

      // 250ms × 250 = 62.5秒 → 60秒を超えた分が捨てられる
      for (let i = 0; i < 250; i += 1) client.sendAudio(chunk());

      expect(client.bufferedMs).toBeLessThanOrEqual(60_000);
      expect(client.bufferedChunks).toBe(240);
      expect(dropped.length).toBeGreaterThan(0);
    });

    it("再接続後に start を送り直す", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);

      latest().serverClose(1006);
      vi.advanceTimersByTime(1_000);
      latest().open();

      expect(latest().controlMessages).toContainEqual({ type: "start", audio: AUDIO });
    });

    it("一時停止中に再接続したら pause も送り直す", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.start(AUDIO);
      client.pause();

      latest().serverClose(1006);
      vi.advanceTimersByTime(1_000);
      latest().open();

      const messages = latest().controlMessages;
      expect(messages).toContainEqual({ type: "start", audio: AUDIO });
      expect(messages).toContainEqual({ type: "pause" });
    });
  });

  describe("自動再接続", () => {
    it("切断されたら再接続する(完了条件: 機内モードON/OFFで復帰)", () => {
      const { client, states } = makeClient();
      client.connect();
      latest().open();

      latest().serverClose(1006);
      expect(client.state).toBe("reconnecting");

      vi.advanceTimersByTime(1_000);
      expect(MockSocket.instances).toHaveLength(2);

      latest().open();
      expect(client.state).toBe("open");
      expect(states).toContain("reconnecting");
    });

    it("再接続の待ち時間が指数的に伸びる", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();

      // 1回目: 1s
      latest().serverClose(1006);
      vi.advanceTimersByTime(999);
      expect(MockSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(MockSocket.instances).toHaveLength(2);

      // 2回目: 2s (open しないまま切れたので試行回数が増える)
      latest().serverClose(1006);
      vi.advanceTimersByTime(1_999);
      expect(MockSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(MockSocket.instances).toHaveLength(3);

      // 3回目: 4s
      latest().serverClose(1006);
      vi.advanceTimersByTime(3_999);
      expect(MockSocket.instances).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(MockSocket.instances).toHaveLength(4);
    });

    it("接続に成功したら待ち時間がリセットされる", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      latest().serverClose(1006);
      vi.advanceTimersByTime(1_000);
      latest().open(); // 成功

      latest().serverClose(1006);
      vi.advanceTimersByTime(1_000);
      expect(MockSocket.instances).toHaveLength(3);
    });
  });

  describe("再接続しないクローズコード", () => {
    it("4401(トークン不正)は再接続せず fatal を通知する", () => {
      const { client, fatals } = makeClient();
      client.connect();
      latest().serverClose(CloseCode.UNAUTHORIZED);

      vi.advanceTimersByTime(60_000);
      expect(MockSocket.instances).toHaveLength(1);
      expect(client.state).toBe("closed");
      expect(fatals).toEqual(["unauthorized"]);
    });

    it("4404(セッション不明)も再接続しない", () => {
      const { client, fatals } = makeClient();
      client.connect();
      latest().serverClose(CloseCode.NOT_FOUND);

      vi.advanceTimersByTime(60_000);
      expect(MockSocket.instances).toHaveLength(1);
      expect(fatals).toEqual(["not_found"]);
    });

    it("4409(終了済み)は再接続しない", () => {
      const { client, fatals } = makeClient();
      client.connect();
      latest().serverClose(CloseCode.ENDED);

      vi.advanceTimersByTime(60_000);
      expect(MockSocket.instances).toHaveLength(1);
      expect(fatals).toEqual(["ended"]);
    });

    it("1000(正常終了)は再接続しない", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      latest().serverClose(CloseCode.NORMAL);

      vi.advanceTimersByTime(60_000);
      expect(MockSocket.instances).toHaveLength(1);
      expect(client.state).toBe("closed");
    });

    it("4429(レート制限)は再接続する", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      latest().serverClose(CloseCode.RATE_LIMITED);

      vi.advanceTimersByTime(1_000);
      expect(MockSocket.instances).toHaveLength(2);
    });

    it("1011(サーバー内部エラー)は再接続する", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      latest().serverClose(CloseCode.INTERNAL);

      vi.advanceTimersByTime(1_000);
      expect(MockSocket.instances).toHaveLength(2);
    });
  });

  describe("生存確認", () => {
    it("30秒ごとに ping を送る", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();

      vi.advanceTimersByTime(30_000);
      expect(latest().controlMessages).toContainEqual({ type: "ping" });

      vi.advanceTimersByTime(30_000);
      expect(latest().controlMessages.filter((m) => m.type === "ping")).toHaveLength(2);
    });

    it("切断後は ping を送らない", () => {
      const { client } = makeClient();
      client.connect();
      const socket = latest();
      socket.open();
      socket.serverClose(1006);

      const before = socket.controlMessages.length;
      vi.advanceTimersByTime(120_000);
      expect(socket.controlMessages.length).toBe(before);
    });
  });

  describe("受信", () => {
    it("サーバーメッセージを渡す", () => {
      const received: unknown[] = [];
      const { client } = makeClient({ onMessage: (m) => received.push(m) });
      client.connect();
      latest().open();
      latest().emit(JSON.stringify({ type: "pong" }));
      expect(received).toEqual([{ type: "pong" }]);
    });

    it("壊れたJSONで落ちない", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      expect(() => latest().emit("{壊れた")).not.toThrow();
    });

    it("未知の type も渡す(前方互換)", () => {
      const received: unknown[] = [];
      const { client } = makeClient({ onMessage: (m) => received.push(m) });
      client.connect();
      latest().open();
      latest().emit(JSON.stringify({ type: "transcript.final", text: "こんにちは" }));
      expect(received).toHaveLength(1);
    });
  });

  describe("破棄", () => {
    it("dispose 後は再接続しない", () => {
      const { client } = makeClient();
      client.connect();
      latest().open();
      client.dispose();

      vi.advanceTimersByTime(60_000);
      expect(MockSocket.instances).toHaveLength(1);
      expect(client.state).toBe("closed");
    });

    it("dispose 後の connect は無視する", () => {
      const { client } = makeClient();
      client.dispose();
      client.connect();
      expect(MockSocket.instances).toHaveLength(0);
    });
  });
});
