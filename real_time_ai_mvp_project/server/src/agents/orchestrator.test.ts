import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@rt-mvp/protocol";
import { TemplateCodeProvider } from "../codegen/templateCodeProvider.js";
import type { CodeProvider, CodeRequest, FileMap } from "../codegen/types.js";
import { LocalStaticDeployProvider } from "../deploy/localStaticDeployProvider.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../llm/types.js";
import { MockLLMProvider } from "../llm/mockLLMProvider.js";
import { MarkdownStore } from "../markdown/store.js";
import { SessionDocuments } from "../markdown/sessionDocuments.js";
import { SessionStore, type Session } from "../sessions/store.js";
import { AgentHistory } from "./history.js";
import { ConflictError, Orchestrator } from "./orchestrator.js";

/**
 * Orchestrator の検証。ROADMAP.md Sprint 5 の完了条件に対応する。
 * 実際にファイルへ書き、LLMの呼び出し内容も記録して確かめる。
 */

/** 呼び出し内容を覚えておくラッパー。差分だけが投入されているかを見る */
class RecordingLLM implements LLMProvider {
  readonly calls: LLMRequest[] = [];

  constructor(private readonly inner: LLMProvider) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return this.inner.complete(req);
  }
}

let dataDir: string;
let store: SessionStore;
let docs: SessionDocuments;
let history: AgentHistory;
let llm: RecordingLLM;
let messages: { sessionId: string; message: ServerMessage }[];
let deploy: LocalStaticDeployProvider;
let orchestrator: Orchestrator;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "rt-mvp-orch-"));
  const markdown = new MarkdownStore({ dataDir });
  store = new SessionStore({ ttlMs: 60_000 });
  docs = new SessionDocuments(markdown);
  history = new AgentHistory(markdown);
  llm = new RecordingLLM(new MockLLMProvider());
  deploy = new LocalStaticDeployProvider({ dataDir });
  messages = [];

  orchestrator = build(llm);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function build(
  provider: LLMProvider,
  code: CodeProvider = new TemplateCodeProvider(),
  extra: {
    triggerCooldownMs?: number;
    codeAttempts?: number;
    jobBudgetMs?: number;
    now?: () => number;
  } = {},
): Orchestrator {
  return new Orchestrator({
    docs,
    llm: provider,
    code,
    deploy,
    history,
    notify: (sessionId, message) => messages.push({ sessionId, message }),
    intervalMs: 60_000,
    thresholdChars: 400,
    // 実運用では一時的な失敗を待って再試行するが、テストで待つ意味はない。
    // 時間予算も既定は0(=粘らない)。粘りを確かめるテストだけ明示的に渡す
    llmRetryDelayMs: 0,
    budgetRetryDelayMs: 0,
    jobBudgetMs: 0,
    ...extra,
  });
}

async function openSession(): Promise<Session> {
  const session = store.create({ title: "テスト商談" });
  await docs.open(session);
  return session;
}

/** 文字起こしを追記する。実際の経路と同じ入口を通す */
async function speak(session: Session, ...texts: string[]): Promise<void> {
  for (const [index, text] of texts.entries()) {
    await docs.appendTranscript(session, {
      seq: nextSeq(session),
      text,
      speaker: index % 2 === 0 ? "A" : "B",
      startMs: index * 5_000,
      endMs: index * 5_000 + 4_000,
      at: new Date().toISOString(),
    });
  }
}

const seqBySession = new Map<string, number>();
function nextSeq(session: Session): number {
  const next = (seqBySession.get(session.id) ?? 0) + 1;
  seqBySession.set(session.id, next);
  return next;
}

const read = (session: Session, name: string): Promise<string | null> =>
  docs.store.read(session.id, name);

const updatedNames = (): string[] =>
  messages.filter((m) => m.message.type === "document.updated").map((m) => (m.message as { name: string }).name);

