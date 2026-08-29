import { createHash, randomUUID } from "node:crypto";
import {
  MAX_CODE_ATTEMPTS,
  type JobFailure,
  type JobStep,
  type JobView,
  type ServerMessage,
} from "@rt-mvp/protocol";
import { hasBlock, renderFindings, validate, type CodeProvider, type FileMap } from "../codegen/index.js";
import type { DeployProvider } from "../deploy/localStaticDeployProvider.js";
import { log } from "../log.js";
import type { LLMProvider } from "../llm/types.js";
import { LLMError } from "../llm/types.js";
import { DOCUMENTS, type DocumentName } from "../markdown/documents.js";
import { mergeItems, parseItems, renderItems } from "../markdown/items.js";
import type { SessionDocuments } from "../markdown/sessionDocuments.js";
import type { Session } from "../sessions/store.js";
import { AgentHistory } from "./history.js";
import type { AgentKind } from "./kinds.js";
import { AGENT_MODEL, buildInput, buildSystem } from "./prompts.js";

/**
 * AI Orchestrator。
 *
 * AGENTS.md:「Orchestratorは実行順序と条件のみを知っている。
 * 各Agentは自分の前後に何が動くかを知らない。」
 *
 * 責務は4つだけ。
 * 1. いつ動かすかを決める(60秒ごと / 蓄積量 / 生成要求 / セッション終了)
 * 2. 差分を切り出す(DATAFLOW.md の処理済みバイト位置)
 * 3. 結果をマージして所有ファイルへ書く
 * 4. 実行履歴を残す
 *
 * **LLMが落ちても文字起こしは止まらない。** ここで起きた失敗は
 * Markdownの更新が止まるだけで、音声の受信と `transcript.md` への追記には触れない。
 */

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** コード生成が上限回数までレビューを通らなかった。内容起因の失敗として扱う */
export class CodeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeRejectedError";
  }
}

/**
 * 失敗を営業担当が判断できる言葉に訳す。
 *
 * 実機の商談テストで code 工程がタイムアウトで落ちたとき、画面には
 * 「生成できませんでした」しか出ず、言い直せば直るのか、諦めるべきなのか
 * 判断できなかった。失敗の種類ごとに取るべき行動が違う。
 */
export function classifyFailure(error: unknown): JobFailure {
  const detail = error instanceof Error ? error.message : String(error);

  if (error instanceof LLMError) {
    if (error.retryable) {
      return {
        message: "AIサービスが混み合っているか、応答が時間内に届きませんでした。",
        retryable: true,
        detail,
      };
    }
    if (detail.includes("拒否")) {
      return {
        message: "AIがこの内容の生成を断りました。言い直しても同じ結果になります。",
        retryable: false,
        detail,
      };
    }
    return {
      message: "AIサービスの設定に問題があり、生成できません。管理者に連絡してください。",
      retryable: false,
      detail,
    };
  }

  if (error instanceof CodeRejectedError) {
    return {
      message:
        "AIが何度か作り直しましたが、安全確認を通る形にできませんでした。要件や話題を少し変えると通ることがあります。",
      retryable: true,
      detail,
    };
  }

  return {
    message: "サーバー内部の問題で生成が止まりました。",
    retryable: true,
    detail,
  };
}

interface Job extends JobView {
  sessionId: string;
  /** トリガー検出で作られた場合の、引っかかった言い回し */
  phrase: string | null;
}

export interface OrchestratorOptions {
  docs: SessionDocuments;
  llm: LLMProvider;
  code: CodeProvider;
  deploy: DeployProvider;
  history: AgentHistory;
  /** 更新をPWAへ知らせる。接続が無ければ捨てられてよい */
  notify: (sessionId: string, message: ServerMessage) => void;
  /** Issue Agent の実行間隔 */
  intervalMs: number;
  /** 未処理がこの文字数を超えたら間隔を待たずに回す */
  thresholdChars: number;
  /** トリガー検出のクールダウン。0 で無効 */
  triggerCooldownMs?: number;
  /** コード生成をやり直す上限。既定は MAX_CODE_ATTEMPTS。1未満・上限超は丸める */
  codeAttempts?: number;
  /** 一時的なLLM失敗を再試行するまでの待ち。テストでは0にする */
  llmRetryDelayMs?: number;
  /**
   * 生成ジョブの時間予算。承認からこの時間までは、混雑もレビュー差し戻しも
   * 打ち切らずに粘る(2026-08-07 の運用決定: 10分で見切らず最大30分)。
   */
  jobBudgetMs?: number;
  /** 予算内でステップをやり直すまでの待ち。テストでは0にする */
  budgetRetryDelayMs?: number;
  now?: () => number;
}

