/**
 * 商談中に画面共有する前提の、最小限のMarkdown描画。
 *
 * 扱うのは DATAFLOW.md のスキーマに出てくる要素だけ:
 * 見出し(`#` / `##`)、箇条書き(`-`)、チェックリスト(`- [ ]`)、段落。
 * 汎用のMarkdownライブラリを入れないのは、**表示する形をこちらで決めきるため**。
 * 顧客の目の前に出るものに、想定外の描画をさせない。
 */

export type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "list"; items: ListItem[] }
  | { kind: "p"; text: string };

export interface ListItem {
  text: string;
  /** `- [ ]` / `- [x]` のときだけ入る */
  checked: boolean | null;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let list: ListItem[] | null = null;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      blocks.push({ kind: "list", items: list });
      list = null;
    }
  };
  const flush = (): void => {
    flushParagraph();
    flushList();
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();

    if (line === "") {
      flush();
      continue;
    }

    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: heading[1] === "#" ? "h1" : "h2", text: (heading[2] ?? "").trim() });
      continue;
    }

    const item = /^-\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const body = (item[1] ?? "").trim();
      const check = /^\[( |x|X)\]\s*(.*)$/.exec(body);
      list ??= [];
      list.push(
        check
          ? { text: (check[2] ?? "").trim(), checked: check[1]?.toLowerCase() === "x" }
          : { text: body, checked: null },
      );
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flush();
  return blocks;
}

/** ファイル名を画面に出す日本語へ。DATAFLOW.md のスキーマ一覧に対応する */
export const DOCUMENT_LABEL: Record<string, string> = {
  "meeting.md": "商談",
  "transcript.md": "文字起こし",
  "issues.md": "課題",
  "ideas.md": "アイデア",
  "requirements.md": "要件定義",
  "ui.md": "画面設計",
  "todo.md": "アクション",
  "summary.md": "サマリ",
  "context.md": "参考情報",
  "ai_instruction.md": "生成指示",
  "review.md": "レビュー",
};

export function labelOf(name: string): string {
  return DOCUMENT_LABEL[name] ?? name;
}

/**
 * タブに並べる順。商談中に見たい順に固定する。
 * ここに無いファイルは後ろへ回す。
 */
const ORDER = [
  "issues.md",
  "ideas.md",
  "requirements.md",
  "ui.md",
  "summary.md",
  "todo.md",
  "meeting.md",
  "context.md",
];

export function sortForDisplay(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const left = ORDER.indexOf(a);
    const right = ORDER.indexOf(b);
    if (left === right) return a.localeCompare(b);
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  });
}
