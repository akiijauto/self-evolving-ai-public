import { describe, expect, it } from "vitest";
import { mergeItems, parseItems, renderItems } from "./items.js";

/**
 * `issues.md` / `ideas.md` のマージ規則。
 * ROADMAP.md Sprint 5 の完了条件「同じ課題が二重に追加されない」を担保する部分。
 */

const EXISTING = `# Issues

## ISS-001 在庫データが属人化している
- 根拠: 09:00:12 「担当者しか触れない状態です」
- 影響: 担当者不在時に在庫確認が停止する
- 深刻度: high
- 状態: open
`;

describe("読み取り", () => {
  it("見出しと項目を読む", () => {
    const items = parseItems(EXISTING);

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("ISS-001");
    expect(items[0]?.title).toBe("在庫データが属人化している");
    expect(items[0]?.fields).toEqual([
      { key: "根拠", value: "09:00:12 「担当者しか触れない状態です」" },
      { key: "影響", value: "担当者不在時に在庫確認が停止する" },
      { key: "深刻度", value: "high" },
      { key: "状態", value: "open" },
    ]);
  });

  it("空文字は空の配列", () => {
    expect(parseItems("")).toEqual([]);
  });

  it("解釈できない行は捨てる", () => {
    // LLMの出力が相手なので、余計な前置きが混ざっても壊れない
    const items = parseItems("承知しました。\n\n## ISS-001 課題\n- 影響: あり\nおまけの文\n");

    expect(items).toHaveLength(1);
    expect(items[0]?.fields).toEqual([{ key: "影響", value: "あり" }]);
  });

  it("全角コロンも読む", () => {
    expect(parseItems("## ISS-001 課題\n- 影響：あり\n")[0]?.fields).toEqual([
      { key: "影響", value: "あり" },
    ]);
  });
});

describe("マージ", () => {
  it("見出しが同じなら新規追加しない", () => {
    const merged = mergeItems(
      parseItems(EXISTING),
      parseItems("## ISS-007 在庫データが属人化している\n- 根拠: 09:05:00 「本人しか分からない」\n"),
      "ISS",
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("ISS-001");
    // 根拠は積み増す
    expect(merged[0]?.fields.filter((f) => f.key === "根拠")).toHaveLength(2);
  });

  it("同じ根拠は二度足さない", () => {
    const merged = mergeItems(
      parseItems(EXISTING),
      parseItems("## ISS-001 在庫データが属人化している\n- 根拠: 09:00:12 「担当者しか触れない状態です」\n"),
      "ISS",
    );

    expect(merged[0]?.fields.filter((f) => f.key === "根拠")).toHaveLength(1);
  });

  it("同じ発言なら時刻が違っても足さない", () => {
    // 30分リハーサルで実際に起きた積み上がり方。
    // 同じ話題が繰り返し出るたびに、時刻だけが違う根拠が増えていた
    const merged = mergeItems(
      parseItems(EXISTING),
      parseItems("## ISS-001 在庫データが属人化している\n- 根拠: 09:31:40 「担当者しか触れない状態です」\n"),
      "ISS",
    );

    expect(merged[0]?.fields.filter((f) => f.key === "根拠")).toHaveLength(1);
  });

  it("根拠は3件で打ち止めにする(画面共有で読める長さに保つ)", () => {
    let items = parseItems(EXISTING);
    for (const [index, text] of ["二人目も同じ", "月次でも起きる", "棚卸しでも困る", "監査でも指摘"].entries()) {
      items = mergeItems(
        items,
        parseItems(`## ISS-001 在庫データが属人化している\n- 根拠: 09:0${index}:00 「${text}」\n`),
        "ISS",
      );
    }

    const evidence = items[0]?.fields.filter((f) => f.key === "根拠") ?? [];
    expect(evidence).toHaveLength(3);
    // 残るのは先頭から。その課題がどう立ち上がったかを保ち、後から来た分は捨てる
    expect(evidence[0]?.value).toContain("担当者しか触れない状態です");
    expect(evidence[1]?.value).toContain("二人目も同じ");
    expect(evidence.map((f) => f.value).join()).not.toContain("監査でも指摘");
  });

  it("表記ゆれを吸収する", () => {
    const merged = mergeItems(
      parseItems(EXISTING),
      parseItems("## ISS-002 在庫データが属人化している。\n- 深刻度: medium\n"),
      "ISS",
    );

    expect(merged).toHaveLength(1);
  });

  it("単一値のキーは上書きする", () => {
    const merged = mergeItems(
      parseItems(EXISTING),
      parseItems("## ISS-001 在庫データが属人化している\n- 状態: merged\n"),
      "ISS",
    );

    expect(merged[0]?.fields.find((f) => f.key === "状態")?.value).toBe("merged");
    expect(merged[0]?.fields.filter((f) => f.key === "状態")).toHaveLength(1);
  });

  it("新しい課題は採番し直して追加する", () => {
    const merged = mergeItems(
      parseItems(EXISTING),
      parseItems("## ISS-001 実在庫と記録が乖離している\n- 深刻度: high\n"),
      "ISS",
    );

    // LLMが既存のIDを使い回しても、見出しが違えば別の課題として扱う
    expect(merged).toHaveLength(2);
    expect(merged[1]?.id).toBe("ISS-002");
  });

  it("見出しが無ければIDで突き合わせる", () => {
    const merged = mergeItems(parseItems(EXISTING), parseItems("## ISS-001\n- 状態: merged\n"), "ISS");

    expect(merged).toHaveLength(1);
    expect(merged[0]?.fields.find((f) => f.key === "状態")?.value).toBe("merged");
  });

  it("既存が空でも採番できる", () => {
    const merged = mergeItems([], parseItems("## IDEA-999 共有画面\n- 実現難易度: low\n"), "IDEA");

    expect(merged[0]?.id).toBe("IDEA-001");
  });

  it("元の配列を書き換えない", () => {
    const existing = parseItems(EXISTING);
    mergeItems(existing, parseItems("## ISS-001 在庫データが属人化している\n- 状態: merged\n"), "ISS");

    expect(existing[0]?.fields.find((f) => f.key === "状態")?.value).toBe("open");
  });
});

describe("書き出し", () => {
  it("読んで書いても形が変わらない", () => {
    expect(renderItems("# Issues", parseItems(EXISTING))).toBe(EXISTING);
  });

  it("空でも見出しは残す", () => {
    expect(renderItems("# Ideas", [])).toBe("# Ideas\n");
  });
});
