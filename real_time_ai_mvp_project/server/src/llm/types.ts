/**
 * LLMプロバイダの抽象。
 *
 * ARCHITECTURE.md の「交換可能性」に対応する。
 * Agentが指定するのは**プロンプトとモデル名だけ**で、どの実装が動いているかを知らない。
 *
 * 音声はここへ届かない。LLMが扱うのはテキスト(Markdown)のみ
 * (ARCHITECTURE.md:「LLM APIは音声を直接受け付けない」)。
 */

export interface LLMRequest {
  /**
   * システムプロンプト。**安定した前置き**として使う。
   *
   * DATAFLOW.md の差分処理の規約に従い、変動しない指示と `context.md` をここへ置き、
   * 変動する差分テキストは `input` の末尾へ置く。プロンプトキャッシュを効かせるため。
   */
  system: string;
  input: string;
  /** 省略時はプロバイダの既定モデル */
  model?: string;
}

/**
 * 使用量。コストの実測に使う。
 *
 * RETROSPECTIVE.md の未解決の論点「商談終了時の差分再生成」は、
 * LLM呼び出しコストを測ってから判断すると決めている。測れない設計にしない。
 * 取得できないプロバイダは null を返してよい。
 */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LLMResponse {
  text: string;
  /** 実際に使われたモデル名 */
  model: string;
  usage: LLMUsage | null;
}

export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/** 再試行して回復する見込みがあるかを、呼び出し側が判断できるようにする */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