export class Orchestrator {
  readonly #docs: SessionDocuments;
  readonly #llm: LLMProvider;
  readonly #code: CodeProvider;
  readonly #deploy: DeployProvider;
  readonly #history: AgentHistory;
  readonly #notify: OrchestratorOptions["notify"];
  readonly #intervalMs: number;
  readonly #thresholdChars: number;
  readonly #triggerCooldownMs: number;
  readonly #codeAttempts: number;
  readonly #llmRetryDelayMs: number;
  readonly #jobBudgetMs: number;
  readonly #budgetRetryDelayMs: number;
  readonly #now: () => number;

  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  /** 実行中のセッション。重なって走ると同じ差分を二度処理する */
  readonly #busy = new Set<string>();
  readonly #jobs = new Map<string, Job>();
  /** 直近でトリガーを提案した時刻。クールダウンの起点 */
  readonly #proposedAt = new Map<string, number>();

  constructor(options: OrchestratorOptions) {
    this.#docs = options.docs;
    this.#llm = options.llm;
    this.#code = options.code;
    this.#deploy = options.deploy;
    this.#history = options.history;
    this.#notify = options.notify;
    this.#intervalMs = options.intervalMs;
    this.#thresholdChars = options.thresholdChars;
    this.#triggerCooldownMs = options.triggerCooldownMs ?? 0;
    // 設定ミスで 0 や 99 が入っても商談は止めない。丸めて動かす
    this.#codeAttempts = Math.min(
      MAX_CODE_ATTEMPTS,
      Math.max(1, Math.floor(options.codeAttempts ?? MAX_CODE_ATTEMPTS)),
    );
    this.#llmRetryDelayMs = options.llmRetryDelayMs ?? 2_000;
    this.#jobBudgetMs = options.jobBudgetMs ?? 30 * 60_000;
    this.#budgetRetryDelayMs = options.budgetRetryDelayMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  /** 定期実行を始める。セッションにつき1つ */
  start(session: Session): void {
    if (this.#timers.has(session.id)) return;

    const timer = setInterval(() => {
      void this.runIssueAgent(session).catch(() => undefined);
    }, this.#intervalMs);
    timer.unref();
    this.#timers.set(session.id, timer);

    log.info("orchestrator.started", { sessionId: session.id, intervalMs: this.#intervalMs });
  }

  stop(sessionId: string): void {
    const timer = this.#timers.get(sessionId);
    if (timer) clearInterval(timer);
    this.#timers.delete(sessionId);
    this.#busy.delete(sessionId);
    this.#proposedAt.delete(sessionId);
  }

  /**
   * 文字起こしが溜まったら、間隔を待たずに回す。
   * 商談の立ち上がりで最初の課題が出るまでの時間を縮める。
   */
  async onTranscriptGrew(session: Session): Promise<void> {
    if (this.#busy.has(session.id)) return;
    const { text } = await this.#docs.store.readUnprocessed(session.id, "transcript.md");
    if (utteranceText(text).length < this.#thresholdChars) return;
    await this.runIssueAgent(session);
  }

  /**
   * Issue Agent。未処理の会話から課題とアイデアを積む。
   *
   * 戻り値は更新したかどうか。差分が無ければ何もしない(LLMを呼ばない)。
   */
  async runIssueAgent(session: Session): Promise<boolean> {
    if (this.#busy.has(session.id)) return false;
    this.#busy.add(session.id);

    try {
      const { text: diff, cursor } = await this.#docs.store.readUnprocessed(
        session.id,
        "transcript.md",
      );
      if (utteranceText(diff).trim() === "") return false;

      const [issues, ideas, context] = await Promise.all([
        this.#read(session.id, "issues.md"),
        this.#read(session.id, "ideas.md"),
        this.#read(session.id, "context.md"),
      ]);

      const output = await this.#call(session.id, "issue", buildSystem("issue", context), [
        { title: "issues.md の現在値", body: issues },
        { title: "ideas.md の現在値", body: ideas },
        // 変動する差分は末尾。プロンプトキャッシュを効かせる(DATAFLOW.md)
        { title: "新しい会話(未処理分)", body: diff },
      ]);

      const mergedIssues = mergeItems(
        parseItems(issues),
        parseItems(sectionOf(output, "Issues")),
        "ISS",
      );
      const mergedIdeas = mergeItems(
        parseItems(ideas),
        parseItems(sectionOf(output, "Ideas")),
        "IDEA",
      );

      await this.#write(session.id, "issues.md", renderItems("# Issues", mergedIssues), "issue_agent");
      await this.#write(session.id, "ideas.md", renderItems("# Ideas", mergedIdeas), "issue_agent");

      // マージし終えてから進める。途中で落ちたら同じ差分を次回に再試行する
      this.#docs.store.advanceCursor(session.id, "transcript.md", cursor);

      log.info("orchestrator.issues", {
        sessionId: session.id,
        issues: mergedIssues.length,
        ideas: mergedIdeas.length,
        cursor,
      });
      return true;
    } catch (error) {
      this.#reportFailure(session.id, "issue", error);
      return false;
    } finally {
      this.#busy.delete(session.id);
    }
  }

  /**
   * トリガーを検出した。**ジョブは作るが、何も始めない。**
   *
   * RETROSPECTIVE.md「誤トリガーは明示承認で防ぐ」。
   * 承認されるまで `awaiting_approval` のまま待ち、LLMもコード生成も呼ばない。
   * 既に動いているジョブがあれば null を返す(確認UIを重ねて出さない)。
   */
  proposeGeneration(session: Session, phrase: string): JobView | null {
    const existing = this.#jobs.get(session.id);

    // 承認待ちの間に言い直されたら、**同じ確認を出し直す。**
    //
    // 確認UIはWebSocketで一度しか流れないため、タブの破棄やリロードで
    // 画面から消えることがある。営業担当の自然な復旧手段は「もう一度言う」で、
    // それが黙って捨てられると打つ手が無くなる(本番のタブレットで実際に起きた)。
    // 新しいジョブは作らず、議事録の作り直し(LLM呼び出し)も走らせない。
    if (existing?.status === "awaiting_approval") {
      log.info("job.proposal_resent", { sessionId: session.id, jobId: existing.jobId, phrase });
      this.#notify(session.id, {
        type: "trigger.detected",
        jobId: existing.jobId,
        phrase: existing.phrase ?? phrase,
      });
      return viewOfJob(existing);
    }

    if (this.#isBusyJob(existing)) return null;

    // 直前に確認を出したばかりなら黙る。
    //
    // trigger.ts は「拾いすぎるくらいで構わない」方針だが、それは
    // **最初の1回を取りこぼさない**ための割り切りで、同じ商談で確認UIを
    // 数十秒おきに出し続ける口実ではない。30分の通しリハーサルでは、
    // 会話が同じ話題へ戻るたびに59回の再検出が起き、そのたびに
    // 議事録の作り直し(LLM呼び出し)まで走っていた。
    const last = this.#proposedAt.get(session.id);
    if (last !== undefined && this.#now() - last < this.#triggerCooldownMs) {
      log.info("job.proposal_suppressed", { sessionId: session.id, phrase });
      return null;
    }
    this.#proposedAt.set(session.id, this.#now());

    const job = this.#newJob(session.id, phrase);
    job.status = "awaiting_approval";
    this.#jobs.set(session.id, job);

    log.info("job.proposed", { sessionId: session.id, jobId: job.jobId, phrase });
    this.#notify(session.id, { type: "trigger.detected", jobId: job.jobId, phrase });

    // 承認判断の材料として、この時点までの議事録(summary.md)を作る。
    // 検出フレーズだけでは「何が作られるのか」を判断できない。
    //
    // 先に課題抽出を回す。**商談の早い段階でトリガーが来ると、まだ一度も
    // Issue Agent が動いておらず、議事録の「抽出した課題」が空になる。**
    // 会話には困りごとが出ているのに「(なし)」と出ると、営業担当が顧客へ
    // 見せる場面で「何も理解できていない」ように映る。
    //
    // 承認された場合、この呼び出しは無駄にならない —
    // 生成ジョブも冒頭で同じことをするが、そのときは差分が無く空振りする。
    //
    // **生成ジョブ本体はここでは動かさない。** 承認までは要件定義もコード生成も始まらない。
    void this.runIssueAgent(session)
      .catch(() => undefined)
      .then(() => this.runSummary(session))
      .catch(() => undefined);

    return viewOfJob(job);
  }

  /**
   * 確認への応答。承認されたら走らせ、されなければ捨てる。
   *
   * 応答できるのは `awaiting_approval` のジョブだけ。
   * 古い確認UIから遅れて届いた応答で、走っているジョブを止めさせない。
   */
  resolveProposal(session: Session, jobId: string, approved: boolean): JobView | undefined {
    const job = this.#jobs.get(session.id);
    if (!job || job.jobId !== jobId || job.status !== "awaiting_approval") return undefined;

    if (!approved) {
      job.status = "cancelled";
      job.endedAt = new Date().toISOString();
      // クールダウン(#proposedAt)はあえて解かない。誤検知をキャンセルした直後に
      // 会話が同じ話題へ戻ると、確認UIがまた出て商談を邪魔するため。
      // すぐ作り直したい場合はPWAの「試作品を作る」ボタン(POST /generate)を使う。
      log.info("job.cancelled", { sessionId: session.id, jobId });
      return viewOfJob(job);
    }

    job.status = "queued";
    log.info("job.approved", { sessionId: session.id, jobId });
    void this.#runGeneration(session, job);
    return viewOfJob(job);
  }

  /**
   * 生成ジョブを直接始める(`POST /generate`)。
   * DATAFLOW.md:「同一セッションに対する生成ジョブは同時に1つまで」
   */
  startGeneration(session: Session): JobView {
    const existing = this.#jobs.get(session.id);
    if (this.#isBusyJob(existing)) {
      // 承認待ちは「動いている」に含めるが、`POST /generate` は明示承認そのもの。
      // 確認UIが消えたまま残ったジョブ(再読み込み・再接続)に道を塞がせない。
      // 承認待ちのジョブは捨てて、新しいジョブで走り出す。
      if (existing && existing.status === "awaiting_approval") {
        existing.status = "cancelled";
        existing.endedAt = new Date().toISOString();
        log.info("job.superseded", { sessionId: session.id, jobId: existing.jobId });
      } else {
        throw new ConflictError("このセッションでは既に生成ジョブが動いています");
      }
    }

    const job = this.#newJob(session.id, null);
    this.#jobs.set(session.id, job);

    void this.#runGeneration(session, job);
    return viewOfJob(job);
  }

  jobOf(sessionId: string, jobId: string): JobView | undefined {
    const job = this.#jobs.get(sessionId);
    return job && job.jobId === jobId ? viewOfJob(job) : undefined;
  }

  /** セッションの最新ジョブ。確認UIの復元と一覧表示に使う */
  latestJob(sessionId: string): JobView | undefined {
    const job = this.#jobs.get(sessionId);
    return job ? viewOfJob(job) : undefined;
  }

  #newJob(sessionId: string, phrase: string | null): Job {
    return {
      sessionId,
      phrase,
      jobId: `job_${randomUUID().replace(/-/g, "")}`,
      status: "queued",
      step: "requirements",
      error: null,
      failure: null,
      buildId: null,
      url: null,
      attempt: 0,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
  }

  /** 承認待ちも「動いている」に含める。確認UIを重ねて出さないため */
  #isBusyJob(job: Job | undefined): boolean {
    if (!job) return false;
    return job.status === "awaiting_approval" || job.status === "queued" || job.status === "running";
  }

  /**
   * セッション終了時。`summary.md` と `todo.md` を作る。
   *
   * AGENTS.md:「サマリ生成のみ失敗として扱う。`transcript.md` は残っているため
   * 商談価値は毀損しない」
   */
  async runClosing(session: Session): Promise<void> {
    this.stop(session.id);
    await this.#runTranscriptAgent(session, ["summary", "todo"]);
  }

  /**
   * この時点までの議事録(summary.md)を作り直す。
   *
   * トリガー検出時に呼ばれ、承認判断の材料になる(AGENTS.md の
   * 「商談中の任意タイミング」に相当)。todo.md は作らない。
   * 未確定の約束を商談中に顧客へ見せないため(AGENTS.md)。
   */
  async runSummary(session: Session): Promise<void> {
    await this.#runTranscriptAgent(session, ["summary"]);
  }

  async #runTranscriptAgent(session: Session, kinds: ("summary" | "todo")[]): Promise<void> {
    const [transcript, issues, ideas, context] = await Promise.all([
      this.#read(session.id, "transcript.md"),
      this.#read(session.id, "issues.md"),
      this.#read(session.id, "ideas.md"),
      this.#read(session.id, "context.md"),
    ]);

    const sections = [
      { title: "issues.md", body: issues },
      { title: "ideas.md", body: ideas },
      { title: "transcript.md", body: transcript },
    ];

    const targets = [
      ["summary", "summary.md"],
      ["todo", "todo.md"],
    ] as const;

    for (const [kind, name] of targets) {
      if (!kinds.includes(kind)) continue;
      try {
        const output = await this.#call(session.id, kind, buildSystem(kind, context), sections);
        await this.#write(session.id, name, output, "transcript_agent");
      } catch (error) {
        // 片方が失敗しても、もう片方は作る
        this.#reportFailure(session.id, kind, error);
      }
    }
  }

  // ── 内部 ────────────────────────────────────────

  async #runGeneration(session: Session, job: Job): Promise<void> {
    const context = await this.#read(session.id, "context.md");
    const setStep = (step: JobStep): void => {
      job.step = step;
      job.status = "running";
      this.#notify(session.id, { type: "job.progress", jobId: job.jobId, step, status: "running" });
    };

    // 時間予算(2026-08-07 の運用決定)。
    // 「承認から10分」で見切らず、画面に進捗を出したまま最大30分(既定)まで粘る。
    // 一時的なLLMの失敗も、レビューの差し戻しも、予算が残っている限り打ち切らない
    const startedAt = this.#now();
    const withinBudget = (): boolean => this.#now() - startedAt < this.#jobBudgetMs;

    try {
      // 直前までの会話を課題へ反映してから要件をまとめる。
      // トリガーは会話の途中で飛ぶため、ここで追いつかせないと
      // 「今話していたこと」が要件定義に入らない
      await this.runIssueAgent(session);

      setStep("requirements");
      const issues = await this.#read(session.id, "issues.md");
      const ideas = await this.#read(session.id, "ideas.md");
      const transcript = await this.#read(session.id, "transcript.md");

      // 前回の requirements.md には、営業担当が手で直した用語が入っていることがある
      // (文字起こしの誤認識「あいこ」→「アイコン」など)。作り直しで捨てないよう、
      // 現在値も渡して「手動修正を正とする」ことをAgentへ伝える。
      const previousRequirements = await this.#read(session.id, "requirements.md");
      const requirementSections = [
        { title: "issues.md", body: issues },
        { title: "ideas.md", body: ideas },
        { title: "transcript.md", body: transcript },
      ];
      if (previousRequirements.trim() !== "") {
        requirementSections.push({
          title: "requirements.md の現在値(手動修正された固有名詞・用語はこちらを正とする)",
          body: previousRequirements,
        });
      }

      const requirements = await this.#persistently(session.id, withinBudget, () =>
        this.#call(session.id, "requirement", buildSystem("requirement", context), requirementSections),
      );
      await this.#write(session.id, "requirements.md", requirements, "requirement_agent");

      setStep("ui");
      let ui = "";
      try {
        ui = await this.#call(session.id, "ui", buildSystem("ui", context), [
          { title: "requirements.md", body: requirements },
          { title: "issues.md", body: issues },
        ]);
        await this.#write(session.id, "ui.md", ui, "ui_agent");
      } catch (error) {
        // AGENTS.md:「`ui.md` なしで Claude Code Agent を実行する(必須入力ではない)」
        // ジョブ全体は失敗にしない。要件定義までは成果物として残っている
        this.#reportFailure(session.id, "ui", error);
        ui = "";
      }

      const instruction = await this.#ensureInstruction(session.id);
      const files = await this.#buildCode(session, job, {
        requirements,
        ui,
        instruction,
        setStep,
        withinBudget,
      });

      setStep("deploy");
      const result = await this.#deploy.deploy({
        sessionId: session.id,
        buildId: job.buildId as string,
        files,
        expiresAt: new Date(session.expiresAt),
      });
      job.url = result.url;

      job.status = "succeeded";
      job.endedAt = new Date().toISOString();
      // 完成したらクールダウンを解除する。完成後の新しい合図は
      // 「もう一つ作りたい」という意図的な依頼であって、同じ話題の
      // 再検出ではない。実機では完成直後の「アプリ作って」が
      // 3分の抑止に吸われて不発になった
      this.#proposedAt.delete(session.id);
      this.#notify(session.id, {
        type: "job.progress",
        jobId: job.jobId,
        step: "deploy",
        status: "succeeded",
      });
      this.#notify(session.id, {
        type: "artifact.ready",
        kind: "mvp",
        buildId: job.buildId as string,
        url: result.url,
        previewToken: session.previewToken,
        expiresAt: result.expiresAt,
      });
      log.info("job.succeeded", {
        sessionId: session.id,
        jobId: job.jobId,
        buildId: job.buildId,
        attempts: job.attempt,
      });
    } catch (error) {
      // AGENTS.md:「生成ジョブ全体を失敗とする。`issues.md` までを成果物として提示する」
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.failure = classifyFailure(error);
      job.endedAt = new Date().toISOString();
      // 失敗したらクールダウンは解除する。「言い直せばもう一度作れます」と
      // 案内しておきながら、言い直しが3分間黙って無視されるのは筋が通らない
      this.#proposedAt.delete(session.id);
      this.#reportFailure(session.id, stepToAgent(job.step), error);
      this.#notify(session.id, {
        type: "job.progress",
        jobId: job.jobId,
        step: job.step,
        status: "failed",
        failure: job.failure,
      });
      log.error("job.failed", {
        sessionId: session.id,
        jobId: job.jobId,
        step: job.step,
        attempts: job.attempt,
        message: job.error,
      });
    }
  }

  /**
   * Claude Code Agent ⇄ Review Agent。**BLOCKが消えるまで回す。**
   *
   * 回数の下限は codeAttempts(AGENTS.md: 3回)。それを使い切っても
   * 時間予算が残っていれば回し続ける(2026-08-07 の運用決定:
   * 10分で見切らず最大30分)。予算内でも無限には回さない(上限10回)。
   *
   * 検証(validate.ts)は毎回必ず走らせる。レビューはその上に積む指摘であって、
   * 事故を止める役ではない。
   */
  async #buildCode(
    session: Session,
    job: Job,
    input: {
      requirements: string;
      ui: string;
      instruction: string;
      setStep: (step: JobStep) => void;
      withinBudget: () => boolean;
    },
  ): Promise<FileMap> {
    let review: string | null = null;
    let previous: string | null = null;
    const HARD_CAP = 10;

    for (let attempt = 1; attempt <= HARD_CAP; attempt += 1) {
      if (attempt > this.#codeAttempts && !input.withinBudget()) break;
      job.attempt = attempt;
      input.setStep("code");

      const started = Date.now();
      const files = await this.#persistently(session.id, input.withinBudget, () =>
        this.#code.generate({
          sessionId: session.id,
          requirements: input.requirements,
          ui: input.ui,
          instruction: input.instruction,
          review,
        }),
      );

      // 前回と同じものが返ってきたら、そこで打ち切る。
      // TemplateCodeProvider は `review` を読まないので、やり直しても**必ず同じ出力**になる。
      // 気づかずに回すと、Review Agent(Opus 5)を2回余計に呼んで
      // 商談中の40秒と$0.15を捨てたうえで、同じ結論に辿り着く
      const fingerprint = fingerprintOf(files);
      if (fingerprint === previous) {
        log.warn("code.unchanged", { sessionId: session.id, jobId: job.jobId, attempt });
        break;
      }
      previous = fingerprint;

      await this.#history.record(session.id, {
        agent: "code",
        model: "code-provider",
        status: "succeeded",
        durationMs: Date.now() - started,
        input: `attempt=${attempt}`,
        output: Object.keys(files).join("\n"),
        usage: null,
        error: null,
      });

      input.setStep("review");
      const findings = validate(files);
      review = await this.#persistently(session.id, input.withinBudget, () =>
        this.#review(session.id, files, input.requirements, findings),
      );
      await this.#write(session.id, "review.md", review, "review_agent");

      if (!hasBlock(findings) && !reviewBlocks(review)) {
        job.buildId = `build_${randomUUID().replace(/-/g, "")}`;
        return files;
      }

      log.warn("code.rejected", {
        sessionId: session.id,
        jobId: job.jobId,
        attempt,
        blocks: findings.filter((finding) => finding.level === "BLOCK").length,
      });
    }

    // 回数の下限も時間予算も使い切った。
    // 要件定義とUI設計までを成果物として提示し、生成失敗を明示する(AGENTS.md)
    throw new CodeRejectedError(
      `コード生成が${job.attempt}回とも要件を満たしませんでした` +
        `(時間予算 ${Math.round(this.#jobBudgetMs / 60_000)}分)。` +
        `要件定義と画面設計までを成果物とします`,
    );
  }

  /**
   * Review Agent。規則で見つけた指摘と、LLMの指摘を1つの `review.md` にまとめる。
   * LLMが落ちていても規則の指摘だけで判定できるようにする。
   */
  async #review(
    sessionId: string,
    files: FileMap,
    requirements: string,
    findings: ReturnType<typeof validate>,
  ): Promise<string> {
    const checks = findings.length === 0 ? "- 指摘なし" : renderFindings(findings);
    let fromLlm = "";

    try {
      fromLlm = await this.#call(sessionId, "review", buildSystem("review", null), [
        { title: "requirements.md", body: requirements },
        { title: "自動検査の結果", body: checks },
        { title: "生成物", body: renderCode(files) },
      ]);
    } catch (error) {
      // AGENTS.md:「レビューをスキップしてデプロイへ進む(レビュー失敗でデモを止めない)」
      // ただし規則の指摘は残す。事故はこちらで止める
      this.#reportFailure(sessionId, "review", error);
    }

    const verdict = hasBlock(findings) || reviewBlocks(fromLlm) ? "needs_fix" : "pass";
    return [
      "# Review",
      "",
      `## 判定: ${verdict}`,
      "",
      "### 自動検査",
      checks,
      "",
      "### レビュー",
      fromLlm.trim() === "" ? "- (実行できませんでした)" : stripHeadings(fromLlm).trim(),
      "",
    ].join("\n");
  }

  /**
   * `ai_instruction.md` を用意する。所有者は Orchestrator(AGENTS.md)。
   * 既にあれば手で直したものを尊重し、上書きしない。
   */
  async #ensureInstruction(sessionId: string): Promise<string> {
    const existing = await this.#read(sessionId, "ai_instruction.md");
    if (existing.trim() !== "") return existing;

    const instruction = DEFAULT_INSTRUCTION;
    await this.#write(sessionId, "ai_instruction.md", instruction, "orchestrator");
    return instruction;
  }

  /**
   * 時間予算が残っている限り、一時的なLLM失敗をやり直す。
   *
   * #call の1回きりの再試行(2秒)は「瞬きで直る失敗」用。こちらは
   * 「AIサービスが数分単位で混んでいる」用で、30秒(既定)待っては
   * 予算が尽きるまで叩き直す。内容起因・設定起因の失敗は待っても
   * 直らないので、即座に投げ直す。
   */
  async #persistently<T>(
    sessionId: string,
    withinBudget: () => boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof LLMError) || !error.retryable || !withinBudget()) throw error;
        log.warn("job.step_persisting", {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, this.#budgetRetryDelayMs));
        if (!withinBudget()) throw error;
      }
    }
  }

  /**
   * LLMを呼び、履歴を残す。成功・失敗のどちらでも記録する。
   *
   * 一時的な失敗(タイムアウト・混雑)は**1回だけ黙って再試行する。**
   * 実機の商談で code 工程がタイムアウト1発で落ち、営業担当が顧客の前で
   * 言い直す羽目になった。1回の再試行で拾える失敗を画面まで出さない。
   * 2回続けて落ちたら本当に調子が悪いので、そのまま失敗として返す。
   */
  async #call(
    sessionId: string,
    kind: AgentKind,
    system: string,
    sections: { title: string; body: string }[],
  ): Promise<string> {
    const input = buildInput(sections);
    const model = AGENT_MODEL[kind];
    const startedAt = Date.now();

    try {
      let response;
      try {
        response = await this.#llm.complete({ system, input, model });
      } catch (error) {
        if (!(error instanceof LLMError) || !error.retryable) throw error;
        log.warn("agent.retrying", {
          sessionId,
          agent: kind,
          message: error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, this.#llmRetryDelayMs));
        response = await this.#llm.complete({ system, input, model });
      }
      await this.#history.record(sessionId, {
        agent: kind,
        model: response.model,
        status: "succeeded",
        durationMs: Date.now() - startedAt,
        input,
        output: response.text,
        usage: response.usage,
        error: null,
      });
      return response.text;
    } catch (error) {
      await this.#history.record(sessionId, {
        agent: kind,
        model,
        status: "failed",
        durationMs: Date.now() - startedAt,
        input,
        output: "",
        usage: null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #read(sessionId: string, name: DocumentName): Promise<string> {
    return (await this.#docs.store.read(sessionId, name)) ?? "";
  }

  async #write(
    sessionId: string,
    name: DocumentName,
    text: string,
    writer: Parameters<SessionDocuments["store"]["replace"]>[3],
  ): Promise<void> {
    const body = text.trim() === "" ? DOCUMENTS[name].heading : text;
    const info = await this.#docs.store.replace(sessionId, name, body, writer);
    this.#notify(sessionId, {
      type: "document.updated",
      name: info.name,
      updatedAt: info.updatedAt,
    });
  }

  /**
   * 失敗を記録し、PWAへ知らせる。
   * `recoverable: true` を付けるのは、文字起こしが続いているため。
   */
  #reportFailure(sessionId: string, kind: AgentKind, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = error instanceof LLMError ? error.retryable : false;

    log.error("agent.failed", { sessionId, agent: kind, message, retryable });
    this.#notify(sessionId, {
      type: "error",
      code: "llm_unavailable",
      message: `${kind} Agentが失敗しました: ${message}`,
      recoverable: true,
    });
  }
}