describe("Issue Agent の起動", () => {
  it("会話が無ければLLMを呼ばない", async () => {
    const session = await openSession();

    expect(await orchestrator.runIssueAgent(session)).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it("会話があれば issues.md と ideas.md を作る", async () => {
    const session = await openSession();
    await speak(session, "在庫はExcelで管理していて、担当者しか触れない状態です。");

    expect(await orchestrator.runIssueAgent(session)).toBe(true);

    const issues = await read(session, "issues.md");
    expect(issues).toContain("# Issues");
    expect(issues).toMatch(/## ISS-001 .+/);
    expect(await read(session, "ideas.md")).toMatch(/## IDEA-001 .+/);
  });

  it("更新を document.updated で知らせる", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    await orchestrator.runIssueAgent(session);

    expect(updatedNames()).toEqual(["issues.md", "ideas.md"]);
  });

  it("蓄積が閾値を超えたら間隔を待たずに回す", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    // 閾値に届かないうちは動かない
    await orchestrator.onTranscriptGrew(session);
    expect(llm.calls).toHaveLength(0);

    await speak(session, "実態とズレることが多くて。".repeat(40));
    await orchestrator.onTranscriptGrew(session);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("差分投入(DATAFLOW.md の差分処理の規約)", () => {
  it("2回目は未処理分だけを投入する", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    await speak(session, "実態とズレることが多くて。");
    await orchestrator.runIssueAgent(session);

    // 会話のセクションには新しい分しか入らない。
    // (1回目の発話は issues.md の「根拠」としてなら現れる。それは全文投入の対象)
    const conversation = sectionOf(llm.calls[1]?.input ?? "", "新しい会話");
    expect(conversation).toContain("実態とズレる");
    expect(conversation).not.toContain("担当者しか触れない状態です");
  });

  it("差分は入力の末尾に置く(プロンプトキャッシュのため)", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    const input = llm.calls[0]?.input ?? "";
    expect(input.lastIndexOf("新しい会話")).toBeGreaterThan(input.lastIndexOf("issues.md の現在値"));
  });

  it("既存の issues.md は全文を投入する", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    await speak(session, "実態とズレることが多くて。");
    await orchestrator.runIssueAgent(session);

    expect(llm.calls[1]?.input).toContain("データが属人化している");
  });

  it("失敗したら処理済み位置を進めない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const failing = build(new MockLLMProvider({ fail: true }));
    expect(await failing.runIssueAgent(session)).toBe(false);
    expect(docs.store.cursorOf(session.id, "transcript.md")).toBe(0);

    // 次回は同じ差分ごと再試行される
    expect(await orchestrator.runIssueAgent(session)).toBe(true);
    expect(llm.calls[0]?.input).toContain("担当者しか触れない");
  });
});

describe("冪等性", () => {
  it("同じ課題が二重に追加されない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    // 同じ話題を別の言い回しで繰り返す
    await speak(session, "本人しか分からないんですよね。");
    await orchestrator.runIssueAgent(session);

    const issues = (await read(session, "issues.md")) ?? "";
    expect(issues.match(/^## ISS-/gm)).toHaveLength(1);
    // 根拠だけが積み増される
    expect(issues.match(/^- 根拠:/gm)).toHaveLength(2);
  });

  it("別の課題は追加される", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    await speak(session, "実態とズレることが多くて。");
    await orchestrator.runIssueAgent(session);

    const issues = (await read(session, "issues.md")) ?? "";
    expect(issues.match(/^## ISS-/gm)).toHaveLength(2);
    expect(issues).toContain("ISS-002");
  });

  it("実行が重なっても同じ差分を二度処理しない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const [first, second] = await Promise.all([
      orchestrator.runIssueAgent(session),
      orchestrator.runIssueAgent(session),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("生成ジョブ", () => {
  it("要件定義と画面設計を作る", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    const job = orchestrator.startGeneration(session);
    expect(job.status).toBe("queued");

    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.status === "succeeded");

    const requirements = (await read(session, "requirements.md")) ?? "";
    expect(requirements).toContain("# Requirements");
    expect(requirements).toContain("## 対象外");
    expect(await read(session, "ui.md")).toContain("# UI");
  });

  it("同時に2つは走らせない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const job = orchestrator.startGeneration(session);
    expect(() => orchestrator.startGeneration(session)).toThrow(ConflictError);

    // 走らせたジョブの後始末を待つ。片付けと書き込みが競合しないように
    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.endedAt !== null);
  });

  it("終わっていれば次を始められる", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const first = orchestrator.startGeneration(session);
    await waitFor(() => orchestrator.jobOf(session.id, first.jobId)?.status === "succeeded");

    const second = orchestrator.startGeneration(session);
    expect(second.jobId).not.toBe(first.jobId);

    // 走らせたジョブの後始末を待つ。片付けと書き込みが競合しないように
    await waitFor(() => orchestrator.jobOf(session.id, second.jobId)?.endedAt !== null);
  });

  it("LLMが落ちていればジョブが失敗する", async () => {
    const session = await openSession();
    const failing = build(new MockLLMProvider({ fail: true }));

    const job = failing.startGeneration(session);
    await waitFor(() => failing.jobOf(session.id, job.jobId)?.status === "failed");

    expect(failing.jobOf(session.id, job.jobId)?.error).toContain("接続できません");
    // 要件定義は書かれない
    expect(await read(session, "requirements.md")).toBeNull();
  });

  it("進捗を job.progress で知らせる", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const job = orchestrator.startGeneration(session);
    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.status === "succeeded");

    const steps = messages
      .filter((m) => m.message.type === "job.progress")
      .map((m) => (m.message as { step: string; status: string }));

    // AGENTS.md の実行順序どおりに進む
    expect(steps.map((s) => s.step)).toEqual([
      "requirements",
      "ui",
      "code",
      "review",
      "deploy",
      "deploy",
    ]);
    expect(steps.at(-1)?.status).toBe("succeeded");
  });

  it("知らないジョブIDは引けない", async () => {
    const session = await openSession();
    expect(orchestrator.jobOf(session.id, "job_unknown")).toBeUndefined();
  });
});

