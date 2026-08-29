/**
 * `CODE_PROVIDER=llm` に切り替える前に必ず走らせる検証。
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/verify-codegen.mts
 *
 * `verify-llm.mjs` は各Agentのプロンプトを**写して**投げるが、こちらは
 * **サーバーが本番で使う実装そのもの**(`LLMCodeProvider` / `validate` /
 * Review Agent のプロンプト)を読み込んで動かす。写しではないので、
 * ここが通れば商談でも同じ経路が通る。
 *
 * 確かめること:
 *   1. 応答からファイルを取り出せるか(`parseFileMap` が0件を返さないか)
 *   2. `index.html` があるか。無ければ配信できない
 *   3. 検証層が BLOCK を出さないか(外部参照・サーバー実行・シークレット)
 *   4. Review Agent が `[BLOCK]` を返さないか
 *   5. 承認からURLまでの時間予算に収まるか
 *
 * **商談の実データは使わない**(見本の要件定義を使う)。
 */

import { AGENT_MODEL, buildSystem } from "../server/src/agents/prompts.js";
import { DEFAULT_INSTRUCTION } from "../server/src/agents/orchestrator.js";
import {
  ENTRY_FILE,
  LLMCodeProvider,
  hasBlock,
  renderFindings,
  validate,
} from "../server/src/codegen/index.js";
import { AnthropicLLMProvider } from "../server/src/llm/anthropicLLMProvider.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey === "") {
  console.error("ANTHROPIC_API_KEY を設定してください");
  console.error("例: ANTHROPIC_API_KEY=sk-... npx tsx scripts/verify-codegen.mts");
  process.exit(2);
}

/** 見本の要件定義。実在の顧客名や数値は入れない(運用ルール) */
const REQUIREMENTS = `# Requirements

## 目的
在庫の状況を担当者以外も確認できるようにし、担当者不在で確認が止まるのを防ぐ。

## 機能要件
- 在庫の一覧を表示する
- 品目名で絞り込む
- 数量を更新する
- 更新した日時と担当者を表示する

## データモデル
- 品目: 名称 / 数量 / 単位 / 最終更新日時 / 更新者

## 画面
- 在庫一覧(絞り込み・数量更新)
`;

const UI = `# UI

## 在庫一覧
- 上部に検索欄
- 表形式で 品目 / 数量 / 最終更新 / 更新者
- 各行に数量の増減ボタン
`;

const llm = new AnthropicLLMProvider({
  apiKey,
  model: process.env.CODE_MODEL ?? "claude-opus-5",
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  // 商談中と同じ上限にする。ここだけ緩めると本番で切れる
  timeoutMs: 180_000,
});

const code = new LLMCodeProvider({ llm, model: process.env.CODE_MODEL ?? "claude-opus-5" });

console.log("\n実APIでのコード生成検証(見本の要件定義を使用。実データは投入しない)\n");
console.log(`  コード生成: ${process.env.CODE_MODEL ?? "claude-opus-5"}`);
console.log(`  レビュー:   ${AGENT_MODEL.review}\n`);

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "OK  " : "NG  "}${label}${detail === "" ? "" : `\n        ${detail}`}`);
}

// ── 1. 生成 ──────────────────────────────────────
const codeStarted = Date.now();
let files: Record<string, string>;
try {
  files = await code.generate({
    sessionId: "verify",
    requirements: REQUIREMENTS,
    ui: UI,
    instruction: DEFAULT_INSTRUCTION,
    review: null,
  });
} catch (error) {
  console.log(`  NG  コード生成が失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const codeMs = Date.now() - codeStarted;

const names = Object.keys(files);
const bytes = Object.values(files).reduce((sum, body) => sum + body.length, 0);
console.log(`  生成: ${codeMs}ms  ${names.length}ファイル / ${bytes}文字`);
console.log(`        ${names.join(", ")}\n`);

check("ファイルを取り出せた", names.length > 0);
check(`${ENTRY_FILE} がある`, ENTRY_FILE in files, ENTRY_FILE in files ? "" : "これが無いと配信できない");

// ── 2. 検証層 ────────────────────────────────────
const findings = validate(files);
const blocked = hasBlock(findings);
check(
  "検証層が BLOCK を出さない",
  !blocked,
  blocked ? renderFindings(findings.filter((f) => f.level === "BLOCK")) : "",
);
if (findings.length > 0 && !blocked) {
  console.log(`        指摘(WARNのみ):\n${renderFindings(findings)}`);
}

// ── 3. Review Agent ─────────────────────────────
const reviewStarted = Date.now();
const rendered = Object.entries(files)
  .map(([name, body]) => `## ${name}\n\n${body.length > 4_000 ? `${body.slice(0, 4_000)}\n…(以下省略)` : body}`)
  .join("\n\n");

let reviewText = "";
try {
  const response = await llm.complete({
    system: buildSystem("review", null),
    input: [
      "## requirements.md",
      "",
      REQUIREMENTS,
      "",
      "## 自動検査の結果",
      "",
      findings.length === 0 ? "- 指摘なし" : renderFindings(findings),
      "",
      "## 生成物",
      "",
      rendered,
    ].join("\n"),
    model: AGENT_MODEL.review,
  });
  reviewText = response.text;
} catch (error) {
  console.log(`  NG  レビューが失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
}
const reviewMs = Date.now() - reviewStarted;

if (reviewText !== "") {
  const reviewBlocks = /\[BLOCK\]/.test(reviewText);
  console.log(`\n  レビュー: ${reviewMs}ms`);
  check(
    "レビューが差し戻さない",
    !reviewBlocks,
    reviewBlocks ? reviewText.slice(0, 600) : "",
  );
}

// ── 4. 時間予算 ─────────────────────────────────
// AGENTS.md「承認から10分以内に配信開始」。requirement と ui は
// verify-llm.mjs の実測(33秒 / 22秒)を足して見積もる
const ESTIMATED_BEFORE_CODE_MS = 55_000;
const oneRound = ESTIMATED_BEFORE_CODE_MS + codeMs + reviewMs;
const twoRounds = ESTIMATED_BEFORE_CODE_MS + 2 * (codeMs + reviewMs);

console.log("\n── 時間予算(承認からURLまで)──────────────");
console.log(`  差し戻しなし: 約${Math.round(oneRound / 1000)}秒`);
console.log(`  1回差し戻し: 約${Math.round(twoRounds / 1000)}秒`);
console.log("  (requirement 33秒 + ui 22秒 を実測値から加算。配信とビルドは別途)");
check("差し戻し1回でも10分に収まる", twoRounds < 600_000);

console.log(
  failures === 0
    ? "\n>>> CODE_PROVIDER=llm で商談に出せます <<<\n"
    : `\n!!! ${failures}件が期待どおりではありません。CODE_PROVIDER=template のままにしてください\n`,
);

process.exit(failures === 0 ? 0 : 1);
