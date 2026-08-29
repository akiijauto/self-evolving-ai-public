import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "./types.js";

/**
 * Claude API(Messages API)を使う実装。
 *
 * ⚠️ **実接続は未検証。** 開発環境に資格情報が無いため、実際の応答では確かめていない。
 * ただしリクエストとレスポンスの扱いは公式仕様と突き合わせ済みで、
 * 初回接続で必ず問題になる箇所は潰してある(下記)。
 *
 * system ブロックに `cache_control` を付ける。DATAFLOW.md の差分処理の規約どおり、
 * 安定した前置き(指示 + `context.md`)をキャッシュさせ、差分だけを毎回送るため。
 *
 * **ただし現状のプロンプト長ではキャッシュは働かない。** キャッシュ対象になる前置きには
 * 最小サイズがあり(Claude Opus 5 は512トークン、Claude Sonnet 5 は1024トークン)、
 * 下回ると**エラーも警告もなく素通り**する。各Agentの指示は190〜530文字しかないため、
 * `context.md` が十分に大きい商談でしか効かない。印を付けたままにしてあるのは、
 * 大きくなった時点で自動的に効き始めるため(付けておく害は無い)。
 */

export interface AnthropicOptions {
  apiKey: string;
  /** 省略時の既定モデル */
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  model?: string;
  /** `end_turn` / `max_tokens` / `refusal` など */
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string };
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;

  constructor(options: AnthropicOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    // `max_tokens` は**思考と本文を合わせた**上限。Claude Opus 5 は指定しなければ
    // 思考が働くため、4096では要件定義やコード生成が途中で切れる。
    // ストリーミングを使わない呼び出しでの目安は16000(これ以上はHTTPが先に切れる)。
    this.#maxTokens = options.maxTokens ?? 16_000;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = req.model ?? this.#model;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          max_tokens: this.#maxTokens,
          // 安定した前置きをキャッシュ対象にする
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.input }],
        }),
      });
    } catch (error) {
      throw new LLMError(
        `LLMに接続できません: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => null)) as MessagesResponse | null;

    if (!response.ok) {
      // 429 と 5xx は待てば通る見込みがある。4xx は投げ方が悪いので再試行しない
      const retryable = response.status === 429 || response.status >= 500;
      throw new LLMError(
        `LLMがエラーを返しました (${response.status}): ${body?.error?.message ?? "詳細不明"}`,
        retryable,
      );
    }

    // **`content` を読む前に `stop_reason` を見る。**
    // 拒否された応答は HTTP 200 で返り、`content` が空か途中までしか無い。
    // 素直に読むと「空の応答」に見えるが、原因も対処も違う。
    if (body?.stop_reason === "refusal") {
      const category = body.stop_details?.category ?? "不明";
      // 同じ内容を投げ直しても同じ判定になる。再試行しない
      throw new LLMError(`LLMが応答を拒否しました(分類: ${category})`, false);
    }

    const text = (body?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    if (text.trim() === "") throw new LLMError("LLMが空の応答を返しました", true);

    // 上限に当たった応答は**途中で切れている**。
    // そのまま通すと、閉じていないMarkdownや書きかけのコードが後段へ流れる。
    // 商談中に一度も失敗できない工程なので、黙って受け取らない。
    if (body?.stop_reason === "max_tokens") {
      throw new LLMError(
        `LLMの応答が上限(${this.#maxTokens}トークン)で切れました。途中までの出力は使いません`,
        true,
      );
    }

    return {
      text,
      model: body?.model ?? model,
      usage: {
        inputTokens: body?.usage?.input_tokens ?? 0,
        outputTokens: body?.usage?.output_tokens ?? 0,
        cacheReadTokens: body?.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: body?.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