describe("トリガーの承認", () => {
  it("検出しただけでは生成が始まらない(議事録だけが作られる)", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    llm.calls.length = 0;

    const job = orchestrator.proposeGeneration(session, "アプリ作って");

    expect(job?.status).toBe("awaiting_approval");
    await sleep(80);

    // 承認判断の材料になる議事録は作られる
    expect(await read(session, "summary.md")).toContain("## 会話の要点");
    // 生成ジョブ本体(要件定義以降)は動いていない
    expect(await read(session, "requirements.md")).toBeNull();
    // 動いてよいのは課題抽出と議事録だけ
    for (const call of llm.calls) {
      expect(call.system).toMatch(/# Agent: (issue|summary)/);
    }
  });

  it("商談の早い段階で検出されても、議事録に課題が載る", async () => {
    // 一度も Issue Agent が回っていない時点でトリガーが来ると、
    // 「抽出した課題: (なし)」の議事録を顧客へ見せることになる
    const session = await openSession();
    await speak(session, "Excelで管理していて、担当者しか触れない状態です。");
    expect(await read(session, "issues.md")).toBeNull();

    orchestrator.proposeGeneration(session, "アプリ作って");
    await sleep(120);

    expect(await read(session, "issues.md")).toContain("## ISS-001");
    expect(await read(session, "summary.md")).not.toContain("(なし)");
  });

  it("確認を出した直後の再検出は黙って捨てる(クールダウン)", async () => {
    // 30分の通しリハーサルで、会話が同じ話題へ戻るたびに59回の再検出が起きた。
    // そのたびに議事録の作り直し(LLM呼び出し)まで走っていた
    let now = 1_000_000;
    const session = await openSession();
    const cooling = build(new MockLLMProvider(), new TemplateCodeProvider(), {
      triggerCooldownMs: 180_000,
      now: () => now,
    });

    const first = cooling.proposeGeneration(session, "アプリ作って");
    expect(first?.status).toBe("awaiting_approval");
    await sleep(80);
    llm.calls.length = 0;

    // 誤検知としてキャンセルしたあと、同じ話題がまた出た
    cooling.resolveProposal(session, (first as { jobId: string }).jobId, false);
    now += 30_000;
    expect(cooling.proposeGeneration(session, "アプリ作って")).toBeNull();
    await sleep(80);
    // 議事録の作り直しも走っていない
    expect(llm.calls).toHaveLength(0);

    // 時間が経てばまた拾う。言い直して作り直せなくなってはいけない
    now += 180_000;
    expect(cooling.proposeGeneration(session, "アプリ作って")?.status).toBe("awaiting_approval");
    await sleep(80);
  });

  it("トリガー時の議事録更新を document.updated で知らせる", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    orchestrator.proposeGeneration(session, "アプリ作って");
    await sleep(80);

    expect(updatedNames()).toContain("summary.md");
  });

  it("議事録の生成が失敗しても確認は出たまま", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const failing = build(new MockLLMProvider({ fail: true }));
    const job = failing.proposeGeneration(session, "アプリ作って");
    await sleep(80);

    // 確認は生きていて、承認すればジョブへ進める(ジョブ自体は成功する構成で確かめる)
    expect(failing.jobOf(session.id, (job as { jobId: string }).jobId)?.status).toBe(
      "awaiting_approval",
    );
  });

  it("trigger.detected を送る", async () => {
    const session = await openSession();
    orchestrator.proposeGeneration(session, "アプリ作って");

    const detected = messages.find((m) => m.message.type === "trigger.detected")?.message as
      | { jobId: string; phrase: string }
      | undefined;
    expect(detected?.phrase).toBe("アプリ作って");

    // 裏で走る議事録の書き込みを待つ。後片付けと競合させない
    await sleep(80);
  });

  it("承認すると走り出す", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const job = orchestrator.proposeGeneration(session, "アプリ作って") as { jobId: string };
    orchestrator.resolveProposal(session, job.jobId, true);

    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.status === "succeeded");
    expect(await read(session, "requirements.md")).toContain("# Requirements");
  });

  it("キャンセルすると捨てられる", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const job = orchestrator.proposeGeneration(session, "アプリ作って") as { jobId: string };
    const resolved = orchestrator.resolveProposal(session, job.jobId, false);

    expect(resolved?.status).toBe("cancelled");
    await sleep(50);
    expect(await read(session, "requirements.md")).toBeNull();
  });

  it("キャンセル後は次のトリガーを受けられる", async () => {
    const session = await openSession();
    const first = orchestrator.proposeGeneration(session, "アプリ作って") as { jobId: string };
    orchestrator.resolveProposal(session, first.jobId, false);

    expect(orchestrator.proposeGeneration(session, "これ作って")).not.toBeNull();
    await sleep(80);
  });

  it("確認中に重ねて検出したら、ジョブを増やさず同じ確認を出し直す", async () => {
    // 確認UIはWSで一度しか流れず、タブの破棄やリロードで画面から消えることがある。
    // 言い直しが黙って捨てられると、営業担当に打つ手が無くなる
    const session = await openSession();
    const first = orchestrator.proposeGeneration(session, "アプリ作って") as { jobId: string };
    await sleep(80);
    llm.calls.length = 0;

    const again = orchestrator.proposeGeneration(session, "これ作って");

    // 同じジョブのまま
    expect(again?.jobId).toBe(first.jobId);
    expect(again?.status).toBe("awaiting_approval");
    // 確認は2回届いていて、どちらも同じジョブを指す
    const detected = messages.filter((m) => m.message.type === "trigger.detected");
    expect(detected).toHaveLength(2);
    expect((detected[1]?.message as { jobId: string }).jobId).toBe(first.jobId);
    // 議事録の作り直し(LLM呼び出し)は走らない
    await sleep(80);
    expect(llm.calls).toHaveLength(0);
  });

  it("古い確認への応答は効かない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const job = orchestrator.proposeGeneration(session, "アプリ作って") as { jobId: string };
    orchestrator.resolveProposal(session, job.jobId, true);

    // 走り出したあとにキャンセルが遅れて届いても止めない
    expect(orchestrator.resolveProposal(session, job.jobId, false)).toBeUndefined();
    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.status === "succeeded");
  });
});

