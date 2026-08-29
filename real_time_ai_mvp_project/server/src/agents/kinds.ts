/**
 * Agentの種類。AGENTS.md の一覧に対応する。
 *
 * `summary` と `todo` は AGENTS.md では1つの Transcript Agent だが、
 * 出力ファイルが2つあるため呼び出しを分けている。
 * 1回のLLM呼び出しで1つのMarkdownを作るほうが、失敗の切り分けが楽になる。
 */
export type AgentKind = "issue" | "requirement" | "ui" | "code" | "review" | "summary" | "todo";

/**
 * システムプロンプトの先頭行に置く識別子。
 *
 * モックのLLMがどのAgentからの呼び出しかを判定するために使う。
 * 実APIにとってはただの見出しで、害はない。
 */
export const AGENT_MARKER = "# Agent:";

export function agentHeader(kind: AgentKind): string {
  return `${AGENT_MARKER} ${kind}`;
}

export function detectAgent(system: string): AgentKind | null {
  const match = new RegExp(`^${AGENT_MARKER}\\s*(\\w+)`, "m").exec(system);
  const kind = match?.[1];
  return kind !== undefined && isAgentKind(kind) ? kind : null;
}

function isAgentKind(value: string): value is AgentKind {
  return ["issue", "requirement", "ui", "code", "review", "summary", "todo"].includes(value);
}
