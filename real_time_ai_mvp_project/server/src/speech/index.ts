import { config } from "../config.js";
import { log } from "../log.js";
import { DeepgramSpeechProvider } from "./deepgramSpeechProvider.js";
import { MockSpeechProvider } from "./mockSpeechProvider.js";
import type { SpeechProvider } from "./types.js";

export * from "./types.js";
export { SttProxy } from "./sttProxy.js";
export { MockSpeechProvider, DEFAULT_SCRIPT } from "./mockSpeechProvider.js";
export { DeepgramSpeechProvider } from "./deepgramSpeechProvider.js";

/**
 * 設定から音声認識プロバイダを組み立てる。
 *
 * ここが唯一「どの実装を使うか」を知っている場所。
 * 呼び出し側は SpeechProvider としてしか触らない。
 */
export function createSpeechProvider(): SpeechProvider {
  switch (config.speechProvider) {
    case "deepgram": {
      if (!config.deepgramApiKey) {
        // 起動時に落とす。商談中に気づくより、起動時に気づくほうがよい。
        throw new Error(
          "SPEECH_PROVIDER=deepgram には DEEPGRAM_API_KEY が必要です。" +
            "設定するか SPEECH_PROVIDER=mock にしてください。",
        );
      }
      log.info("speech.provider", { provider: "deepgram", model: config.deepgramModel });
      return new DeepgramSpeechProvider({
        apiKey: config.deepgramApiKey,
        model: config.deepgramModel,
      });
    }

    case "mock":
    default: {
      log.info("speech.provider", { provider: "mock", failOnOpen: config.speechFail });
      return new MockSpeechProvider({ failOnOpen: config.speechFail });
    }
  }
}
