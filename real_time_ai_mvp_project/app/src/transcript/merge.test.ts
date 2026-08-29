import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@rt-mvp/protocol";
import {
  appendBacklog,
  appendFinal,
  initialTranscriptState,
  setPartial,
  toDisplayLines,
  type TranscriptState,
} from "./merge";

function seg(seq: number, text: string, speaker: string | null = "A"): TranscriptSegment {
  return { seq, text, speaker, startMs: 0, endMs: 1_000, at: "2026-08-01T09:00:00Z" };
}

function build(...segments: TranscriptSegment[]): TranscriptState {
  return segments.reduce(appendFinal, initialTranscriptState);
}

describe("appendFinal", () => {
  it("確定した行を追記する", () => {
    const state = build(seg(1, "一つ目"), seg(2, "二つ目"));
    expect(state.segments.map((s) => s.text)).toEqual(["一つ目", "二つ目"]);
    expect(state.lastSeq).toBe(2);
  });

  it("確定すると未確定が消える(表示が乱れない)", () => {
    const withPartial = setPartial(initialTranscriptState, { text: "こんに", speaker: "A" });
    const state = appendFinal(withPartial, seg(1, "こんにちは"));
    expect(state.partial).toBeNull();
    expect(state.segments).toHaveLength(1);
  });

  it("既知の seq は無視する(再接続で重複しない)", () => {
    const state = build(seg(1, "一つ目"), seg(2, "二つ目"));
    const again = appendFinal(state, seg(2, "二つ目"));
    expect(again.segments).toHaveLength(2);
    expect(again.lastSeq).toBe(2);
  });

  it("既知の seq でも未確定は消す", () => {
    const state = setPartial(build(seg(1, "一つ目")), { text: "途中", speaker: "A" });
    const again = appendFinal(state, seg(1, "一つ目"));
    expect(again.partial).toBeNull();
    expect(again.segments).toHaveLength(1);
  });

  it("話者ラベルを保持する", () => {
    const state = build(seg(1, "質問です", "A"), seg(2, "回答です", "B"));
    expect(state.segments.map((s) => s.speaker)).toEqual(["A", "B"]);
  });

  it("話者ラベルが無くても扱える", () => {
    const state = build(seg(1, "話者不明", null));
    expect(state.segments[0]?.speaker).toBeNull();
  });
});

describe("appendBacklog", () => {
  it("切断中の確定分をまとめて取り込む", () => {
    const state = appendBacklog(initialTranscriptState, [seg(1, "一"), seg(2, "二"), seg(3, "三")]);
    expect(state.segments.map((s) => s.text)).toEqual(["一", "二", "三"]);
    expect(state.lastSeq).toBe(3);
  });

  it("既に持っている行は重複させない(完了条件: 再接続で重複しない)", () => {
    const state = build(seg(1, "一"), seg(2, "二"));
    const merged = appendBacklog(state, [seg(1, "一"), seg(2, "二"), seg(3, "三")]);
    expect(merged.segments.map((s) => s.text)).toEqual(["一", "二", "三"]);
  });

  it("順序が乱れて届いても seq 順に並べる", () => {
    const state = appendBacklog(initialTranscriptState, [seg(3, "三"), seg(1, "一"), seg(2, "二")]);
    expect(state.segments.map((s) => s.text)).toEqual(["一", "二", "三"]);
  });

  it("空でも壊れない", () => {
    expect(appendBacklog(initialTranscriptState, [])).toEqual(initialTranscriptState);
  });
});

describe("setPartial", () => {
  it("未確定を差し替える", () => {
    let state = setPartial(initialTranscriptState, { text: "こん", speaker: "A" });
    state = setPartial(state, { text: "こんにちは", speaker: "A" });
    expect(state.partial?.text).toBe("こんにちは");
  });

  it("未確定は1つしか持たない", () => {
    const state = setPartial(
      setPartial(initialTranscriptState, { text: "あ", speaker: "A" }),
      { text: "い", speaker: "B" },
    );
    expect(toDisplayLines(state).filter((l) => !l.confirmed)).toHaveLength(1);
  });

  it("空文字は未確定なしとして扱う", () => {
    const state = setPartial(
      setPartial(initialTranscriptState, { text: "あ", speaker: "A" }),
      { text: "", speaker: "A" },
    );
    expect(state.partial).toBeNull();
  });

  it("確定分には影響しない", () => {
    const state = setPartial(build(seg(1, "確定")), { text: "未確定", speaker: "A" });
    expect(state.segments).toHaveLength(1);
    expect(state.lastSeq).toBe(1);
  });
});

describe("toDisplayLines", () => {
  it("確定分のあとに未確定を1つ置く", () => {
    const state = setPartial(build(seg(1, "確定1"), seg(2, "確定2")), {
      text: "未確定",
      speaker: "B",
    });
    const lines = toDisplayLines(state);

    expect(lines.map((l) => l.text)).toEqual(["確定1", "確定2", "未確定"]);
    expect(lines.map((l) => l.confirmed)).toEqual([true, true, false]);
  });

  it("key が重複しない(Reactの再描画が乱れない)", () => {
    const state = setPartial(build(seg(1, "a"), seg(2, "b"), seg(3, "c")), {
      text: "d",
      speaker: null,
    });
    const keys = toDisplayLines(state).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("空の状態では何も出さない", () => {
    expect(toDisplayLines(initialTranscriptState)).toEqual([]);
  });
});
