import { describe, expect, it } from "vitest";
import { initialRecorderState, isCapturing, recorderReducer, shouldReleaseMic } from "./machine";
import type { Clip, RecorderEvent, RecorderState } from "./types";

const clip: Clip = {
  url: "blob:test",
  mimeType: "audio/webm;codecs=opus",
  sizeBytes: 1024,
  durationMs: 5000,
};

/** イベント列を順に適用する */
function run(events: RecorderEvent[], from: RecorderState = initialRecorderState): RecorderState {
  return events.reduce(recorderReducer, from);
}

describe("recorderReducer", () => {
  it("初期状態は idle で、エラーも録音結果も持たない", () => {
    expect(initialRecorderState).toEqual({ status: "idle", error: null, clip: null });
  });

  describe("マイク権限", () => {
    it("REQUEST で requesting へ進む", () => {
      expect(run([{ type: "REQUEST" }]).status).toBe("requesting");
    });

    it("許可されると録音が始まる(完了条件: 権限を許可すると録音が始まる)", () => {
      expect(run([{ type: "REQUEST" }, { type: "GRANTED" }]).status).toBe("recording");
    });

    it("拒否されると denied になり、理由が残る(アプリは壊れない)", () => {
      const state = run([{ type: "REQUEST" }, { type: "DENIED", message: "マイクが拒否されました" }]);
      expect(state.status).toBe("denied");
      expect(state.error).toBe("マイクが拒否されました");
    });

    it("拒否後にもう一度要求できる", () => {
      const denied = run([{ type: "REQUEST" }, { type: "DENIED", message: "拒否" }]);
      const retried = run([{ type: "REQUEST" }, { type: "GRANTED" }], denied);
      expect(retried.status).toBe("recording");
      expect(retried.error).toBeNull();
    });

    it("録音中の REQUEST は無視する(二重にマイクを開かない)", () => {
      const recording = run([{ type: "REQUEST" }, { type: "GRANTED" }]);
      expect(recorderReducer(recording, { type: "REQUEST" })).toBe(recording);
    });
  });

  describe("一時停止と再開", () => {
    const recording = run([{ type: "REQUEST" }, { type: "GRANTED" }]);

    it("録音中に PAUSE すると paused になる", () => {
      expect(recorderReducer(recording, { type: "PAUSE" }).status).toBe("paused");
    });

    it("一時停止中に RESUME すると recording へ戻る", () => {
      expect(run([{ type: "PAUSE" }, { type: "RESUME" }], recording).status).toBe("recording");
    });

    it("録音中でないときの PAUSE は無視する", () => {
      expect(recorderReducer(initialRecorderState, { type: "PAUSE" })).toBe(initialRecorderState);
    });

    it("一時停止中でないときの RESUME は無視する", () => {
      expect(recorderReducer(recording, { type: "RESUME" })).toBe(recording);
    });

    it("一時停止したまま停止できる", () => {
      expect(run([{ type: "PAUSE" }, { type: "STOP" }], recording).status).toBe("stopped");
    });
  });

  describe("停止と再生", () => {
    const recording = run([{ type: "REQUEST" }, { type: "GRANTED" }]);

    it("STOP 直後はまだ clip を持たない", () => {
      const stopped = recorderReducer(recording, { type: "STOP" });
      expect(stopped.status).toBe("stopped");
      expect(stopped.clip).toBeNull();
    });

    it("RECORDED で clip が入り、再生可能になる", () => {
      const state = run([{ type: "STOP" }, { type: "RECORDED", clip }], recording);
      expect(state.clip).toEqual(clip);
    });

    it("録音中に届いた RECORDED は破棄する", () => {
      expect(recorderReducer(recording, { type: "RECORDED", clip })).toBe(recording);
    });

    it("RESET で初期状態へ戻る", () => {
      const state = run([{ type: "STOP" }, { type: "RECORDED", clip }, { type: "RESET" }], recording);
      expect(state).toEqual(initialRecorderState);
    });

    it("録音中の RESET は無視する(録音を取りこぼさない)", () => {
      expect(recorderReducer(recording, { type: "RESET" })).toBe(recording);
    });
  });

  describe("失敗", () => {
    it("FAIL はどの状態からでも error へ落ちる", () => {
      const recording = run([{ type: "REQUEST" }, { type: "GRANTED" }]);
      const failed = recorderReducer(recording, { type: "FAIL", message: "デバイスが切断されました" });
      expect(failed.status).toBe("error");
      expect(failed.error).toBe("デバイスが切断されました");
    });

    it("error からは再要求できる", () => {
      const failed = recorderReducer(initialRecorderState, { type: "FAIL", message: "失敗" });
      expect(run([{ type: "REQUEST" }, { type: "GRANTED" }], failed).status).toBe("recording");
    });
  });

  describe("補助関数", () => {
    it("isCapturing は recording と paused のときだけ true", () => {
      const statuses: RecorderState["status"][] = [
        "idle",
        "requesting",
        "denied",
        "recording",
        "paused",
        "stopped",
        "error",
      ];
      const capturing = statuses.filter((status) =>
        isCapturing({ status, error: null, clip: null }),
      );
      expect(capturing).toEqual(["recording", "paused"]);
    });

    it("shouldReleaseMic は isCapturing の否定", () => {
      expect(shouldReleaseMic({ status: "recording", error: null, clip: null })).toBe(false);
      expect(shouldReleaseMic({ status: "stopped", error: null, clip: null })).toBe(true);
    });
  });
});
