import { describe, expect, it } from "vitest";
import { buildInput, buildSystem } from "../agents/prompts.js";
import { LLMError } from "./types.js";
import { MockLLMProvider } from "./mockLLMProvider.js";

/**
 * モックLLMの検証。
 *
 * 問うのは推論の質ではなく、**DATAFLOW.md のスキーマに沿った形が出ること**と、
 * 同じ入力から同じ出力が出ること。この2つが崩れると経路の検証に使えない。
 */

const llm = new MockLLMProvider();

const TRANSCRIPT = `## 09:00:12 | A
在庫の管理は今どうされていますか。

## 09:00:20 | B
Excelで管理していて、担当者しか触れない状態です。

## 09:00:41 | B
毎朝1回です。ただ実態とズレることが多くて。
`;

const issueCall = (transcript: string, issues = "", ideas = ""): Parameters<typeof llm.complete>[0] => ({
  system: buildSystem("issue", null),
  input: buildInput([
    { title: "issues.md の現在値", body: issues },
    { title: "ideas.md の現在値", body: ideas },
    { title: "新しい会話(未処理分)", body: transcript },
  ]),
});

describe("Issue Agent", () => {
  it("課題とアイデアをスキーマどおりに返す", async () => {
    const { text } = await llm.complete(issueCall(TRANSCRIPT));

    expect(text).toContain("# Issues");
    expect(text).toContain("# Ideas");
    expect(text).toMatch(/## ISS-\d{3} .+/);
    expect(text).toMatch(/- 深刻度: (high|medium|low)/);
    expect(text).toMatch(/- 状態: open/);
    expect(text).toMatch(/## IDEA-\d{3} .+/);
    expect(text).toMatch(/- 対応課題: .+/);
  });

  it("根拠に発話時刻と引用を入れる", async () => {
    const { text } = await llm.complete(issueCall(TRANSCRIPT));

    expect(text).toMatch(/- 根拠: \d{2}:\d{2}:\d{2} 「.+」/);
  });

  it("同じ話題は言い回しが違っても同じ見出しになる", async () => {
    const first = await llm.complete(issueCall("## 09:00:20 | B\n担当者しか触れない状態です。\n"));
    const second = await llm.complete(issueCall("## 09:10:00 | B\n本人しか分からないんです。\n"));

    // Orchestrator側のマージで二重登録にならないことの前提
    expect(first.text).toContain("データが属人化している");
    expect(second.text).toContain("データが属人化している");
  });

  it("課題が無ければ見出しだけを返す", async () => {
    const { text } = await llm.complete(issueCall("## 09:00:00 | A\n本日はありがとうございます。\n"));

    expect(text).not.toMatch(/## ISS-/);
    expect(text).toContain("# Issues");
  });

  it("同じ入力からは同じ出力が出る", async () => {
    const a = await llm.complete(issueCall(TRANSCRIPT));
    const b = await llm.complete(issueCall(TRANSCRIPT));

    expect(a.text).toBe(b.text);
  });
});

describe("Requirement Agent", () => {
  it("画面を3個以内に抑え、対象外を書く", async () => {
    const { text } = await llm.complete({
      system: buildSystem("requirement", null),
      input: buildInput([
        { title: "issues.md", body: "## ISS-001 データが属人化している\n- 深刻度: high\n" },
        { title: "ideas.md", body: "## IDEA-001 共有ダッシュボードを用意する\n- 実現難易度: low\n" },
        { title: "transcript.md", body: TRANSCRIPT },
      ]),
    });

    expect(text).toContain("# Requirements");
    for (const section of ["## 目的", "## 対象ユーザー", "## 機能要件", "## データモデル", "## 画面", "## 対象外"]) {
      expect(text).toContain(section);
    }
    expect(countScreens(text)).toBeLessThanOrEqual(3);
    expect(text).toMatch(/- FR-1 /);
  });
});

describe("UI Agent", () => {
  it("画面数が要件定義を超えない", async () => {
    const requirements = "## 画面\n- 一覧画面\n- 更新モーダル\n\n## 対象外\n- 認証\n";
    const { text } = await llm.complete({
      system: buildSystem("ui", null),
      input: buildInput([
        { title: "requirements.md", body: requirements },
        { title: "issues.md", body: "" },
      ]),
    });

    expect(text).toContain("# UI");
    expect(text.match(/^## 画面\d+:/gm)).toHaveLength(2);
  });
});

describe("Transcript Agent", () => {
  it("summary.md のセクションを揃える", async () => {
    const { text } = await llm.complete({
      system: buildSystem("summary", null),
      input: buildInput([
        { title: "issues.md", body: "## ISS-001 データが属人化している\n" },
        { title: "ideas.md", body: "## IDEA-001 共有ダッシュボードを用意する\n" },
        { title: "transcript.md", body: TRANSCRIPT },
      ]),
    });

    for (const section of ["## 商談概要", "## 会話の要点", "## 抽出した課題", "## 提案した解決策", "## 生成したMVP", "## 次のアクション"]) {
      expect(text).toContain(section);
    }
    expect(text).toContain("todo.md を参照");
  });

  it("todo.md はチェックリストで返す", async () => {
    const { text } = await llm.complete({
      system: buildSystem("todo", null),
      input: buildInput([
        { title: "issues.md", body: "## ISS-001 データが属人化している\n" },
        { title: "ideas.md", body: "" },
        { title: "transcript.md", body: TRANSCRIPT },
      ]),
    });

    expect(text).toContain("# Todo");
    expect(text).toMatch(/- \[ \] .+ — 担当: .+ — 期限: .+/);
  });
});

describe("失敗の再現", () => {
  it("fail 指定なら必ず失敗し、再試行の見込みを伝える", async () => {
    const failing = new MockLLMProvider({ fail: true });

    await expect(failing.complete(issueCall(TRANSCRIPT))).rejects.toBeInstanceOf(LLMError);
    await expect(failing.complete(issueCall(TRANSCRIPT))).rejects.toMatchObject({ retryable: true });
  });

  it("Agentを判定できないプロンプトは拒む", async () => {
    await expect(llm.complete({ system: "よろしく", input: "何か" })).rejects.toBeInstanceOf(LLMError);
  });
});

describe("使用量", () => {
  it("モックは実測値を持たないので null を返す", async () => {
    // 数字を入れると実測と取り違える
    expect((await llm.complete(issueCall(TRANSCRIPT))).usage).toBeNull();
  });
});

function countScreens(requirements: string): number {
  const lines = requirements.split("\n");
  const start = lines.indexOf("## 画面");
  if (start === -1) return 0;

  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("##")) break;
    if (line.trim().startsWith("- ")) count += 1;
  }
  return count;
}
