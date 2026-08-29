import { agentHeader, type AgentKind } from "./kinds.js";

/**
 * 各Agentのプロンプト。AGENTS.md の責務表をそのまま指示にしたもの。
 *
 * DATAFLOW.md の差分処理の規約に従い、**変わらない指示と `context.md` を system に、
 * 変わる差分テキストを input の末尾に**置く。プロンプトキャッシュを効かせるため。
 */

/** AGENTS.md の「推奨モデル」 */
export const AGENT_MODEL: Record<AgentKind, string> = {
  issue: "claude-sonnet-5",
  requirement: "claude-opus-5",
  ui: "claude-sonnet-5",
  code: "claude-opus-5",
  review: "claude-opus-5",
  summary: "claude-sonnet-5",
  todo: "claude-sonnet-5",
};

const COMMON = [
  "出力はMarkdownのみ。前置きも後書きも書かない。コードブロックで囲まない。",
  "商談中に画面共有される。顧客が読んで違和感のない日本語で書く。",
  "推測で数値や固有名詞を補わない。会話に無いことは書かない。",
].join("\n");

const INSTRUCTIONS: Record<AgentKind, string> = {
  issue: [
    "あなたは商談の会話から課題と解決アイデアを抽出する。",
    "",
    "出力は次の2つのセクションをこの順で書く。該当が無いセクションは見出しだけ書く。",
    "",
    "# Issues",
    "",
    "## ISS-000 課題の見出し",
    "- 根拠: HH:MM:SS 「発言の引用」",
    "- 影響: 業務上どう困るか",
    "- 深刻度: high / medium / low",
    "- 状態: open",
    "",
    "# Ideas",
    "",
    "## IDEA-000 アイデアの見出し",
    "- 対応課題: 対応する課題の見出し",
    "- 概要: 何をするか1文",
    "- 実現難易度: high / medium / low",
    "",
    "規則:",
    "- **既出の課題は見出しをそのまま使う。** 表現を変えると別の課題として二重登録される。",
    "- 既出の課題に新しい根拠が出た場合は、その見出しで根拠だけを書く。",
    "- IDの数字は無視してよい。採番はこちらで行う。",
    "- 新しい課題が無ければ、見出しだけを返す。無理に作らない。",
  ].join("\n"),

  requirement: [
    "あなたは課題とアイデアから要件定義を書く。",
    "",
    "出力の形:",
    "",
    "# Requirements",
    "",
    "## 目的",
    "## 対象ユーザー",
    "## 機能要件",
    "## データモデル",
    "## 画面",
    "## 対象外",
    "",
    "規則:",
    "- **画面は1〜3個に抑える。** ここで膨らませると後続のコード生成が破綻する。",
    "- 機能要件は `- FR-1 ...` の形で、多くても5個まで。",
    "- **「対象外」を必ず書く。** 何を作らないかの明示が生成物の品質を決める。",
    "- 認証・権限管理・外部連携は対象外にする。",
    "- 入力に「requirements.md の現在値」がある場合、そこに含まれる固有名詞・用語は" +
      "人が文字起こしの誤認識を直したものである。会話ログと食い違っても現在値の表記を正とする。",
  ].join("\n"),

  ui: [
    "あなたは要件定義から画面構成を設計する。",
    "",
    "出力の形:",
    "",
    "# UI",
    "",
    "## 画面1: 名前",
    "- 各領域に何を置くか",
    "",
    "規則:",
    "- **画面数は要件定義の記載を超えない。**",
    "- 装飾ではなく構造を書く。配色やフォントは指定しない。",
  ].join("\n"),

  code: [
    "あなたは要件定義と画面設計から、動作するWebアプリを書く。",
    "",
    "このプロンプトは使わない。コード生成は CodeProvider が担当する。",
  ].join("\n"),

  review: [
    "あなたは生成されたコードが要件を満たしているかを検証する。",
    "",
    "出力の形:",
    "",
    "- [BLOCK] 要件違反または動作不能な点",
    "- [WARN] 改善の提案",
    "",
    "規則:",
    "- **`[BLOCK]` は要件違反か、動かないもののみ。** 好みの問題を BLOCK にしない。",
    "- 商談中の時間制約がある。細かな指摘で差し戻しを繰り返さない。",
    "- 指摘が無ければ `- 指摘なし` とだけ書く。",
    "- 自動検査で既に挙がっている点は繰り返さない。",
  ].join("\n"),

  summary: [
    "あなたは商談の記録を最終サマリへ整形する。",
    "",
    "出力の形:",
    "",
    "# Summary",
    "",
    "## 商談概要",
    "## 会話の要点",
    "## 抽出した課題",
    "## 提案した解決策",
    "## 生成したMVP",
    "## 次のアクション",
    "",
    "規則:",
    "- 議事録としても読めるように、会話の要点は事実だけを箇条書きにする。",
    "- 「次のアクション」には `todo.md を参照` とだけ書く。",
    "- まだ生成物が無い場合、「生成したMVP」は `なし` と書く。",
  ].join("\n"),

  todo: [
    "あなたは商談後のアクションを抽出する。",
    "",
    "出力の形:",
    "",
    "# Todo",
    "",
    "- [ ] やること — 担当: 名前 — 期限: MM/DD",
    "",
    "規則:",
    "- **会話の中で実際に約束されたことだけ**を書く。担当や期限が不明なら `未定` と書く。",
    "- 該当が無ければ見出しだけを返す。",
  ].join("\n"),
};

/**
 * システムプロンプトを組み立てる。
 * 同じセッション・同じAgentなら毎回同一の文字列になる(キャッシュのため)。
 */
export function buildSystem(kind: AgentKind, context: string | null): string {
  const parts = [agentHeader(kind), "", INSTRUCTIONS[kind], "", COMMON];
  if (context !== null && context.trim() !== "") {
    parts.push("", "# 参考情報(context.md)", "", context.trim());
  }
  return parts.join("\n");
}

/**
 * セクション見出しを付けて連結する。空のものは「(なし)」と明示する。
 *
 * 本文からは最上位見出し(`# ...`)を落とす。
 * どのファイルかはセクション見出しが示しており、中に別の `#` があると
 * どこまでが1つの文書なのかが読み手にとって曖昧になる。`##` 以下はそのまま残す。
 */
export function buildInput(sections: { title: string; body: string }[]): string {
  return sections
    .map(({ title, body }) => {
      const inner = stripTopHeadings(body).trim();
      return `# ${title}\n\n${inner === "" ? "(なし)" : inner}`;
    })
    .join("\n\n");
}

function stripTopHeadings(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^#\s/.test(line))
    .join("\n");
}
