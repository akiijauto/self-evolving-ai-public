import { describe, expect, it } from "vitest";
import { renderEmpty, renderMeeting, renderTranscriptEntry, toClock, toLocalIso } from "./format.js";

/**
 * DATAFLOW.md の「Markdownスキーマ」に対する検証。
 * ここが崩れると、後段のAgentが読む形が変わってしまう。
 */

// ローカルの時刻部品から作る。テスト環境のタイムゾーンに依存させない
const at = (h: number, m: number, s: number): Date => new Date(2026, 7, 1, h, m, s);

describe("時刻の整形", () => {
  it("HH:MM:SS でゼロ埋めする", () => {
    expect(toClock(at(9, 0, 12))).toBe("09:00:12");
    expect(toClock(at(14, 5, 3))).toBe("14:05:03");
  });

  it("ISO 8601 をローカルのオフセット付きで書く", () => {
    // UTC固定の toISOString と違い、商談の記録は現地時刻で読みたい
    expect(toLocalIso(at(9, 0, 0))).toMatch(/^2026-08-01T09:00:00[+-]\d{2}:\d{2}$/);
  });
});

describe("meeting.md", () => {
  const base = {
    sessionId: "sess_0123456789abcdef0123456789abcdef",
    startedAt: at(9, 0, 0),
    title: "株式会社◯◯ 業務改善ヒアリング",
    participants: [
      { side: "自社", names: ["田中"] },
      { side: "顧客", names: ["佐藤様", "鈴木様"] },
    ],
  };

  it("商談中は ended_at を空にする", () => {
    const text = renderMeeting({ ...base, endedAt: null, status: "active" });

    expect(text).toContain("# Meeting");
    expect(text).toContain("- session_id: sess_0123456789abcdef0123456789abcdef");
    expect(text).toContain("- title: 株式会社◯◯ 業務改善ヒアリング");
    expect(text).toContain("- ended_at:\n");
    expect(text).toContain("- status: active");
  });

  it("参加者を側ごとにぶら下げる", () => {
    const text = renderMeeting({ ...base, endedAt: null, status: "active" });

    expect(text).toContain("- participants:\n  - 自社: 田中\n  - 顧客: 佐藤様、鈴木様");
  });

  it("終了後は ended_at と status が埋まる", () => {
    const text = renderMeeting({ ...base, endedAt: at(9, 28, 40), status: "ended" });

    expect(text).toMatch(/- ended_at: 2026-08-01T09:28:40/);
    expect(text).toContain("- status: ended");
  });

  it("題名が無ければ項目だけ残す", () => {
    const text = renderMeeting({ ...base, title: null, endedAt: null, status: "active" });

    expect(text).toContain("- title:\n");
  });
});

describe("transcript.md", () => {
  it("話者つきの見出しを作る", () => {
    const text = renderTranscriptEntry({
      at: at(9, 0, 12),
      speaker: "A",
      text: "在庫の管理を今もExcelでやっていて、担当者しか触れない状態です。",
    });

    expect(text).toBe(
      "\n## 09:00:12 | A\n在庫の管理を今もExcelでやっていて、担当者しか触れない状態です。\n",
    );
  });

  it("話者分離が無ければ時刻だけの見出しにする", () => {
    const text = renderTranscriptEntry({ at: at(9, 0, 35), speaker: null, text: "更新の頻度は。" });

    expect(text).toBe("\n## 09:00:35\n更新の頻度は。\n");
  });

  it("本文の改行を潰して1段落にする", () => {
    // 認識結果に改行が混ざっても、1発話=1見出し+1段落を崩さない
    const text = renderTranscriptEntry({
      at: at(9, 1, 0),
      speaker: "B",
      text: "毎朝1回です。\nただ実態とズレることが多くて。",
    });

    expect(text).toBe("\n## 09:01:00 | B\n毎朝1回です。 ただ実態とズレることが多くて。\n");
  });

  it("本文に見出し記号が来ても構造を壊さない", () => {
    const text = renderTranscriptEntry({
      at: at(9, 2, 0),
      speaker: "A",
      text: "見出しは\n## 09:00:00 | X\nのように書きます",
    });

    // 追加される `## ` は1つだけ。本文側は行頭に来ない
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(1);
  });

  it("ハイフンや記号は残す", () => {
    const text = renderTranscriptEntry({ at: at(9, 3, 0), speaker: null, text: "A-1の在庫は 12個" });

    expect(text).toContain("A-1の在庫は 12個");
  });
});

describe("空のドキュメント", () => {
  it("見出しだけを置く", () => {
    expect(renderEmpty("# Realtime Transcript")).toBe("# Realtime Transcript\n");
  });
});
