import { describe, expect, it } from "vitest";
import { BACKOFF_MAX_MS, backoffDelayMs, backoffDelayWithJitterMs } from "./backoff";

describe("backoffDelayMs", () => {
  it("ARCHITECTURE.md の 1s / 2s / 4s / 8s に従う", () => {
    expect([0, 1, 2, 3].map(backoffDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("30秒で頭打ちになる", () => {
    expect(backoffDelayMs(5)).toBe(30_000);
    expect(backoffDelayMs(10)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(100)).toBe(BACKOFF_MAX_MS);
  });

  it("負の試行回数でも壊れない", () => {
    expect(backoffDelayMs(-1)).toBe(1_000);
  });
});

describe("backoffDelayWithJitterMs", () => {
  it("基準値の 50%〜100% に収まる", () => {
    for (const attempt of [0, 1, 2, 3, 4, 5]) {
      const base = backoffDelayMs(attempt);
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = backoffDelayWithJitterMs(attempt, () => r);
        expect(delay).toBeGreaterThanOrEqual(base * 0.5);
        expect(delay).toBeLessThanOrEqual(base);
      }
    }
  });

  it("乱数が同じなら結果も同じ(決定的)", () => {
    expect(backoffDelayWithJitterMs(3, () => 0.5)).toBe(backoffDelayWithJitterMs(3, () => 0.5));
  });

  it("上限を超えない", () => {
    expect(backoffDelayWithJitterMs(20, () => 1)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });
});
