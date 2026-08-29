import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLastSession, loadLastSession, saveLastSession } from "./lastSession";

/** sessionStorage を差し替える。jsdom を使わずに済ませる */
function useMemoryStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
  return data;
}

describe("直前のセッションの記憶", () => {
  beforeEach(() => {
    useMemoryStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("保存したものを読み戻せる", () => {
    saveLastSession("sess_abc", "token-1");
    expect(loadLastSession()).toMatchObject({ sessionId: "sess_abc", token: "token-1" });
  });

  it("何も無ければ null", () => {
    expect(loadLastSession()).toBeNull();
  });

  it("消せる", () => {
    saveLastSession("sess_abc", "token-1");
    clearLastSession();
    expect(loadLastSession()).toBeNull();
  });

  it("古すぎる記録は使わない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00Z"));
    saveLastSession("sess_abc", "token-1");

    // セッション自体の寿命(4時間)を過ぎたら、押しても401になるだけ
    vi.setSystemTime(new Date("2026-08-03T04:00:01Z"));
    expect(loadLastSession()).toBeNull();
  });

  it("壊れた記録で落ちない", () => {
    const data = useMemoryStorage();
    data.set("rt-mvp.last-session", "{壊れている");
    expect(loadLastSession()).toBeNull();

    data.set("rt-mvp.last-session", JSON.stringify({ sessionId: "sess_abc" }));
    expect(loadLastSession()).toBeNull();
  });

  it("書けない環境でも例外を投げない", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("拒否");
      },
      setItem: () => {
        throw new Error("拒否");
      },
      removeItem: () => {
        throw new Error("拒否");
      },
    });

    // プライベートモードなどで起きる。記録できなくても商談は続く
    expect(() => saveLastSession("sess_abc", "token-1")).not.toThrow();
    expect(loadLastSession()).toBeNull();
    expect(() => clearLastSession()).not.toThrow();
  });
});
