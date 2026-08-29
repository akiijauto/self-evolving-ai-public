import { useEffect, useState } from "react";
import { labelOf, sortForDisplay } from "../documents/markdown";
import type { UseDocumentsResult } from "../documents/useDocuments";
import { putDocument } from "../gateway/sessionApi";
import { MarkdownView } from "./MarkdownView";

/**
 * 商談中に積み上がるMarkdownの表示と訂正。
 *
 * **顧客の目の前に出る画面**なので、更新が一目で分かることを優先する。
 * 新しく増えたタブには印を付け、開いたら消す。
 *
 * 編集を付けたのは、文字起こしの誤認識が議題や要件へ流れ込むため
 * (実機で「じゃんけんであいこ」が「アイコン」と書き起こされた)。
 * 直した内容は以後の生成にそのまま使われる。
 */

/**
 * 編集できないファイル。
 * `transcript.md` は追記専用(DATAFLOW.md)のため、全文置換のPUTが通らない。
 */
const READONLY = new Set(["transcript.md"]);

export function Documents({
  state,
  updates,
  degraded,
  sessionId,
  token,
}: {
  state: UseDocumentsResult;
  /** ファイル名 → 更新時刻 */
  updates: Record<string, string>;
  /** AIが停止しているか。文字起こしは続いている */
  degraded: boolean;
  sessionId: string | null;
  token: string | null;
}) {
  const names = sortForDisplay(Object.keys(updates));
  const [active, setActive] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>({});
  /** 編集中の本文。null なら閲覧モード */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 最初に届いたものを開く。以降は利用者の選択を尊重する
  useEffect(() => {
    setActive((prev) => (prev !== null && names.includes(prev) ? prev : (names[0] ?? null)));
  }, [names]);

  // 開いているタブは「見た」ことにする
  useEffect(() => {
    if (active === null) return;
    const updatedAt = updates[active];
    if (updatedAt === undefined) return;
    setSeen((prev) => (prev[active] === updatedAt ? prev : { ...prev, [active]: updatedAt }));
  }, [active, updates]);

  // タブを移ったら編集は破棄する(誤って別のファイルへ保存しない)
  useEffect(() => {
    setDraft(null);
    setSaveError(null);
  }, [active]);

  if (names.length === 0) {
    return (
      <section className="documents documents-empty">
        <p className="documents-placeholder">
          {degraded
            ? "AIが停止しています。文字起こしは続いています。"
            : "会話が進むと、課題や要件がここに整理されます。"}
        </p>
      </section>
    );
  }

  const body = active === null ? undefined : state.contents[active];
  const canEdit =
    body !== undefined &&
    sessionId !== null &&
    token !== null &&
    active !== null &&
    !READONLY.has(active);

  const save = (): void => {
    if (active === null || draft === null || sessionId === null || token === null) return;
    setSaving(true);
    setSaveError(null);
    putDocument(sessionId, token, active, draft)
      .then(() => {
        state.applyLocalEdit(active, draft);
        setDraft(null);
      })
      .catch(() => {
        // 下書きは残す。書いた訂正を通信の失敗で失わせない
        setSaveError("保存できませんでした。通信を確認してもう一度。");
      })
      .finally(() => setSaving(false));
  };

  return (
    <section className="documents">
      <nav className="documents-tabs" aria-label="生成されたドキュメント">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            className={`documents-tab${name === active ? " documents-tab-active" : ""}`}
            aria-current={name === active}
            onClick={() => setActive(name)}
          >
            {labelOf(name)}
            {seen[name] !== updates[name] && <span className="documents-dot" aria-label="更新あり" />}
          </button>
        ))}
      </nav>

      <div className="documents-body">
        {body === undefined ? (
          <p className="documents-placeholder">読み込んでいます…</p>
        ) : draft !== null ? (
          <div className="documents-editor">
            <textarea
              className="documents-textarea"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={12}
              aria-label={`${labelOf(active ?? "")} の編集`}
            />
            <div className="documents-editor-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDraft(null);
                  setSaveError(null);
                }}
                disabled={saving}
              >
                取消
              </button>
            </div>
            <p className="documents-editor-note">
              保存した内容は、以後の生成にそのまま使われます(聞き取りの誤りはここで直せます)。
            </p>
            {saveError !== null && <p className="documents-note">{saveError}</p>}
          </div>
        ) : (
          <>
            <MarkdownView source={body} />
            {canEdit && (
              <button
                type="button"
                className="documents-edit"
                onClick={() => setDraft(body)}
              >
                編集
              </button>
            )}
          </>
        )}
      </div>

      {degraded && (
        <p className="documents-note">AIが停止しています。文字起こしは続いています。</p>
      )}
      {state.error !== null && <p className="documents-note">{state.error}</p>}
    </section>
  );
}