describe("コード生成とレビュー", () => {
  /** 指定回数だけ差し戻される生成器 */
  class FlakyCode implements CodeProvider {
    calls: CodeRequest[] = [];
    constructor(private readonly badAttempts: number) {}

    async generate(req: CodeRequest): Promise<FileMap> {
      this.calls.push(req);
      // 外部参照は検証層が必ず BLOCK にする。
      // 回ごとに中身を変える。LLMは差し戻しを読んで書き直すので、
      // 同じものを返し続けるのは実装の性質(TemplateCodeProvider)であって差し戻しの性質ではない
      return this.calls.length <= this.badAttempts
        ? { "index.html": `<script>fetch('https://api.example.com/${this.calls.length}')</script>` }
        : new TemplateCodeProvider().generate(req);
    }
  }

  /** 差し戻しを読まず、毎回まったく同じものを返す生成器(TemplateCodeProvider と同じ性質) */
  class StubbornCode implements CodeProvider {
    calls: CodeRequest[] = [];

    async generate(req: CodeRequest): Promise<FileMap> {
      this.calls.push(req);
      return { "index.html": "<script>fetch('https://api.example.com')</script>" };
    }
  }

  it("BLOCKがあれば差し戻して作り直す", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const code = new FlakyCode(1);
    const flaky = build(llm, code);
    const job = flaky.startGeneration(session);
    await waitFor(() => flaky.jobOf(session.id, job.jobId)?.status === "succeeded");

    expect(code.calls).toHaveLength(2);
    // 2回目にはレビュー結果が渡る
    expect(code.calls[1]?.review).toContain("[BLOCK]");
    expect(flaky.jobOf(session.id, job.jobId)?.attempt).toBe(2);
  });

  it("3回とも駄目なら失敗させる", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const code = new FlakyCode(99);
    const flaky = build(llm, code);
    const job = flaky.startGeneration(session);
    await waitFor(() => flaky.jobOf(session.id, job.jobId)?.status === "failed");

    expect(code.calls).toHaveLength(3);
    expect(flaky.jobOf(session.id, job.jobId)?.error).toContain("要件定義と画面設計までを成果物");
    // 要件定義までは残る(AGENTS.md)
    expect(await read(session, "requirements.md")).toContain("# Requirements");
  });

  it("前回と同じものが返ってきたら、やり直さずに打ち切る", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const code = new StubbornCode();
    const flaky = build(llm, code);
    const job = flaky.startGeneration(session);
    await waitFor(() => flaky.jobOf(session.id, job.jobId)?.status === "failed");

    // 2回目で同じだと分かった時点で止める。3回目は呼ばない。
    // Review Agent(Opus 5)を余計に呼ばないことがここでの狙い
    expect(code.calls).toHaveLength(2);
    expect(flaky.jobOf(session.id, job.jobId)?.error).toContain("要件定義と画面設計までを成果物");
  });

  it("やり直し回数は設定で減らせる(商談中の時間予算)", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const code = new FlakyCode(99);
    const flaky = build(llm, code, { codeAttempts: 2 });
    const job = flaky.startGeneration(session);
    await waitFor(() => flaky.jobOf(session.id, job.jobId)?.status === "failed");

    expect(code.calls).toHaveLength(2);
  });

  it("設定が範囲外でも商談は止めない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const code = new FlakyCode(99);
    const flaky = build(llm, code, { codeAttempts: 0 });
    const job = flaky.startGeneration(session);
    await waitFor(() => flaky.jobOf(session.id, job.jobId)?.status === "failed");

    expect(code.calls).toHaveLength(1);
  });

  it("失敗しても文字起こしは残る", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const flaky = build(llm, new FlakyCode(99));
    const job = flaky.startGeneration(session);
    await waitFor(() => flaky.jobOf(session.id, job.jobId)?.status === "failed");

    expect(await read(session, "transcript.md")).toContain("担当者しか触れない");
  });

  it("成功したら artifact.ready を送る", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const job = orchestrator.startGeneration(session);
    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.status === "succeeded");

    const ready = messages.find((m) => m.message.type === "artifact.ready")?.message as
      | { url: string; buildId: string }
      | undefined;
    expect(ready?.url).toContain("/preview/");
    expect(ready?.buildId).toMatch(/^build_[0-9a-f]{32}$/);
  });

  it("コード生成の履歴も残す", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const job = orchestrator.startGeneration(session);
    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.status === "succeeded");

    const runs = await history.read(session.id);
    expect(runs.map((run) => run.agent)).toContain("code");
    expect(runs.map((run) => run.agent)).toContain("review");
  });
});

