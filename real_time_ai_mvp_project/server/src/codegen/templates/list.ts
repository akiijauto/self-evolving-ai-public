import { escapeHtml, page, seedRows, type Spec } from "./spec.js";

/**
 * 一覧・管理型。台帳やマスタの「一覧 + 絞り込み + 追加・編集」。
 * 形が決まらなかったときの既定でもある。
 */
export function renderList(spec: Spec): { html: string; js: string } {
  const headers = spec.fields
    .map((field) => `          <th>${escapeHtml(field.label)}</th>`)
    .join("\n");
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
      <div class="toolbar">
        <input id="search" type="search" placeholder="名称で絞り込む" aria-label="名称で絞り込む" />
        <button id="add" type="button" class="primary">追加</button>
      </div>

      <table class="table">
        <thead>
          <tr>
${headers}
            <th>最終更新</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>

      <p id="empty" class="empty" hidden>該当するものがありません。</p>
    </main>

    <dialog id="editor" class="editor">
      <form method="dialog" id="form">
        <h2 id="editor-title">更新</h2>
${inputs}
        <div class="actions">
          <button value="cancel" type="submit" class="ghost">キャンセル</button>
          <button value="save" type="submit" class="primary">保存</button>
        </div>
      </form>
    </dialog>`,
  );

  const js = `// 商談中に自動生成された試作品(一覧・管理型)。
// 永続化はしない(ai_instruction.md: インメモリのモックデータ)。外部への通信もしない。

const FIELDS = ${JSON.stringify(spec.fields)};

/** 画面を閉じるまでの間だけ持つ。サーバーへは何も送らない */
let items = ${JSON.stringify(seedRows(spec.fields))};
let editingId = null;

const rows = document.getElementById("rows");
const empty = document.getElementById("empty");
const search = document.getElementById("search");
const editor = document.getElementById("editor");
const form = document.getElementById("form");
const editorTitle = document.getElementById("editor-title");

function render() {
  const keyword = search.value.trim().toLowerCase();
  const shown = items.filter((item) =>
    keyword === "" ? true : String(item[FIELDS[0].key] ?? "").toLowerCase().includes(keyword),
  );

  rows.replaceChildren();
  for (const item of shown) {
    const tr = document.createElement("tr");
    for (const field of FIELDS) {
      const td = document.createElement("td");
      td.textContent = String(item[field.key] ?? "");
      tr.append(td);
    }

    const updated = document.createElement("td");
    updated.className = "muted";
    updated.textContent = item.updatedAt ?? "-";
    tr.append(updated);

    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "編集";
    button.addEventListener("click", () => openEditor(item.id));
    action.append(button);
    tr.append(action);

    rows.append(tr);
  }

  empty.hidden = shown.length > 0;
}

function openEditor(id) {
  editingId = id;
  const item = items.find((candidate) => candidate.id === id);
  editorTitle.textContent = item ? "更新" : "追加";

  for (const field of FIELDS) {
    form.elements[field.key].value = item ? (item[field.key] ?? "") : "";
  }
  editor.showModal();
}

form.addEventListener("submit", (event) => {
  if (event.submitter && event.submitter.value === "cancel") return;
  if (!form.reportValidity()) {
    event.preventDefault();
    return;
  }

  const values = {};
  for (const field of FIELDS) {
    const raw = form.elements[field.key].value;
    values[field.key] = field.kind === "number" ? Number(raw) : raw;
  }
  values.updatedAt = new Date().toLocaleString("ja-JP");

  if (editingId === null) {
    items = [...items, { id: crypto.randomUUID(), ...values }];
  } else {
    items = items.map((item) => (item.id === editingId ? { ...item, ...values } : item));
  }
  editingId = null;
  render();
});

document.getElementById("add").addEventListener("click", () => openEditor(null));
search.addEventListener("input", render);
render();
`;

  return { html, js };
}
