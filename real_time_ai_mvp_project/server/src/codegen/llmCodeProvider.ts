import type { LLMProvider } from "../llm/types.js";
import { CodeError, ENTRY_FILE, MAX_FILES, type CodeProvider, type CodeRequest, type FileMap } from "./types.js";
import { isSafePath } from "./validate.js";

/**
 * LLMにコードを書かせる実装。
 *
 * **本番で使う前に `scripts/verify-codegen.mts` を通すこと。**
 * この実装をそのまま実APIへ通し、ファイルを取り出せるか・`index.html` があるか・
 * 検証層とReview Agentが差し戻さないか・時間予算に収まるかを確かめる。
 * 写しではなくこのクラス自身を動かすので、通れば商談でも同じ経路が通る。
 *
 * AGENTS.md の Claude Code Agent に対応する。生成物は静的ファイルのみ。
 * 受け取った応答は**必ず検証層(validate.ts)を通す。** ここで信用しない。
 */

const FENCE = "````";

const SYSTEM = [
  "# Agent: code",
  "",
  "あなたは要件定義と画面設計から、動作するWebアプリを書く。",
  "",
  "出力の形。ファイルごとに次を繰り返す。前置きも後書きも書かない。",
  "",
  "### <相対パス>",
  FENCE,
  "<ファイルの内容>",
  FENCE,
  "",
  "制約:",
  `- **${ENTRY_FILE} を必ず含める。** これがエントリになる`,
  "- **ビルド工程を持たせない。** ブラウザがそのまま解釈できる HTML / CSS / JavaScript だけを書く",
  "- **外部を一切参照しない。** CDN・Webフォント・外部APIを使わない。オフラインで動くこと",
  "- サーバーサイド実行を使わない(`process.env` / `require()` / SSR)",
  "- **APIキーや認証情報を書かない。** そもそも通信しないので不要",
  "- データはメモリ上のモックのみ。永続化しない",
  `- ファイル数は ${MAX_FILES} 個以内`,
  "- 装飾より動作を優先する。商談中に見せる試作品である",
].join("\n");

export class LLMCodeProvider implements CodeProvider {
  readonly #llm: LLMProvider;
  readonly #model: string;

  constructor(options: { llm: LLMProvider; model: string }) {
    this.#llm = options.llm;
    this.#model = options.model;
  }

  async generate(req: CodeRequest): Promise<FileMap> {
    const sections = [
      `# requirements.md\n\n${req.requirements.trim()}`,
      `# ui.md\n\n${req.ui.trim() === "" ? "(なし)" : req.ui.trim()}`,
      `# ai_instruction.md\n\n${req.instruction.trim()}`,
    ];
    if (req.review !== null) {
      // 差し戻しは末尾。前の応答との差分だけが変わるようにする
      sections.push(`# 前回のレビュー(指摘を直すこと)\n\n${req.review.trim()}`);
    }

    const response = await this.#llm.complete({
      system: SYSTEM,
      input: sections.join("\n\n"),
      model: this.#model,
    });

    const files = parseFileMap(response.text);
    if (Object.keys(files).length === 0) {
      throw new CodeError("応答からファイルを取り出せませんでした", true);
    }
    return files;
  }
}

/**
 * `### パス` + フェンスの並びを読む。
 *
 * 安全でないパスは**黙って捨てる。** 配信ディレクトリの外へ書かせない。
 * 捨てた結果 `index.html` が無くなれば、検証層が BLOCK として拾う。
 */
export function parseFileMap(text: string): FileMap {
  const files: FileMap = {};
  const lines = text.split("\n");

  let path: string | null = null;
  let fence: string | null = null;
  let body: string[] = [];

  for (const line of lines) {
    if (fence !== null) {
      if (line.trimEnd() === fence) {
        if (path !== null && isSafePath(path)) files[path] = `${body.join("\n")}\n`;
        path = null;
        fence = null;
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }

    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      path = (heading[1] as string).replace(/^[`"']|[`"']$/g, "").trim();
      continue;
    }

    const open = /^(`{3,})/.exec(line.trim());
    if (open && path !== null) {
      fence = open[1] as string;
      body = [];
    }
  }

  return files;
}