describe("セッション終了時", () => {
  it("summary.md と todo.md を作る", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    await orchestrator.runClosing(session);

    expect(await read(session, "summary.md")).toContain("## 会話の要点");
    expect(await read(session, "todo.md")).toContain("# Todo");
  });

  it("失敗しても transcript.md は残る", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const failing = build(new MockLLMProvider({ fail: true }));
    await failing.runClosing(session);

    expect(await read(session, "summary.md")).toBeNull();
    expect(await read(session, "transcript.md")).toContain("担当者しか触れない");
  });
});

describe("縮退動作", () => {
  it("LLMが落ちても文字起こしは続く", async () => {
    const session = await openSession();
    const failing = build(new MockLLMProvider({ fail: true }));

    await speak(session, "担当者しか触れない状態です。");
    await failing.runIssueAgent(session);
    // 失敗したあとも追記できる
    await speak(session, "毎朝1回の更新です。");

    expect(await read(session, "transcript.md")).toContain("毎朝1回の更新です");
  });

  it("失敗を error として知らせる(接続は維持する)", async () => {
    const session = await openSession();
    const failing = build(new MockLLMProvider({ fail: true }));

    await speak(session, "担当者しか触れない状態です。");
    await failing.runIssueAgent(session);

    const error = messages.find((m) => m.message.type === "error")?.message as
      | { code: string; recoverable: boolean }
      | undefined;
    expect(error?.code).toBe("llm_unavailable");
    expect(error?.recoverable).toBe(true);
  });
});

