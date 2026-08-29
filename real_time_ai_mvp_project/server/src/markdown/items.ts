/**
 * `issues.md` / `ideas.md` の項目形式の読み書きとマージ。
 *
 * DATAFLOW.md の差分処理の規約:
 * 「出力は『新規追加分』と『既存項目への追記』に分けて返させ、Orchestratorがマージする」
 *
 * ここでは分け方を**IDと見出し**で表現する。LLMには同じスキーマで返させ、
 * 既知のIDまたは同じ見出しなら既存項目への追記、それ以外は新規追加として扱う。
 * やり取りは最後までMarkdownのまま(設計原則:「AI同士はMarkdownだけを見る」)。
 */

export interface Item {
  /** `ISS-001` / `IDEA-001` */
  id: string;
  title: string;
  /** `- key: value` の並び。順序を保つ */
  fields: Field[];
}

export interface Field {
  key: string;
  value: string;
}

/** 複数行を持てるキー。それ以外は後から来た値で上書きする */
const REPEATABLE = new Set(["根拠"]);

/**
 * 複数行キーの上限。
 *
 * 30分の通しリハーサルで、同じ話題が繰り返されると1課題あたり33件の根拠が
 * 積み上がった。**課題タブは商談中に顧客へ画面共有する場所**で、根拠の羅列で
 * 埋まると課題そのものが読めない。
 *
 * 残すのは先頭から3件。その課題がどう立ち上がったかが分かればよく、
 * 同じ話題が何度出たかを数える場所ではない(それは transcript.md にある)。
 */
const MAX_REPEATED = 3;

/**
 * `## ID タイトル` + `- key: value` の並びを読む。
 * 解釈できない行は捨てる。LLMの出力を相手にするため、厳密さより頑健さを取る。
 */
export function parseItems(markdown: string): Item[] {
  const items: Item[] = [];
  let current: Item | null = null;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();

    const heading = /^##\s+([A-Z]+-\d+)\s*(.*)$/.exec(line);
    if (heading) {
      current = { id: heading[1] as string, title: (heading[2] ?? "").trim(), fields: [] };
      items.push(current);
      continue;
    }

    if (current === null) continue;

    const field = /^-\s+([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (field) {
      current.fields.push({ key: (field[1] as string).trim(), value: (field[2] as string).trim() });
    }
  }

  return items;
}

export function renderItems(heading: string, items: Item[]): string {
  const parts = [heading, ""];
  for (const item of items) {
    parts.push(`## ${item.id} ${item.title}`.trimEnd());
    for (const field of item.fields) parts.push(`- ${field.key}: ${field.value}`);
    parts.push("");
  }
  return parts.join("\n");
}

/**
 * 既存へ差分をマージする。
 *
 * - 見出しが一致する項目 → 既存項目への追記(新規追加しない)
 * - 見出しが無くIDだけ一致する項目 → 同じくその項目への追記
 * - それ以外 → 採番し直して末尾へ追加
 *
 * **突き合わせは見出しを主にする。** IDだけで見ると、LLMが別の課題に既存のIDを
 * 付け直したときに中身が混ざる。見出しの一致のほうが誤りに気づきやすい。
 * そのため、プロンプト側では「既出の課題は見出しをそのまま使うこと」を指示している。
 *
 * **IDはこちらで採番する。** LLMに任せると、実行のたびに同じ課題へ別のIDが付き、
 * 商談中の画面で番号が入れ替わる。既存の最大値+1を使う。
 */
export function mergeItems(existing: Item[], incoming: Item[], prefix: string): Item[] {
  const merged = existing.map((item) => ({ ...item, fields: [...item.fields] }));
  const byId = new Map(merged.map((item) => [item.id, item]));
  const byTitle = new Map(merged.map((item) => [normalize(item.title), item]));
  let next = maxNumber(merged, prefix) + 1;

  for (const item of incoming) {
    const target =
      item.title === "" ? byId.get(item.id) : byTitle.get(normalize(item.title));

    if (target) {
      mergeFields(target, item.fields);
      continue;
    }

    const added: Item = {
      id: `${prefix}-${String(next).padStart(3, "0")}`,
      title: item.title,
      fields: [...item.fields],
    };
    next += 1;
    merged.push(added);
    byId.set(added.id, added);
    byTitle.set(normalize(added.title), added);
  }

  return merged;
}

function mergeFields(target: Item, incoming: Field[]): void {
  for (const field of incoming) {
    if (REPEATABLE.has(field.key)) {
      const same = target.fields.filter((existing) => existing.key === field.key);

      // 同じ根拠を二度書かない。**時刻を外して比べる** —
      // 同じ発言が別の時刻に再度言及されただけなら、根拠としては同じもの。
      const known = same.some((existing) => withoutTime(existing.value) === withoutTime(field.value));
      if (known || same.length >= MAX_REPEATED) continue;

      target.fields.push(field);
      continue;
    }

    const index = target.fields.findIndex((existing) => existing.key === field.key);
    if (index === -1) target.fields.push(field);
    else target.fields[index] = field;
  }
}

function maxNumber(items: Item[], prefix: string): number {
  let max = 0;
  for (const item of items) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * 先頭の時刻表記を落として比べる。
 *
 * 根拠は `20:21:24 「Excelで管理していて…」` の形で入る。時刻まで含めて比べると、
 * まったく同じ発言でも言及のたびに別物として積み上がる。
 */
function withoutTime(value: string): string {
  return normalize(value.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, ""));
}

/** 表記ゆれを吸収して比べる。空白と記号の違いで二重登録させない */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[。、.,「」"'()（）]/g, "")
    .toLowerCase();
}
