/**
 * Markdownドキュメントの登録簿。
 *
 * AGENTS.md の「ファイル所有者」表と DATAFLOW.md の「冪等性と競合」を
 * 実行可能な形にしたもの。**書き込みの可否はすべてここが決める。**
 *
 * ここに無い名前は存在しない。ファイル名の検証もこの表が兼ねるため、
 * `../` のようなパスがファイルシステム層へ届くことはない。
 */

export const DOCUMENT_NAMES = [
  "meeting.md",
  "transcript.md",
  "issues.md",
  "ideas.md",
  "requirements.md",
  "ui.md",
  "todo.md",
  "ai_instruction.md",
  "review.md",
  "summary.md",
  "context.md",
] as const;

export type DocumentName = (typeof DOCUMENT_NAMES)[number];

/**
 * 書き込み主体。
 *
 * `input_adapter` だけはAgentではない。DATAFLOW.md の「入力アダプタ」層で、
 * 音声以外の入力(手入力 / Circleback / Notion)をMarkdownへ正規化する。
 * どのファイルへも書けるが、追記専用ファイルへは追記しかできない。
 * この層より後段は入力元を一切意識しない。
 */
export type Writer =
  | "orchestrator"
  | "speech_agent"
  | "transcript_agent"
  | "issue_agent"
  | "requirement_agent"
  | "ui_agent"
  | "claude_code_agent"
  | "review_agent"
  | "memory_agent"
  | "input_adapter";

/**
 * 追記専用か、全文置換か。
 *
 * 追記専用ファイルの既存行を書き換えると、差分処理のカーソル(処理済みバイト位置)が
 * 指す内容が変わってしまい、同じ範囲の二重処理や取りこぼしが起きる。
 */
export type WriteMode = "append" | "replace";

export interface DocumentSpec {
  /** AGENTS.md の所有者。このAgent以外は書き込めない */
  owner: Writer;
  mode: WriteMode;
  /** ファイル先頭の見出し。DATAFLOW.md のMarkdownスキーマに対応する */
  heading: string;
}

export const DOCUMENTS: Record<DocumentName, DocumentSpec> = {
  "meeting.md": { owner: "orchestrator", mode: "replace", heading: "# Meeting" },
  "transcript.md": { owner: "speech_agent", mode: "append", heading: "# Realtime Transcript" },
  "issues.md": { owner: "issue_agent", mode: "replace", heading: "# Issues" },
  "ideas.md": { owner: "issue_agent", mode: "replace", heading: "# Ideas" },
  "requirements.md": { owner: "requirement_agent", mode: "replace", heading: "# Requirements" },
  "ui.md": { owner: "ui_agent", mode: "replace", heading: "# UI" },
  "todo.md": { owner: "transcript_agent", mode: "replace", heading: "# Todo" },
  "ai_instruction.md": { owner: "orchestrator", mode: "replace", heading: "# AI Instruction" },
  "review.md": { owner: "review_agent", mode: "replace", heading: "# Review" },
  "summary.md": { owner: "transcript_agent", mode: "replace", heading: "# Summary" },
  "context.md": { owner: "memory_agent", mode: "replace", heading: "# Context" },
};

export function isDocumentName(value: string): value is DocumentName {
  return Object.hasOwn(DOCUMENTS, value);
}

export type WriteCheck =
  /** 書き込んでよい */
  | "ok"
  /** 登録簿に無いファイル名 */
  | "unknown_document"
  /** 所有者でないAgentからの書き込み */
  | "not_owner"
  /** 追記専用ファイルを全文置換しようとした */
  | "append_only"
  /** 全文置換ファイルへ追記しようとした */
  | "replace_only";

/**
 * 書き込みの可否を判定する。
 *
 * 1ファイル1書き手の原則(DATAFLOW.md)を守るため、所有者以外は弾く。
 * 例外は入力アダプタのみ。外部入力の正規化はこの層に集約すると決めている。
 */
export function checkWrite(name: string, writer: Writer, mode: WriteMode): WriteCheck {
  if (!isDocumentName(name)) return "unknown_document";

  const spec = DOCUMENTS[name];
  if (writer !== spec.owner && writer !== "input_adapter") return "not_owner";
  if (spec.mode === "append" && mode === "replace") return "append_only";
  if (spec.mode === "replace" && mode === "append") return "replace_only";
  return "ok";
}

/** 判定結果を人間向けの説明にする。HTTPのエラーメッセージにそのまま使う */
export function describeCheck(check: WriteCheck, name: string, writer: Writer): string {
  switch (check) {
    case "ok":
      return "";
    case "unknown_document":
      return `${name} は存在しないドキュメントです`;
    case "not_owner":
      return `${name} の書き込みは ${DOCUMENTS[name as DocumentName].owner} のみに許可されています(要求元: ${writer})`;
    case "append_only":
      return `${name} は追記専用です。既存行を書き換えることはできません`;
    case "replace_only":
      return `${name} は全文置換のみです。追記はできません`;
  }
}