describe("ファイル所有者", () => {
  it("各Agentは自分の所有ファイルにしか書かない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    const job = orchestrator.startGeneration(session);
    await waitFor(() => orchestrator.jobOf(session.id, job.jobId)?.status === "succeeded");
    await orchestrator.runClosing(session);

    // 所有者以外の書き込みは MarkdownStore が拒む。
    // 全工程が通ったこと自体が、所有者どおりに書けている証拠になる
    const names = (await docs.store.list(session.id)).map((d) => d.name);
    expect(names).toEqual([
      "ai_instruction.md",
      "ideas.md",
      "issues.md",
      "meeting.md",
      "requirements.md",
      "review.md",
      "summary.md",
      "todo.md",
      "transcript.md",
      "ui.md",
    ]);
  });
});

describe("実行履歴", () => {
  it("入力・出力・所要時間・モデルを残す", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    const runs = await history.read(session.id);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.agent).toBe("issue");
    expect(runs[0]?.status).toBe("succeeded");
    // Agentが指定したモデル名がそのまま残る(AGENTS.md の推奨モデル)
    expect(runs[0]?.model).toBe("claude-sonnet-5");
    expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(runs[0]?.input).toContain("担当者しか触れない");
    expect(runs[0]?.output).toContain("# Issues");
    expect(runs[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("失敗した実行も残す", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const failing = build(new MockLLMProvider({ fail: true }));
    await failing.runIssueAgent(session);

    const runs = await history.read(session.id);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toContain("接続できません");
  });

  it("Agentごとに1件ずつ積む", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);
    await orchestrator.runClosing(session);

    const runs = await history.read(session.id);
    expect(runs.map((run) => run.agent)).toEqual(["issue", "summary", "todo"]);
  });

  it("履歴はMarkdownの一覧に出さない", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");
    await orchestrator.runIssueAgent(session);

    const names = (await docs.store.list(session.id)).map((d) => d.name);
    expect(names).not.toContain("agent_runs.jsonl");
  });
});

