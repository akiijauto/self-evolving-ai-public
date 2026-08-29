import { escapeHtml, page, type Spec } from "./spec.js";

/**
 * 申請・承認型。「出す → 待つ → 承認/却下される」の流れを見せる。
 *
 * 一覧型と違い、**状態が動くことが主役**。商談で「今は紙とメールで回している」
 * という話が出たときに、その場で流れを目に見える形にする。
 */
export function renderApproval(spec: Spec): { html: string; js: string } {
  // 申請内容の入力欄。データモデルの項目をそのまま使う
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
      <section class="panel">
        <h2 class="panel-title">申請する</h2>
        <form id="form" class="form">
${inputs}
          <label class="field">
            <span>理由</span>
            <input name="reason" type="text" placeholder="なぜ必要か" required />
          </label>
          <div class="actions">
            <button type="submit" class="primary">申請する</button>
          </div>
        </form>
      </section>

      <div class="tabs" role="tablist">
        <button type="button" class="tab tab-active" data-filter="pending">承認待ち <span class="count" id="count-pending">0</span></button>
        <button type="button" class="tab" data-filter="approved">承認済み <span class="count" id="count-approved">0</span></button>
        <button type="button" class="tab" data-filter="rejected">却下 <span class="count" id="count-rejected">0</span></button>
      </div>

      <ul class="cards" id="cards"></ul>
      <p id="empty" class="empty" hidden>この状態のものはありません。</p>
    </main>`,
  );

  const js = `// 商談中に自動生成された試作品(申請・承認型)。
// 永続化はしない。外部への通信もしない。

const FIELDS = ${JSON.stringify(spec.fields)};

const STATUS_LABEL = { pending: "承認待ち", approved: "承認済み", rejected: "却下" };

/** 画面を閉じるまでの間だけ持つ */
let requests = [
  { id: "seed-1", status: "pending", reason: "見本の申請です", at: "-", values: seedValues(1) },
  { id: "seed-2", status: "approved", reason: "見本の申請です", at: "-", values: seedValues(2) },
];
let filter = "pending";

const cards = document.getElementById("cards");
const empty = document.getElementById("empty");
const form = document.getElementById("form");

function seedValues(n) {
  const values = {};
  for (const [index, field] of FIELDS.entries()) {
    values[field.key] = field.kind === "number" ? n * 10 : index === 0 ? "サンプル" + n : field.label + n;
  }
  return values;
}

function render() {
  for (const status of ["pending", "approved", "rejected"]) {
    document.getElementById("count-" + status).textContent = String(
      requests.filter((request) => request.status === status).length,
    );
  }

  const shown = requests.filter((request) => request.status === filter);
  cards.replaceChildren();

  for (const request of shown) {
    const li = document.createElement("li");
    li.className = "card";

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("strong");
    title.textContent = String(request.values[FIELDS[0].key] ?? "(名称なし)");
    const badge = document.createElement("span");
    badge.className = "badge badge-" + request.status;
    badge.textContent = STATUS_LABEL[request.status];
    head.append(title, badge);
    li.append(head);

    const dl = document.createElement("dl");
    dl.className = "card-fields";
    for (const field of FIELDS.slice(1)) {
      const dt = document.createElement("dt");
      dt.textContent = field.label;
      const dd = document.createElement("dd");
      dd.textContent = String(request.values[field.key] ?? "-");
      dl.append(dt, dd);
    }
    const dt = document.createElement("dt");
    dt.textContent = "理由";
    const dd = document.createElement("dd");
    dd.textContent = request.reason;
    dl.append(dt, dd);
    li.append(dl);

    const meta = document.createElement("p");
    meta.className = "muted";
    meta.textContent = "申請日時: " + request.at;
    li.append(meta);

    if (request.status === "pending") {
      const actions = document.createElement("div");
      actions.className = "actions";

      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "ghost";
      reject.textContent = "却下";
      reject.addEventListener("click", () => decide(request.id, "rejected"));

      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "primary";
      approve.textContent = "承認";
      approve.addEventListener("click", () => decide(request.id, "approved"));

      actions.append(reject, approve);
      li.append(actions);
    }

    cards.append(li);
  }

  empty.hidden = shown.length > 0;
}

function decide(id, status) {
  requests = requests.map((request) => (request.id === id ? { ...request, status } : request));
  render();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const values = {};
  for (const field of FIELDS) {
    const raw = form.elements[field.key].value;
    values[field.key] = field.kind === "number" ? Number(raw) : raw;
  }

  requests = [
    {
      id: crypto.randomUUID(),
      status: "pending",
      reason: form.elements.reason.value,
      at: new Date().toLocaleString("ja-JP"),
      values,
    },
    ...requests,
  ];
  form.reset();
  // 出した申請がすぐ見えるように、承認待ちへ切り替える
  setFilter("pending");
});

function setFilter(next) {
  filter = next;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("tab-active", tab.dataset.filter === next);
  }
  render();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => setFilter(tab.dataset.filter));
}
render();
`;

  return { html, js };
}
