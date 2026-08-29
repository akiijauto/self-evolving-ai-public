#!/usr/bin/env node
/**
 * 実APIキーが入った時点で最初に走らせる検証。
 *
 *   ANTHROPIC_API_KEY=... node scripts/verify-llm.mjs
 *
 * 各Agentのプロンプトを実際のClaude APIへ通し、
 *   - 返ってきたMarkdownが後段の期待する形になっているか
 *   - 1商談あたりのトークン量(= コスト)がどれくらいか
 *   - プロンプトキャッシュが実際に効いているか
 * を1回で確かめる。**商談の実データは使わない**(見本の会話を使う)。
 */

import { readFileSync } from "node:fs";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY を設定してください");
  console.error("例: ANTHROPIC_API_KEY=sk-... node scripts/verify-llm.mjs");
  process.exit(2);
}

const BASE = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");

/** 見本の会話。実在の顧客名や数値は入れない(運用ルール) */
const TRANSCRIPT = `## 10:00:00 | A
在庫の管理は今どうされていますか。

## 10:00:04 | B
Excelで管理していて、担当者しか触れない状態です。

## 10:00:09 | A
更新はどのくらいの頻度ですか。

## 10:00:12 | B
毎朝1回です。ただ実態とズレることが多くて。

## 10:00:18 | A
担当者が不在のときはどうされていますか。

## 10:00:22 | B
確認が止まってしまいます。そこが一番困っています。
`;

/** 後段が読める形になっているかの判定。AGENTS.md のスキーマに対応する */
const CASES = [
  {
    kind: "issue",
    model: "claude-sonnet-5",
    system:
      "# Agent: issue\n\n会話から業務課題を拾い、issues.md の形式で返す。\n" +
      "各課題は `## ISS-001 見出し` と `- 根拠:` `- 影響:` `- 深刻度:` `- 状態:` を持つ。",
    input: `# transcript.md\n\n${TRANSCRIPT}`,
    expect: (text) => /^##\s+ISS-\d+/m.test(text) && text.includes("根拠"),
    expectLabel: "## ISS-001 形式の課題が1件以上",
  },
  {
    kind: "requirement",
    model: "claude-opus-5",
    system:
      "# Agent: requirement\n\n課題から要件定義を書く。1〜3画面に収める。\n" +
      "`## 目的` `## 機能要件` `## データモデル` `## 画面` の見出しを必ず使う。",
    input:
      "# issues.md\n\n## ISS-001 データが属人化している\n- 根拠: 「担当者しか触れない状態です」\n- 影響: 担当者不在で確認が止まる\n",
    expect: (text) =>
      ["## 目的", "## 機能要件", "## データモデル", "## 画面"].every((h) => text.includes(h)),
    expectLabel: "目的/機能要件/データモデル/画面 の4見出し",
  },
  {
    kind: "summary",
    model: "claude-sonnet-5",
    system:
      "# Agent: summary\n\n商談の議事録を書く。`## 商談概要` `## 会話の要点` `## 抽出した課題` の見出しを使う。",
    input: `# transcript.md\n\n${TRANSCRIPT}`,
    expect: (text) => text.includes("## 会話の要点"),
    expectLabel: "## 会話の要点 がある",
  },
];

async function call({ model, system, input }, { cached }) {
  const started = Date.now();
  const response = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16_000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: input }],
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body?.error?.message ?? "詳細不明"}`);
  }
  if (body.stop_reason === "refusal") {
    throw new Error(`拒否されました(分類: ${body.stop_details?.category ?? "不明"})`);
  }

  const text = (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  return {
    text,
    ms: Date.now() - started,
    truncated: body.stop_reason === "max_tokens",
    usage: body.usage ?? {},
    cachedRun: cached,
  };
}

console.log("\n実API検証(見本の会話を使用。実データは投入しない)\n");

let failures = 0;
let totalIn = 0;
let totalOut = 0;
let cacheReadSeen = 0;

for (const testCase of CASES) {
  process.stdout.write(`  ${testCase.kind} (${testCase.model}) ... `);
  try {
    // 2回投げる。2回目でキャッシュ読み出しが起きるかを見る
    const first = await call(testCase, { cached: false });
    const second = await call(testCase, { cached: true });

    const ok = testCase.expect(first.text);
    if (!ok) failures += 1;

    totalIn += (first.usage.input_tokens ?? 0) + (second.usage.input_tokens ?? 0);
    totalOut += (first.usage.output_tokens ?? 0) + (second.usage.output_tokens ?? 0);
    cacheReadSeen += second.usage.cache_read_input_tokens ?? 0;

    console.log(ok ? "OK" : "形式NG");
    console.log(`      期待: ${testCase.expectLabel}`);
    console.log(
      `      1回目: ${first.ms}ms  入力${first.usage.input_tokens ?? 0} / 出力${first.usage.output_tokens ?? 0}` +
        (first.truncated ? "  ← 上限で切れた" : ""),
    );
    console.log(
      `      2回目: ${second.ms}ms  キャッシュ書込${second.usage.cache_creation_input_tokens ?? 0} / 読出${second.usage.cache_read_input_tokens ?? 0}`,
    );
    if (!ok) {
      console.log(`      --- 実際の出力(先頭300字) ---\n${first.text.slice(0, 300)}\n`);
    }
  } catch (error) {
    failures += 1;
    console.log(`失敗: ${error.message}`);
  }
}

console.log("\n── まとめ ──────────────────────────────");
console.log(`  合計トークン: 入力 ${totalIn} / 出力 ${totalOut}`);
console.log(
  `  キャッシュ読み出し: ${cacheReadSeen} トークン` +
    (cacheReadSeen === 0
      ? "\n      → 0 なら想定どおり。前置きが最小サイズ(Sonnet 5は1024、Opus 5は512トークン)に" +
        "\n        届いていない。context.md が大きい商談でのみ効く"
      : ""),
);
console.log(
  "\n  1商談あたりの目安: 上記はAgent3種を2回ずつ。実際の商談では" +
    "\n  Issue Agent が60秒ごとに回るため、30分商談で概ね30回前後の呼び出しになる。" +
    "\n  単価は https://platform.claude.com/docs/en/pricing で確認すること。\n",
);

process.exit(failures === 0 ? 0 : 1);