describe("使用量の記録", () => {
  it("プロバイダが返した使用量をそのまま残す", async () => {
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    const withUsage = build({
      complete: async (): Promise<LLMResponse> => ({
        text: "# Issues\n\n# Ideas\n",
        model: "claude-sonnet-5",
        usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000, cacheWriteTokens: 0 },
      }),
    });
    await withUsage.runIssueAgent(session);

    const runs = await history.read(session.id);
    expect(runs[0]?.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    });
  });
});

describe("定期実行", () => {
  it("start は1セッションに1つだけタイマーを張る", async () => {
    const fast = new Orchestrator({
      docs,
      llm,
      code: new TemplateCodeProvider(),
      deploy,
      history,
      notify: (sessionId, message) => messages.push({ sessionId, message }),
      intervalMs: 20,
      thresholdChars: 100_000,
    });
    const session = await openSession();
    await speak(session, "担当者しか触れない状態です。");

    fast.start(session);
    fast.start(session);
    await sleep(70);
    fast.stop(session.id);

    // 差分は1回で使い切られるため、何度回っても呼び出しは1回
    expect(llm.calls).toHaveLength(1);
  });

  it("stop 後は回らない", async () => {
    const fast = new Orchestrator({
      docs,
      llm,
      code: new TemplateCodeProvider(),
      deploy,
      history,
      notify: () => undefined,
      intervalMs: 20,
      thresholdChars: 100_000,
    });
    const session = await openSession();

    fast.start(session);
    fast.stop(session.id);
    await speak(session, "担当者しか触れない状態です。");
    await sleep(70);

    expect(llm.calls).toHaveLength(0);
  });
});