function viewOfJob(job: Job): JobView {
  return {
    jobId: job.jobId,
    status: job.status,
    step: job.step,
    phrase: job.phrase,
    error: job.error,
    failure: job.failure,
    buildId: job.buildId,
    url: job.url,
    attempt: job.attempt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

/**
 * 生成物への既定の指示。所有者は Orchestrator(AGENTS.md の `ai_instruction.md`)。
 *
 * **ビルド工程を持たせない。** 商談中に npm install を走らせると、
 * 回線とサーバー(メモリ2GB)次第で10分の予算を使い切る。
 * ブラウザがそのまま解釈できる形に限定すれば、生成 → 配信が数秒で終わる。
 */
export const DEFAULT_INSTRUCTION = [
  "# AI Instruction",
  "",
  "- スタック: 素の HTML / CSS / JavaScript(ES2022)。**ビルド工程を持たせない**",
  "- 永続化: なし(インメモリのモックデータ)",
  "- スタイル: 最小限。装飾よりも動作を優先",
  "- 画面数: 2以内",
  "- 認証: なし",
  "- 制約: 外部を一切参照しないこと(CDN・Webフォント・外部API)。オフラインで動くこと",
  "- 制約: サーバーサイド実行を使わないこと(`process.env` / `require()` / SSR)",
  "- 制約: APIキーや認証情報を書かないこと",
  "- エントリ: `index.html`",
  "",
].join("\n");

/** ジョブの段階を、失敗を記録するAgentへ対応づける */
function stepToAgent(step: JobStep): AgentKind {
  switch (step) {
    case "requirements":
      return "requirement";
    case "ui":
      return "ui";
    case "code":
    case "deploy":
      return "code";
    case "review":
      return "review";
  }
}

/** レビュー本文に差し戻し対象の指摘が含まれるか */
function reviewBlocks(review: string): boolean {
  return /\[BLOCK\]/.test(review);
}

/**
 * 生成物が前回と同じかを比べるための指紋。
 * ファイル名の順序で結果が変わらないよう、並べ替えてから作る。
 */
function fingerprintOf(files: FileMap): string {
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** 生成物をレビューへ渡す形にする。長すぎるファイルは頭だけ見せる */
function renderCode(files: FileMap): string {
  const parts: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    const shown = body.length > 4_000 ? `${body.slice(0, 4_000)}\n…(以下省略)` : body;
    parts.push(`## ${name}`, "", shown, "");
  }
  return parts.join("\n");
}

/** 見出しを段落へ落とす。別の文書へ埋め込むときに階層が壊れないように */
function stripHeadings(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^#{1,3}\s/.test(line.trim()))
    .join("\n");
}

/**
 * `# 見出し` で始まる区画を取り出す。
 * LLMの出力から `# Issues` / `# Ideas` を切り分けるのに使う。
 */
function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `# ${heading}`);
  if (start === -1) return "";

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#\s/.test(line.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** transcript.md から見出し行を除いた本文。差分の有無の判定に使う */
function utteranceText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("")
    .trim();
}
