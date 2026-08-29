import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./format";

describe("formatDuration", () => {
  it("1分未満は mm:ss", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(5_400)).toBe("00:05");
    expect(formatDuration(59_999)).toBe("00:59");
  });

  it("1分以上も mm:ss", () => {
    expect(formatDuration(60_000)).toBe("01:00");
    expect(formatDuration(30 * 60_000)).toBe("30:00");
  });

  it("1時間以上は h:mm:ss", () => {
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("負の値は 00:00 に丸める", () => {
    expect(formatDuration(-1)).toBe("00:00");
  });
});

describe("formatBytes", () => {
  it("単位を切り替える", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
