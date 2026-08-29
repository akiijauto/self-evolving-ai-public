import { config } from "../config.js";
import { log } from "../log.js";
import type { LLMProvider } from "../llm/types.js";
import { LLMCodeProvider } from "./llmCodeProvider.js";
import { TemplateCodeProvider } from "./templateCodeProvider.js";
import type { CodeProvider } from "./types.js";

export * from "./types.js";
export * from "./validate.js";
export { TemplateCodeProvider } from "./templateCodeProvider.js";
export { LLMCodeProvider, parseFileMap } from "./llmCodeProvider.js";

/**
 * 設定からコード生成の実装を選ぶ。
 * ここが唯一「どの実装を使うか」を知っている場所。
 */
export function createCodeProvider(llm: LLMProvider): CodeProvider {
  switch (config.codeProvider) {
    case "llm":
      log.info("code.provider", { provider: "llm", model: config.codeModel });
      return new LLMCodeProvider({ llm, model: config.codeModel });

    case "template":
    default:
      log.info("code.provider", { provider: "template" });
      return new TemplateCodeProvider();
  }
}
