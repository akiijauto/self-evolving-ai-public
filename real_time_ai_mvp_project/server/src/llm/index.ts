import { AGENT_MODEL } from "../agents/prompts.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { AnthropicLLMProvider } from "./anthropicLLMProvider.js";
import { MockLLMProvider } from "./mockLLMProvider.js";
import type { LLMProvider } from "./types.js";

export * from "./types.js";
export { MockLLMProvider } from "./mockLLMProvider.js";
export { AnthropicLLMProvider } from "./anthropicLLMProvider.js";

/**
 * 設定からLLMプロバイダを組み立てる。
 * ここが唯一「どの実装を使うか」を知っている場所。Agentは LLMProvider としてしか触らない。
 */
export function createLLMProvider(): LLMProvider {
  switch (config.llmProvider) {
    case "anthropic": {
      if (!config.anthropicApiKey) {
        // 起動時に落とす。商談中に気づくより、起動時に気づくほうがよい
        throw new Error(
          "LLM_PROVIDER=anthropic には ANTHROPIC_API_KEY が必要です。" +
            "設定するか LLM_PROVIDER=mock にしてください。",
        );
      }
      // 既定モデルだけを出すと「全部 Sonnet 5 で動いている」と読めてしまう。
      // 実際は requirement / code / review が Opus 5 で、費用も所要時間もそちらが支配する
      log.info("llm.provider", {
        provider: "anthropic",
        defaultModel: config.llmModel,
        agentModels: AGENT_MODEL,
      });
      return new AnthropicLLMProvider({
        apiKey: config.anthropicApiKey,
        model: config.llmModel,
        baseUrl: config.anthropicBaseUrl,
        timeoutMs: config.llmTimeoutMs,
      });
    }

    case "mock":
    default: {
      log.info("llm.provider", { provider: "mock", fail: config.llmFail });
      return new MockLLMProvider({ fail: config.llmFail, latencyMs: config.llmLatencyMs });
    }
  }
}
