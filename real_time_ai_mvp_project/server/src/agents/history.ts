import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import type { MarkdownStore } from "../markdown/store.js";
import type { LLMUsage } from "../llm/types.js";
import type { AgentKind } from "./kinds.js";

/**
 * Agent実行履歴。
 *
 * REQUIREMENTS.md のログ要件(Agent実行履歴保存 / エラー履歴保存)と、
 * ROADMAP.md Sprint 5 の完了条件「入力・出力・所要時間・モデルが保存されている」に対応する。
 *
 * セッションのディレクトリに JSON Lines で追記する。
 * **Markdownの登録簿には載せない。** 成果物ではなく記録であり、
 * `GET /documents` には出さない(Agentの入力にもしない)。
 *
 * `usage` はコストの実測に使う。RETROSPECTIVE.md の未解決の論点
 * 「商談終了時の差分再生成」は、ここに溜まった数字を見て判断する。
 */

export const HISTORY_FILE = "agent_runs.jsonl";

export interface AgentRun {
  agent: AgentKind;
  model: string;
  status: "succeeded" | "failed";
  durationMs: number;
  input: string;
  output: string;
  usage: LLMUsage | null;
  error: string | null;
}

export class AgentHistory {
  readonly #store: MarkdownStore;

  constructor(store: MarkdownStore) {
    this.#store = store;
  }

  async record(sessionId: string, run: AgentRun): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), sessionId, ...run })}\n`;

    try {
      await this.#store.ensure(sessionId);
      // LLMへの入出力がそのまま入る。商談の全文と同じ扱いにする
      await appendFile(join(this.#store.dirOf(sessionId), HISTORY_FILE), line, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      // 記録に失敗しても商談は止めない。失敗したこと自体はログに残す
      log.error("agent.history_failed", {
        sessionId,
        agent: run.agent,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 積み上がった履歴を読む。コストの集計と、うまくいかなかった実行の確認に使う */
  async read(sessionId: string): Promise<(AgentRun & { at: string })[]> {
    const path = join(this.#store.dirOf(sessionId), HISTORY_FILE);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }

    const runs: (AgentRun & { at: string })[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        runs.push(JSON.parse(line) as AgentRun & { at: string });
      } catch {
        // 書き込み途中で落ちた行は捨てる
      }
    }
    return runs;
  }
}
