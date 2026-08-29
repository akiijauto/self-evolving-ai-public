import { parseMarkdown, type Block } from "../documents/markdown";

/**
 * Markdownの描画(共通)。Documents のタブと、トリガー確認の議事録が使う。
 * 扱う要素は DATAFLOW.md のスキーマに出てくるものだけ。
 */
export function MarkdownView({ source }: { source: string }) {
  return (
    <>
      {parseMarkdown(source).map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "h1":
      // どのファイルかは外側(タブ・見出し)が示している。最上位見出しは繰り返さない
      return null;
    case "h2":
      return <h3 className="documents-heading">{block.text}</h3>;
    case "list":
      return (
        <ul className="documents-list">
          {block.items.map((item, index) => (
            <li key={index} className="documents-item">
              {item.checked !== null && (
                <span className="documents-check">{item.checked ? "☑" : "☐"}</span>
              )}
              {item.text}
            </li>
          ))}
        </ul>
      );
    case "p":
      return <p className="documents-paragraph">{block.text}</p>;
  }
}