describe("失敗の分類と自動再試行", () => {
  /** 最初の1回だけ一時的なエラーで落ち、以後は素直に応える */
  class FailOnceLLM implements LLMProvider {
    #failed = false;
    constructor(private readonly inner: LLMProvider) {}

    async complete(req: LLMRequest): Promise<LLMResponse> {
      if (!this.#failed) {
        this.#failed = true;
        const { LLMError } = await import("../llm/types.js");
        throw new LLMError("LLMに接続できません: This operation was aborted", true);
      }
      return this.inner.complete(req);
    }
  }

  /** 指定回数だけ一時的なエラーで落ち続ける。数分単位の混雑を模す */
  class FailNTimesLLM implements LLMProvider {
    #remaining: number;
    constructor(
      failures: number,
      private readonly inner: LLMProvider,
    ) {
      this.#remaining = failures;
    }

    async complete(req: LLMRequest): Promise<LLMResponse> {
      if (this.#remaining > 0) {
        this.#remaining -= 1;
        const { LLMError } = await import("../llm/types.js");
        throw new LLMError("LLMがエラーを返しました (529): overloaded", true);
      }
      return this.inner.complete(req);
    }
  }

  it("時間予算が残っている限り、連続する混雑でも生成をやり遂げる", async () => {
    // #call の1回きりの再試行(2回分)を使い切っても、まだ失敗が続く状況
    const congested = build(new FailNTimesLLM(5, new MockLLMProvider()), new TemplateCodeProvider(), {
      jobBudgetMs: 60_000,
    });
    const session = await openSession();
    await speak(session, "在庫管理をExcelでやっていて、担当者しか分からないのが困りごとです。");

    const job = congested.startGeneration(session);
    await waitFor(() => congested.jobOf(session.id, job.jobId)?.status === "succeeded");
    expect(await read(session, "requirements.md")).not.toBeNull();
  });

  it("時間予算が尽きていれば、一時的な失敗でも粘らずに失敗させる", async () => {
    const exhausted = build(new MockLLMProvider({ fail: true }), new TemplateCodeProvider(), {
      jobBudgetMs: 0,
    });
    const session = await openSession();
    await speak(session, "困りごとの共有です。");

    const job = exhausted.startGeneration(session);
    await waitFor(() => exhausted.jobOf(session.id, job.jobId)?.status === "failed");
    expect(exhausted.jobOf(session.id, job.jobId)?.failure?.retryable).toBe(true);
  });

  it("一時的な失敗は1回だけ黙って再試行し、成功させる", async () => {
    const flaky = build(new FailOnceLLM(new MockLLMProvider()));
    const session = await openSession();
    await speak(session, "在庫管理をExcelでやっていて、担当者しか分からないのが困りごとです。");

    // 実機では code 工程がタイムアウト1発で落ち、営業担当が言い直す羽目になった
    const updated = await flaky.runIssueAgent(session);
    expect(updated).toBe(true);
    expect(await read(session, "issues.md")).toContain("ISS");
  });

  it("失敗したジョブには、画面に出せる理由と対処が付く", async () => {
    const failing = build(new MockLLMProvider({ fail: true }));
    const session = await openSession();
    await speak(session, "困りごとの共有です。");

    const job = failing.startGeneration(session);
    await waitFor(() => failing.jobOf(session.id, job.jobId)?.status === "failed");

    const view = failing.jobOf(session.id, job.jobId);
    expect(view?.failure).not.toBeNull();
    // モックの失敗は retryable=true → 「混み合っている」扱い
    expect(view?.failure?.retryable).toBe(true);
    expect(view?.failure?.message).toContain("混み合って");
    expect(view?.failure?.detail).toContain("LLMに接続できません");

    // 通知にも同じものが載る。画面はこれを見て案内を出す
    const progress = messages.find(
      (m) => m.message.type === "job.progress" && m.message.status === "failed",
    )?.message as { failure?: { retryable: boolean } } | undefined;
    expect(progress?.failure?.retryable).toBe(true);
  });

  it("完成後は、クールダウン中でも次の合図で確認を出せる", async () => {
    const working = build(new MockLLMProvider(), new TemplateCodeProvider(), {
      triggerCooldownMs: 180_000,
    });
    const session = await openSession();
    await speak(session, "在庫管理の困りごとです。");

    const first = working.proposeGeneration(session, "アプリ作って");
    expect(first).not.toBeNull();
    working.resolveProposal(session, first?.jobId as string, true);
    await waitFor(() => working.jobOf(session.id, first?.jobId as string)?.status === "succeeded");

    // 完成直後の「アプリ作って」は、もう一つ作りたいという意図的な依頼。
    // 実機ではこれが3分の抑止に吸われて不発になった
    const second = working.proposeGeneration(session, "アプリ作って");
    expect(second).not.toBeNull();
    working.resolveProposal(session, second?.jobId as string, false);
    await sleep(150);
  });

  it("失敗後は、クールダウン中でも言い直しで確認を出せる", async () => {
    const failing = build(new MockLLMProvider({ fail: true }), new TemplateCodeProvider(), {
      triggerCooldownMs: 180_000,
    });
    const session = await openSession();
    await speak(session, "困りごとの共有です。");

    const proposed = failing.proposeGeneration(session, "アプリ作って");
    expect(proposed).not.toBeNull();
    failing.resolveProposal(session, proposed?.jobId as string, true);
    await waitFor(() => failing.jobOf(session.id, proposed?.jobId as string)?.status === "failed");

    // 画面は「言い直せばもう一度作れます」と案内する。
    // その言い直しがクールダウンで黙って無視されては筋が通らない
    const second = failing.proposeGeneration(session, "アプリ作って");
    expect(second).not.toBeNull();

    // 裏で走る議事録の作り直しを待ってから片付ける。
    // 待たないと afterEach の削除と書き込みが競合して落ちることがある
    failing.resolveProposal(session, second?.jobId as string, false);
    await sleep(150);
  });
});

/** 入力から `# 見出し` の区画を取り出す。テスト側でも投入内容を切り分けるために使う */
function sectionOf(input: string, name: string): string {
  const lines = input.split("\n");
  const start = lines.findIndex((line) => line.startsWith("# ") && line.includes(name));
  if (start === -1) return "";

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("# "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("条件が満たされませんでした");
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
