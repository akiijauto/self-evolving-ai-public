import { detectAgent, type AgentKind } from "../agents/kinds.js";
import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "./types.js";

/**
 * 開発・テスト用のLLMモック。
 *
 * 推論はせず、決まった規則で入力からMarkdownを組み立てる。
 * 目的は「Orchestratorから各Agentを通ってMarkdownが更新される経路」を
 * **資格情報なしで最後まで通せる**ようにすること。Sprint 3 の MockSpeechProvider と同じ考え方。
 *
 * 出力の質は問わない。問うのは形(DATAFLOW.md のスキーマ)と、
 * 同じ入力からは同じ出力が出ること(冪等性の検証に要る)。
 */

export interface MockLLMOptions {
  /** 応答までの遅延。実APIの待ち時間の再現 */
  latencyMs?: number;
  /** 必ず失敗させる。縮退動作の確認用 */
  fail?: boolean;
}

/** 会話に出てきたら課題として拾う型。1パターン = 1課題 + 1アイデア */
interface ProblemPattern {
  match: RegExp;
  title: string;
  impact: string;
  severity: "high" | "medium" | "low";
  idea: string;
  outline: string;
  difficulty: "high" | "medium" | "low";
}

const PATTERNS: ProblemPattern[] = [
  {
    match: /属人|担当者しか|触れない|本人しか/,
    title: "データが属人化している",
    impact: "担当者が不在のときに確認が止まる",
    severity: "high",
    idea: "共有ダッシュボードを用意する",
    outline: "誰でも閲覧できる一覧画面を作り、更新履歴を残す",
    difficulty: "low",
  },
  {
    match: /ズレ|乖離|実態と|合わな|違って/,
    title: "記録と実態が食い違っている",
    impact: "誤った数値をもとに判断してしまう",
    severity: "high",
    idea: "更新時刻と更新者を記録する",
    outline: "最終更新を画面に出し、いつ誰が触ったかを追えるようにする",
    difficulty: "low",
  },
  {
    match: /Excel|エクセル|手作業|手入力|紙/,
    title: "管理が手作業に依存している",
    impact: "更新に手間がかかり、頻度を上げられない",
    severity: "medium",
    idea: "入力フォームを用意する",
    outline: "画面から直接更新できるようにし、転記をなくす",
    difficulty: "medium",
  },
  {
    match: /止ま|待ち|滞|遅れ|時間がかか/,
    title: "確認待ちで業務が滞留している",
    impact: "後工程が待たされ、全体の所要時間が伸びる",
    severity: "medium",
    idea: "検索で目的の情報にすぐ届くようにする",
    outline: "名称での絞り込みを付け、探す時間をなくす",
    difficulty: "low",
  },
];

export class MockLLMProvider implements LLMProvider {
  readonly #latencyMs: number;
  readonly #fail: boolean;

