import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicLLMProvider } from "./anthropicLLMProvider.js";
import { LLMError } from "./types.js";

/**
 * 実APIの応答の**扱い方**を確かめる。接続そのものは資格情報が要るため、
 * `fetch` を差し替えて「実APIが返しうる形」を流し込む。
 *
 * ここで見ているのは、初回接続で必ず問題になる3点:
 *   - 拒否された応答(HTTP 200 で content が空)
 *   - 上限で切れた応答(途中までのMarkdownやコード)
 *   - リクエストの組み立て
 */

function provider(overrides: { maxTokens?: number } = {}): AnthropicLLMProvider {
  return new AnthropicLLMProvider({ apiKey: "test-key", model: "claude-opus-5", ...overrides });
}

function reply(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const request = { system: "# Agent: issue", input: "会話の差分", model: "claude-opus-5" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("応答の扱い", () => {
  it("通常の応答を読む", async () => {
    reply({
      content: [{ type: "text", text: "## ISS-001 課題" }],
      model: "claude-opus-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
    });

    const result = await provider().complete(request);
    expect(result.text).toBe("## ISS-001 課題");
    expect(result.usage?.cacheReadTokens).toBe(80);
  });

  it("拒否された応答を再試行しない", async () => {
    // 安全性の判定で断られた場合。HTTP 200 で content は空
    reply({
      content: [],
      model: "claude-opus-5",
      stop_reason: "refusal",
      stop_details: { category: "cyber", explanation: "..." },
      usage: { input_tokens: 100, output_tokens: 0 },
    });

    const error = await provider()
      .complete(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMError);
    // 同じ内容を投げ直しても同じ判定になる。3回粘っても無駄
    expect((error as LLMError).retryable).toBe(false);
    expect((error as LLMError).message).toContain("拒否");
    expect((error as LLMError).message).toContain("cyber");
  });

  it("上限で切れた応答を受け取らない", async () => {
    // 書きかけのコードがそのまま検証・配信へ流れると、商談の場で壊れる
    reply({
      content: [{ type: "text", text: "# index.html\n\n<!doctype html><html><body><div" }],
      model: "claude-opus-5",
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 16_000 },
    });

    const error = await provider()
      .complete(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).retryable).toBe(true);
    expect((error as LLMError).message).toContain("切れました");
  });

  it("空の応答は再試行する", async () => {
    reply({ content: [], model: "claude-opus-5", stop_reason: "end_turn" });

    const error = await provider()
      .complete(request)
      .catch((caught: unknown) => caught);

    expect((error as LLMError).retryable).toBe(true);
  });

  it("429 は再試行し、400 は再試行しない", async () => {
    reply({ error: { message: "rate limited" } }, 429);
    const rateLimited = await provider()
      .complete(request)
      .catch((caught: unknown) => caught);
    expect((rateLimited as LLMError).retryable).toBe(true);

    reply({ error: { message: "bad request" } }, 400);
    const badRequest = await provider()
      .complete(request)
      .catch((caught: unknown) => caught);
    expect((badRequest as LLMError).retryable).toBe(false);
  });
});

describe("リクエストの組み立て", () => {
  it("思考と本文を合わせた上限に余裕を持たせる", async () => {
    // Claude Opus 5 は指定しなければ思考が働き、max_tokens は思考と本文の合計にかかる。
    // 4096 では要件定義やコード生成が途中で切れる
    reply({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    await provider().complete(request);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call?.[1] as { body: string }).body) as { max_tokens: number };
    expect(body.max_tokens).toBeGreaterThanOrEqual(16_000);
  });

  it("安定した前置きにキャッシュの印を付ける", async () => {
    reply({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    await provider().complete(request);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call?.[1] as { body: string }).body) as {
      system: { cache_control?: { type: string } }[];
      messages: { role: string }[];
    };
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0]?.role).toBe("user");
  });

  it("APIキーをヘッダーで送り、本文には入れない", async () => {
    reply({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    await provider().complete(request);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call?.[1] as { headers: Record<string, string>; body: string };
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.body).not.toContain("test-key");
  });
});
