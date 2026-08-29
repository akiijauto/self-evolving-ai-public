/**
 * `requirements.md` から雛形が使う形へ読み替える層。
 *
 * 各雛形(list / approval / checklist / dashboard)はここが返す `Spec` だけを見る。
 * Markdownの見出し構造を知っているのはこのファイルだけにして、
 * スキーマが変わったときの直し先を1か所に閉じる。
 */

export interface Spec {
  title: string;
  purpose: string;
  features: string[];
  fields: Field[];
  screens: string[];
}

export interface Field {
  key: string;
  label: string;
  kind: "text" | "number";
}

/** `requirements.md` を読む。無い項目は既定で埋める(生成を止めない) */
export function readSpec(requirements: string): Spec {
  const purpose = sectionBody(requirements, "目的").trim();
  const features = listOf(requirements, "機能要件");
  const screens = listOf(requirements, "画面");
  const fields = readFields(listOf(requirements, "データモデル"));

  return {
    title: purpose === "" ? "業務改善MVP" : firstSentence(purpose),
    purpose: purpose === "" ? "会話から起こした試作品です。" : purpose,
    features: features.length > 0 ? features : ["FR-1 一覧を表示する"],
    fields,
    screens: screens.length > 0 ? screens : ["一覧画面"],
  };
}

/**
 * `- Item: id, name, quantity, unit, updated_at, updated_by` を項目に直す。
 * 読めなければ既定の項目立てにする。
 */
function readFields(lines: string[]): Field[] {
  const fallback: Field[] = [
    { key: "name", label: "名称", kind: "text" },
    { key: "quantity", label: "数量", kind: "number" },
    { key: "unit", label: "単位", kind: "text" },
  ];

  const first = lines[0];
  if (first === undefined) return fallback;

  const columns = (first.includes(":") ? (first.split(":")[1] ?? "") : first)
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "" && !SKIP.has(column));

  const fields = columns.slice(0, 5).map((column) => ({
    key: safeKey(column),
    label: LABELS[column] ?? column,
    kind: NUMERIC.has(column) ? ("number" as const) : ("text" as const),
  }));

  return fields.length > 0 ? fields : fallback;
}

/** 画面に出さない項目。IDと更新情報は自動で付ける */
const SKIP = new Set(["id", "updated_at", "updated_by", "created_at"]);
const NUMERIC = new Set(["quantity", "count", "amount", "price", "stock", "数量", "在庫数"]);
const LABELS: Record<string, string> = {
  name: "名称",
  quantity: "数量",
  unit: "単位",
  note: "備考",
  status: "状態",
  owner: "担当",
  category: "分類",
};

/** 一覧に出す見本データ。実データは入れない(運用ルール) */
export function seedRows(fields: Field[]): Record<string, unknown>[] {
  const samples = ["サンプルA", "サンプルB", "サンプルC"];
  return samples.map((name, index) => {
    const row: Record<string, unknown> = { id: `seed-${index + 1}`, updatedAt: "-" };
    for (const [position, field] of fields.entries()) {
      row[field.key] =
        field.kind === "number" ? (index + 1) * 10 : position === 0 ? name : `${field.label}${index + 1}`;
    }
    return row;
  });
}

// ── Markdownの読み取り ────────────────────────────────

export function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return "";

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("#"));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

export function listOf(markdown: string, heading: string): string[] {
  return sectionBody(markdown, heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^-\s+/, "").trim());
}

function firstSentence(text: string): string {
  const sentence = text.split(/[。\n]/)[0]?.trim() ?? text;
  return sentence.length > 40 ? `${sentence.slice(0, 40)}…` : sentence;
}

/** 識別子として使える形に均す。生成コードの変数名になるため */
export function safeKey(column: string): string {
  const key = column.replace(/[^A-Za-z0-9_]/g, "");
  return key === "" || /^[0-9]/.test(key) ? `f_${Math.abs(hash(column))}` : key;
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.codePointAt(0)!) | 0;
  return value;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * どの雛形でも同じ枠を使う。
 * 中身(`main`)と追加スクリプトだけを雛形ごとに差し替える。
 */
export function page(spec: Spec, body: string): string {
  // 題名は目的の1文目から作る。目的がその1文で終わっていれば同じ文が
  // 2行続くだけになるので、説明行は落とす(顧客の前に出る画面)
  const purposeLine = spec.purpose.trim().startsWith(spec.title.replace(/…$/, ""))
    ? ""
    : `\n      <p class="purpose">${escapeHtml(spec.purpose)}</p>`;

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(spec.title)}</title>
    <link rel="stylesheet" href="./styles.css" />
    <!-- favicon を取りに行かせない。配信していないため404になる -->
    <link rel="icon" href="data:," />
  </head>
  <body>
    <header class="header">
      <h1>${escapeHtml(spec.title)}</h1>${purposeLine}
    </header>

${body}

    <footer class="footer">
      <p>この試作品は商談中に自動生成されたものです。データは画面を閉じると消えます。</p>
    </footer>

    <script src="./app.js"></script>
  </body>
</html>
`;
}
