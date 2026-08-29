import { describe, expect, it } from "vitest";
import { labelOf, parseMarkdown, sortForDisplay } from "./markdown";

describe("Markdownの解釈", () => {
  it("見出しの階層を分ける", () => {
    expect(parseMarkdown("# Issues\n\n## ISS-001 属人化\n")).toEqual([
      { kind: "h1", text: "Issues" },
      { kind: "h2", text: "ISS-001 属人化" },
    ]);
  });

  it("連続する箇条書きを1つにまとめる", () => {
    expect(parseMarkdown("- 根拠: A\n- 影響: B\n")).toEqual([
      {
        kind: "list",
        items: [
          { text: "根拠: A", checked: null },
          { text: "影響: B", checked: null },
        ],
      },
    ]);
  });

  it("チェックリストの状態を読む", () => {
    expect(parseMarkdown("- [ ] 未完了\n- [x] 完了\n")).toEqual([
      {
        kind: "list",
        items: [
          { text: "未完了", checked: false },
          { text: "完了", checked: true },
        ],
      },
    ]);
  });

  it("空行で段落を切る", () => {
    expect(parseMarkdown("一行目\n続き\n\n次の段落\n")).toEqual([
      { kind: "p", text: "一行目 続き" },
      { kind: "p", text: "次の段落" },
    ]);
  });

  it("見出しで箇条書きを閉じる", () => {
    const blocks = parseMarkdown("## A\n- 1\n## B\n- 2\n");

    expect(blocks.map((block) => block.kind)).toEqual(["h2", "list", "h2", "list"]);
  });

  it("空文字は空の配列", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("3階層以上の見出しは段落として扱う", () => {
    // スキーマに `###` は出てこない。descend させずそのまま見せる
    expect(parseMarkdown("### 深い見出し")).toEqual([{ kind: "p", text: "### 深い見出し" }]);
  });
});

describe("表示名", () => {
  it("ファイル名を日本語にする", () => {
    expect(labelOf("issues.md")).toBe("課題");
    expect(labelOf("requirements.md")).toBe("要件定義");
  });

  it("知らない名前はそのまま出す", () => {
    expect(labelOf("unknown.md")).toBe("unknown.md");
  });
});

describe("並び順", () => {
  it("商談中に見たい順に並べる", () => {
    expect(sortForDisplay(["meeting.md", "requirements.md", "issues.md"])).toEqual([
      "issues.md",
      "requirements.md",
      "meeting.md",
    ]);
  });

  it("知らないファイルは後ろへ回す", () => {
    expect(sortForDisplay(["zzz.md", "issues.md"])).toEqual(["issues.md", "zzz.md"]);
  });
});
