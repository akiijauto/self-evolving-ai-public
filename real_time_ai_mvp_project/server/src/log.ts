import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 構造化ログ。
 *
 * REQUIREMENTS.md のログ要件:
 * 全イベントを時系列保存 / Agent実行履歴保存 / エラー履歴保存。
 *
 * 標準出力(JSON Lines)に加えて、`{LOG_DIR}/events-YYYY-MM-DD.jsonl` へ追記する。
 * 商談後に「あの時なにが起きたか」を追うのはファイルの方で、
 * `sessionId` で1商談ぶんを抜き出せる。
 *
 * 音声データそのものは絶対に出力しない(バイト数のみ)。
 */

type Level = "info" | "warn" | "error";

/**
 * 保存先。config.ts を経由しないのは、設定の読み込み自体も記録できるようにするため。
 * テスト実行中はファイルへ書かない(並列実行で1ファイルを取り合わないように)。
 */
const LOG_DIR = process.env.VITEST === "true" ? null : (process.env.LOG_DIR ?? "data/logs");

let ready = false;

function persist(line: string): void {
  if (LOG_DIR === null) return;

  try {
    if (!ready) {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      ready = true;
    }
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(LOG_DIR, `events-${day}.jsonl`), `${line}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // ログの保存失敗で商談を止めない。標準出力には出ている
  }
}

function emit(level: Level, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  persist(line);
}

export const log = {
  info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit("error", event, fields),
};
