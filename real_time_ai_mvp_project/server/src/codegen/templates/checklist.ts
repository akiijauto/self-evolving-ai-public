import { page, type Spec } from "./spec.js";

/**
 * 点検・チェック型。「決まった項目を上から消していく」形。
 *
 * 機能要件をそのまま点検項目に使う。**会話に出た困りごとが
 * そのままチェック項目として並ぶ**ため、その場で作られたことが伝わりやすい。
 */
export function renderChecklist(spec: Spec): { html: string; js: string } {
  // 機能要件を点検項目にする。要件番号(FR-1 など)は画面には出さない
  const items = spec.features
    .map((feature) => feature.replace(/^(FR|NFR)-\d+\s*/, "").trim())
    .filter((feature) => feature !== "")
    .slice(0, 12);

  const list = items.length > 0 ? items : ["確認項目1", "確認項目2", "確認項目3"];

  const html = page(
    spec,
    `    <main class="main">
      <section class="panel">
        <div class="progress-head">
          <h2 class="panel-title">本日の点検</h2>
          <span class="progress-count"><span id="done">0</span> / <span id="total">0</span></span>
        </div>
        <div class="progress" role="progressbar" aria-labelledby="progress-label">
          <div class="progress-bar" id="bar"></div>
        </div>
        <p id="progress-label" class="muted" aria-live="polite">未実施の項目があります。</p>
      </section>

      <ul class="checks" id="checks"></ul>

      <div class="toolbar">
        <input id="note" type="text" placeholder="気づいたことを記録" aria-label="気づいたことを記録" />
        <button id="add-note" type="button" class="primary">記録</button>
      </div>

      <ul class="notes" id="notes"></ul>

      <div class="actions">
        <button id="reset" type="button" class="ghost">最初からやり直す</button>
      </div>
    </main>`,
  );

  const js = `// 商談中に自動生成された試作品(点検・チェック型)。
// 永続化はしない。外部への通信もしない。

/** 点検項目。会話から起こした機能要件をそのまま並べている */
let checks = ${JSON.stringify(list)}.map((label, index) => ({
  id: "check-" + index,
  label,
  done: false,
  at: null,
}));

let notes = [];

const checksEl = document.getElementById("checks");
const notesEl = document.getElementById("notes");
const bar = document.getElementById("bar");
const doneEl = document.getElementById("done");
const totalEl = document.getElementById("total");
const label = document.getElementById("progress-label");
const noteInput = document.getElementById("note");

function render() {
  checksEl.replaceChildren();
  for (const check of checks) {
    const li = document.createElement("li");
    li.className = "check" + (check.done ? " check-done" : "");

    const row = document.createElement("label");
    row.className = "check-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = check.done;
    box.addEventListener("change", () => toggle(check.id));

    const text = document.createElement("span");
    text.className = "check-label";
    text.textContent = check.label;

    row.append(box, text);
    li.append(row);

    if (check.at !== null) {
      const at = document.createElement("span");
      at.className = "muted check-at";
      at.textContent = check.at;
      li.append(at);
    }

    checksEl.append(li);
  }

  const done = checks.filter((check) => check.done).length;
  doneEl.textContent = String(done);
  totalEl.textContent = String(checks.length);
  bar.style.width = checks.length === 0 ? "0%" : Math.round((done / checks.length) * 100) + "%";
  label.textContent =
    done === checks.length && checks.length > 0
      ? "すべて実施しました。"
      : "残り " + (checks.length - done) + " 件です。";

  notesEl.replaceChildren();
  for (const note of notes) {
    const li = document.createElement("li");
    li.className = "note";
    const body = document.createElement("span");
    body.textContent = note.text;
    const at = document.createElement("span");
    at.className = "muted";
    at.textContent = note.at;
    li.append(body, at);
    notesEl.append(li);
  }
}

function toggle(id) {
  checks = checks.map((check) =>
    check.id === id
      ? { ...check, done: !check.done, at: check.done ? null : new Date().toLocaleString("ja-JP") }
      : check,
  );
  render();
}

document.getElementById("add-note").addEventListener("click", () => {
  const text = noteInput.value.trim();
  if (text === "") return;
  notes = [{ text, at: new Date().toLocaleString("ja-JP") }, ...notes];
  noteInput.value = "";
  render();
});

document.getElementById("reset").addEventListener("click", () => {
  checks = checks.map((check) => ({ ...check, done: false, at: null }));
  render();
});

render();
`;

  return { html, js };
}
