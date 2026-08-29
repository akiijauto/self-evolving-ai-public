import { escapeHtml, page, seedRows, type Field, type Spec } from "./spec.js";

/**
 * 集計・可視化型。「今どうなっているかが数字で見える」形。
 *
 * 「数字が把握できていない」という話が出たときに使う。
 * グラフは**CSSの棒だけ**で描く。外部のグラフ描画ライブラリを読むと
 * 生成物の「外部参照禁止」に触れ、validate.ts で止まる。
 */
/**
 * 集計軸を選ぶ。
 *
 * **「名称」を軸にすると内訳にならない。** 品名や氏名はほぼ一意なので、
 * 1件ずつの棒が並ぶだけで「どこが多いのか」が見えない。
 * 分類・部門・状態のような**まとまる項目**を先に探す。
 */
function pickGroupField(spec: Spec): Field | null {
  const grouping = ["category", "status", "owner", "分類", "部門", "状態", "担当", "種別"];

  const named = spec.fields.find(
    (field) => field.kind === "text" && grouping.some((hint) => field.key === hint || field.label === hint),
  );
  if (named) return named;

  // 見つからなければ、先頭以外の文字項目(先頭は名称であることが多い)
  const later = spec.fields.slice(1).find((field) => field.kind === "text");
  return later ?? spec.fields.find((field) => field.kind === "text") ?? spec.fields[0] ?? null;
}

export function renderDashboard(spec: Spec): { html: string; js: string } {
  const numberField = spec.fields.find((field) => field.kind === "number") ?? null;
  const groupField = pickGroupField(spec);

  const inputs = spec.fields
    .map(
      (field) => `        <label class="field">
          <span>${escapeHtml(field.label)}</span>
          <input name="${field.key}" type="${field.kind}" ${field.kind === "number" ? 'min="0" ' : ""}required />
        </label>`,
    )
    .join("\n");

  const html = page(
    spec,
    `    <main class="main">
      <section class="stats">
        <div class="stat">
          <span class="stat-label">件数</span>
          <strong class="stat-value" id="stat-count">0</strong>
        </div>
        <div class="stat">
          <span class="stat-label">${escapeHtml(numberField?.label ?? "数量")}の合計</span>
          <strong class="stat-value" id="stat-sum">0</strong>
        </div>
        <div class="stat">
          <span class="stat-label">平均</span>
          <strong class="stat-value" id="stat-avg">0</strong>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel-title">${escapeHtml(groupField?.label ?? "分類")}ごとの内訳</h2>
        <ul class="bars" id="bars"></ul>
        <p id="empty" class="empty" hidden>まだデータがありません。</p>
      </section>

      <section class="panel">
        <h2 class="panel-title">データを足す</h2>
        <form id="form" class="form">
${inputs}
          <div class="actions">
            <button type="submit" class="primary">追加する</button>
          </div>
        </form>
      </section>
    </main>`,
  );

  const js = `// 商談中に自動生成された試作品(集計・可視化型)。
// 永続化はしない。外部への通信もしない。グラフは外部ライブラリを使わず、
// 幅を変えた div で描いている。

const FIELDS = ${JSON.stringify(spec.fields)};
const NUMBER_KEY = ${JSON.stringify(numberField?.key ?? null)};
const GROUP_KEY = ${JSON.stringify(groupField?.key ?? null)};

let items = ${JSON.stringify(seedRows(spec.fields))};

const bars = document.getElementById("bars");
const empty = document.getElementById("empty");
const form = document.getElementById("form");

function numberOf(item) {
  if (NUMBER_KEY === null) return 1;
  const value = Number(item[NUMBER_KEY]);
  return Number.isFinite(value) ? value : 0;
}

function render() {
  const count = items.length;
  const sum = items.reduce((total, item) => total + numberOf(item), 0);

  document.getElementById("stat-count").textContent = String(count);
  document.getElementById("stat-sum").textContent = String(Math.round(sum * 10) / 10);
  document.getElementById("stat-avg").textContent =
    count === 0 ? "0" : String(Math.round((sum / count) * 10) / 10);

  // 分類ごとに合算する
  const groups = new Map();
  for (const item of items) {
    const key = GROUP_KEY === null ? "全体" : String(item[GROUP_KEY] ?? "(未設定)");
    groups.set(key, (groups.get(key) ?? 0) + numberOf(item));
  }

  const entries = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const max = entries.reduce((peak, entry) => Math.max(peak, entry[1]), 0);

  bars.replaceChildren();
  for (const [key, value] of entries) {
    const li = document.createElement("li");
    li.className = "bar-row";

    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = key;

    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.width = max === 0 ? "0%" : Math.round((value / max) * 100) + "%";
    track.append(fill);

    const amount = document.createElement("span");
    amount.className = "bar-value";
    amount.textContent = String(Math.round(value * 10) / 10);

    li.append(label, track, amount);
    bars.append(li);
  }

  empty.hidden = entries.length > 0;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const row = { id: crypto.randomUUID(), updatedAt: new Date().toLocaleString("ja-JP") };
  for (const field of FIELDS) {
    const raw = form.elements[field.key].value;
    row[field.key] = field.kind === "number" ? Number(raw) : raw;
  }
  items = [...items, row];
  form.reset();
  render();
});

render();
`;

  return { html, js };
}