  constructor(options: MockLLMOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 0;
    this.#fail = options.fail ?? false;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs);
    if (this.#fail) throw new LLMError("LLMに接続できません(モック設定 fail)", true);

    const kind = detectAgent(req.system);
    if (kind === null) throw new LLMError("どのAgentからの呼び出しか判定できません", false);

    const text = render(kind, req.input);
    return {
      text,
      model: req.model ?? "mock",
      // モックは実際のトークンを持たない。概算すら返さず null にする。
      // 数字が入っていると実測値と取り違える
      usage: null,
    };
  }
}

function render(kind: AgentKind, input: string): string {
  switch (kind) {
    case "issue":
      return renderIssues(input);
    case "requirement":
      return renderRequirements(input);
    case "ui":
      return renderUi(input);
    case "code":
      // コード生成は CodeProvider が担当する。ここへは来ない
      throw new LLMError("コード生成はモックLLMの担当ではありません", false);
    case "review":
      return renderReview(input);
    case "summary":
      return renderSummary(input);
    case "todo":
      return renderTodo(input);
  }
}

/**
 * 未処理の会話から課題とアイデアを拾う。
 *
 * 見出しはパターンごとに固定なので、同じ話題が別の言い回しで再度出てきても
 * 同じ見出しになる。Orchestrator側のマージで二重登録にならない。
 */
function renderIssues(input: string): string {
  const transcript = sectionOf(input, "新しい会話");
  const hits = PATTERNS.filter((pattern) => pattern.match.test(transcript));

  const issues = ["# Issues", ""];
  const ideas = ["# Ideas", ""];

  for (const [index, pattern] of hits.entries()) {
    const quote = quoteFor(transcript, pattern.match);
    issues.push(
      `## ISS-${pad(index + 1)} ${pattern.title}`,
      `- 根拠: ${quote}`,
      `- 影響: ${pattern.impact}`,
      `- 深刻度: ${pattern.severity}`,
      "- 状態: open",
      "",
    );
    ideas.push(
      `## IDEA-${pad(index + 1)} ${pattern.idea}`,
      `- 対応課題: ${pattern.title}`,
      `- 概要: ${pattern.outline}`,
      `- 実現難易度: ${pattern.difficulty}`,
      "",
    );
  }

  return [...issues, ...ideas].join("\n");
}

function renderRequirements(input: string): string {
  const titles = headingTitles(sectionOf(input, "issues.md"));
  const ideas = headingTitles(sectionOf(input, "ideas.md"));

  const features = ideas
    .slice(0, 3)
    .map((idea, index) => `- FR-${index + 1} ${idea}`);
  if (features.length === 0) features.push("- FR-1 情報を一覧で表示する");

  return [
    "# Requirements",
    "",
    "## 目的",
    titles.length > 0
      ? `${titles[0]}という状態を解消し、関係者が同じ情報を見られるようにする。`
      : "会話で挙がった業務課題を解消する。",
    "",
    "## 対象ユーザー",
    "- 現場担当者(閲覧)",
    "- 管理者(登録・更新)",
    "",
    "## 機能要件",
    ...features,
    "",
    "## データモデル",
    "- Item: id, name, quantity, unit, updated_at, updated_by",
    "",
    "## 画面",
    "- 一覧画面",
    "- 更新モーダル",
    "",
    "## 対象外",
    "- 認証・権限管理",
    "- 外部システム連携",
    "- 帳票出力",
    "",
  ].join("\n");
}

function renderUi(input: string): string {
  const screens = listItems(sectionOf(input, "requirements.md"), "画面").slice(0, 3);
  const names = screens.length > 0 ? screens : ["一覧画面"];

  const lines = ["# UI", ""];
  for (const [index, name] of names.entries()) {
    lines.push(
      `## 画面${index + 1}: ${name}`,
      "- ヘッダー: タイトルと検索ボックス",
      "- 本体: 一覧(名称 / 数量 / 単位 / 最終更新)",
      "- 行を選ぶと更新の入力欄を開く",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * レビュー。モックは規則で見つかる範囲しか見ない。
 * 自動検査(validate.ts)が既に挙げた点は繰り返さない。
 */
function renderReview(input: string): string {
  const code = sectionOf(input, "生成物");
  const lines: string[] = [];

  if (!/<form|<button|addEventListener/.test(code)) {
    lines.push("- [WARN] 操作できる要素が見当たりません");
  }
  if (!/aria-|<label/.test(code)) {
    lines.push("- [WARN] ラベルが不足しています。読み上げで内容が伝わりません");
  }

  return lines.length === 0 ? "- 指摘なし" : lines.join("\n");
}

function renderSummary(input: string): string {
  const issues = headingTitles(sectionOf(input, "issues.md"));
  const ideas = headingTitles(sectionOf(input, "ideas.md"));
  const utterances = utterancesOf(sectionOf(input, "transcript.md")).slice(0, 5);

  return [
    "# Summary",
    "",
    "## 商談概要",
    issues.length > 0 ? `${issues[0]}を中心にヒアリングした。` : "業務についてヒアリングした。",
    "",
    "## 会話の要点",
    ...(utterances.length > 0 ? utterances.map((line) => `- ${line}`) : ["- (記録なし)"]),
    "",
    "## 抽出した課題",
    ...(issues.length > 0 ? issues.map((title) => `- ${title}`) : ["- (なし)"]),
    "",
    "## 提案した解決策",
    ...(ideas.length > 0 ? ideas.map((title) => `- ${title}`) : ["- (なし)"]),
    "",
    "## 生成したMVP",
    "なし",
    "",
    "## 次のアクション",
    "todo.md を参照",
    "",
  ].join("\n");
}

function renderTodo(input: string): string {
  const issues = headingTitles(sectionOf(input, "issues.md"));
  const lines = ["# Todo", ""];
  for (const title of issues.slice(0, 3)) {
    lines.push(`- [ ] ${title}の現状を確認する — 担当: 未定 — 期限: 未定`);
  }
  if (issues.length === 0) lines.push("- [ ] 次回のヒアリング日程を決める — 担当: 未定 — 期限: 未定");
  lines.push("");
  return lines.join("\n");
}

// ── 入力の読み取り ─────────────────────────────────

/** `# <名前>...` の見出しで区切られた1区画を取り出す */
function sectionOf(input: string, name: string): string {
  const lines = input.split("\n");
  const start = lines.findIndex((line) => line.startsWith("# ") && line.includes(name));
  if (start === -1) return "";

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("# "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** `## ID タイトル` からタイトルだけを集める */
function headingTitles(markdown: string): string[] {
  const titles: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^##\s+[A-Z]+-\d+\s+(.+)$/.exec(line.trim());
    if (match) titles.push((match[1] as string).trim());
  }
  return titles;
}

/** `## 名前` セクションの箇条書きを集める */
function listItems(markdown: string, section: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (start === -1) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("##")) break;
    const match = /^-\s+(.+)$/.exec(line.trim());
    if (match) items.push((match[1] as string).trim());
  }
  return items;
}

/** transcript.md の本文行(見出し以外)を拾う */
function utterancesOf(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** 課題の根拠として、パターンに当たった発話を引用する */
function quoteFor(transcript: string, pattern: RegExp): string {
  const lines = transcript.split("\n").map((line) => line.trim());
  let clock = "";

  for (const line of lines) {
    const heading = /^##\s+(\d{2}:\d{2}:\d{2})/.exec(line);
    if (heading) {
      clock = heading[1] as string;
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    if (pattern.test(line)) {
      const quote = line.length > 40 ? `${line.slice(0, 40)}…` : line;
      return clock === "" ? `「${quote}」` : `${clock} 「${quote}」`;
    }
  }
  return "(引用なし)";
}

function pad(value: number): string {
  return String(value).padStart(3, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
