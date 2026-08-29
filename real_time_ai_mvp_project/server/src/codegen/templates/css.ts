/**
 * 生成物の見た目。どの雛形でも同じものを配る。
 *
 * Webフォントも外部のCSSも読まない(validate.ts が外部参照を止める)。
 * 顧客の端末で開かれるため、明暗どちらの設定でも読めるようにする。
 */
export function renderCss(): string {
  return `:root {
  color-scheme: light dark;
  --line: #d4d4d8;
  --muted: #71717a;
  --accent: #2563eb;
  --ok: #16a34a;
  --warn: #ca8a04;
  --ng: #dc2626;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  line-height: 1.6;
}

.header { padding: 1.5rem 1.25rem 0.75rem; }
.header h1 { margin: 0 0 0.25rem; font-size: 1.35rem; }
.purpose { margin: 0; color: var(--muted); font-size: 0.9rem; }

.main { padding: 0 1.25rem 2rem; display: flex; flex-direction: column; gap: 1.25rem; }

.toolbar { display: flex; gap: 0.5rem; margin: 1rem 0 0; }
.toolbar input { flex: 1; }

input {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  font: inherit;
  background: none;
  color: inherit;
}

button {
  padding: 0.5rem 0.9rem;
  border-radius: 8px;
  border: 1px solid var(--line);
  font: inherit;
  cursor: pointer;
  background: none;
  color: inherit;
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.ghost { background: none; }

.muted { color: var(--muted); }
.empty { color: var(--muted); font-size: 0.9rem; }
.actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }

.panel { border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.15rem; }
.panel-title { margin: 0 0 0.75rem; font-size: 1rem; }

.form { display: flex; flex-direction: column; }
.field { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.75rem; }
.field span { font-size: 0.85rem; color: var(--muted); }

/* ── 一覧・管理型 ─────────────────────────── */

.table { width: 100%; border-collapse: collapse; }
.table th, .table td {
  padding: 0.55rem 0.5rem;
  border-bottom: 1px solid var(--line);
  text-align: left;
  font-size: 0.9rem;
}
.table th { color: var(--muted); font-weight: 600; }

.editor {
  border: none;
  border-radius: 12px;
  padding: 1.25rem;
  min-width: min(22rem, 90vw);
}
.editor h2 { margin: 0 0 0.75rem; font-size: 1.05rem; }

/* ── 申請・承認型 ─────────────────────────── */

.tabs { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.tab {
  border-radius: 999px;
  font-size: 0.9rem;
  color: var(--muted);
}
.tab-active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.count {
  display: inline-block;
  min-width: 1.4rem;
  margin-left: 0.25rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: var(--line);
  color: inherit;
  font-size: 0.8rem;
  text-align: center;
}

.cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.card { border: 1px solid var(--line); border-radius: 12px; padding: 0.9rem 1rem; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.card-fields { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin: 0.6rem 0; }
.card-fields dt { color: var(--muted); font-size: 0.85rem; }
.card-fields dd { margin: 0; font-size: 0.9rem; }

.badge {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid currentColor;
}
.badge-pending { color: var(--warn); }
.badge-approved { color: var(--ok); }
.badge-rejected { color: var(--ng); }

/* ── 点検・チェック型 ─────────────────────── */

.progress-head { display: flex; align-items: baseline; justify-content: space-between; }
.progress-count { font-variant-numeric: tabular-nums; font-weight: 600; }
.progress {
  height: 0.5rem;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
  margin: 0.5rem 0;
}
.progress-bar { height: 100%; width: 0%; background: var(--ok); transition: width 0.2s ease; }

.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.check {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 0.6rem 0.8rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.check-row { display: flex; align-items: center; gap: 0.6rem; cursor: pointer; flex: 1; }
.check-done .check-label { text-decoration: line-through; color: var(--muted); }
.check-at { font-size: 0.8rem; white-space: nowrap; }

.notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.note {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.9rem;
  padding: 0.4rem 0.2rem;
  border-bottom: 1px solid var(--line);
}

/* ── 集計・可視化型 ───────────────────────── */

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: 0.75rem; }
.stat { border: 1px solid var(--line); border-radius: 12px; padding: 0.8rem 1rem; }
.stat-label { display: block; color: var(--muted); font-size: 0.8rem; }
.stat-value { font-size: 1.6rem; font-variant-numeric: tabular-nums; }

.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.bar-row { display: grid; grid-template-columns: minmax(4rem, 8rem) 1fr auto; align-items: center; gap: 0.6rem; }
.bar-label { font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 0.75rem; border-radius: 999px; background: var(--line); overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--accent); }
.bar-value { font-variant-numeric: tabular-nums; font-size: 0.9rem; }

.footer { padding: 0 1.25rem 2rem; color: var(--muted); font-size: 0.8rem; }
`;
}
