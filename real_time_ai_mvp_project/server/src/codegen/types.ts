/**
 * コード生成の抽象。ARCHITECTURE.md の「交換可能性」に対応する。
 *
 * 生成物は**静的ファイルのみ**。Gateway Server がそのまま配信するため、
 * サーバーサイド実行もビルド工程も要らない形に限定する。
 */

/** 相対パス → 内容。ARCHITECTURE.md の `FileMap` */
export type FileMap = Record<string, string>;

export interface CodeRequest {
  /** ログを商談単位で追えるようにするためだけに使う。生成物には出さない */
  sessionId: string;
  requirements: string;
  /** 画面設計。無くてもよい(AGENTS.md: 必須入力ではない) */
  ui: string;
  instruction: string;
  /** 差し戻し時のレビュー結果。初回は null */
  review: string | null;
}

export interface CodeProvider {
  generate(req: CodeRequest): Promise<FileMap>;
}

export class CodeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CodeError";
  }
}

/** エントリになるファイル。これが無い生成物は配信できない */
export const ENTRY_FILE = "index.html";

/** 1ビルドの上限。商談中に生成するものとして、これを超えたら何かが壊れている */
export const MAX_FILES = 30;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
