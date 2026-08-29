import { describe, expect, it } from "vitest";
import { OfflineBuffer } from "./offlineBuffer";

/** 250ms 相当のチャンクを作る(既定のタイムスライス) */
function chunk(durationMs = 250, bytes = 100) {
  return { data: new Blob([new Uint8Array(bytes)]), durationMs };
}

describe("OfflineBuffer", () => {
  it("空で始まる", () => {
    const buffer = new OfflineBuffer();
    expect(buffer.size).toBe(0);
    expect(buffer.durationMs).toBe(0);
  });

  it("追加した分だけ長さが増える", () => {
    const buffer = new OfflineBuffer();
    buffer.push(chunk());
    buffer.push(chunk());
    expect(buffer.size).toBe(2);
    expect(buffer.durationMs).toBe(500);
  });

  it("60秒(既定)まで保持する", () => {
    const buffer = new OfflineBuffer();
    for (let i = 0; i < 240; i += 1) buffer.push(chunk());
    expect(buffer.durationMs).toBe(60_000);
    expect(buffer.size).toBe(240);
    expect(buffer.droppedChunks).toBe(0);
  });

  it("60秒を超えたら古い方から捨てる", () => {
    const buffer = new OfflineBuffer();
    for (let i = 0; i < 250; i += 1) buffer.push(chunk());
    expect(buffer.durationMs).toBeLessThanOrEqual(60_000);
    expect(buffer.size).toBe(240);
    expect(buffer.droppedChunks).toBe(10);
  });

  it("捨てるのは古い方(直近の発話を残す)", () => {
    const buffer = new OfflineBuffer(500);
    const first = chunk(250);
    const second = chunk(250);
    const third = chunk(250);
    buffer.push(first);
    buffer.push(second);
    buffer.push(third);

    const drained = buffer.drain();
    expect(drained).toEqual([second, third]);
  });

  it("drain で空になる", () => {
    const buffer = new OfflineBuffer();
    buffer.push(chunk());
    expect(buffer.drain()).toHaveLength(1);
    expect(buffer.size).toBe(0);
    expect(buffer.durationMs).toBe(0);
  });

  it("drain の戻り値は追加順", () => {
    const buffer = new OfflineBuffer();
    const a = chunk(250, 1);
    const b = chunk(250, 2);
    buffer.push(a);
    buffer.push(b);
    expect(buffer.drain()).toEqual([a, b]);
  });

  it("clear で捨てられる", () => {
    const buffer = new OfflineBuffer();
    buffer.push(chunk());
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);
  });

  it("上限より長い単一チャンクは残す(捨てると音声が全く残らないため)", () => {
    const buffer = new OfflineBuffer(1_000);
    buffer.push(chunk(5_000));
    expect(buffer.size).toBe(1);
    expect(buffer.droppedChunks).toBe(0);
  });

  it("最後の1つは必ず残る", () => {
    const buffer = new OfflineBuffer(100);
    buffer.push(chunk(250));
    buffer.push(chunk(250));
    expect(buffer.size).toBe(1);
    expect(buffer.droppedChunks).toBe(1);
  });
});
