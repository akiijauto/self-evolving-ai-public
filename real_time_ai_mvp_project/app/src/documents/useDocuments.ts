import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDocument } from "../gateway/sessionApi";

/**
 * `document.updated` を受けてMarkdownを取り直す。
 *
 * WebSocketで本文そのものを流さないのは、
 * 切断中の更新を取りこぼさないため。**更新の通知と本文の取得を分ける**と、
 * 再接続後に一覧を引き直すだけで最新に追いつける。
 */

export interface DocumentsState {
  /** ファイル名 → 本文 */
  contents: Record<string, string>;
  /** 取得中のファイル名 */
  loading: string[];
  error: string | null;
}

const EMPTY: DocumentsState = { contents: {}, loading: [], error: null };

/**
 * 未取得の版を順に取りに行く。戻り値は「失敗があったか」。
 *
 * **取れた結果は、途中で中断されても `record` へ渡して捨てない。**
 * 「取得開始 → 描画 → effect作り直しで中断 → 結果を捨てて再取得」を繰り返す
 * 無限ループが実機で起きた。応答が描画サイクルより速いローカルでは成立せず、
 * モバイル回線(往復30〜100ms)で初めて発火し、同じMarkdownへ毎秒20回以上の
 * GETが飛び続けた。中断が止めてよいのは**新しい取得を始めること**だけ。
 */
export async function fetchStale(
  stale: ReadonlyArray<readonly [string, string]>,
  get: (name: string) => Promise<string | null>,
  isCancelled: () => boolean,
  record: (name: string, updatedAt: string, text: string | null) => void,
): Promise<boolean> {
  let failed = false;
  for (const [name, updatedAt] of stale) {
    if (isCancelled()) break;
    try {
      const text = await get(name);
      record(name, updatedAt, text);
    } catch {
      // 記録しない。次の更新通知(または effect の再実行)で取り直す
      failed = true;
    }
  }
  return failed;
}

export interface UseDocumentsResult extends DocumentsState {
  /** 手動編集の保存後に、画面の本文を置き換える(PUTは document.updated を流さない) */
  applyLocalEdit: (name: string, text: string) => void;
}

export function useDocuments(
  sessionId: string | null,
  token: string | null,
  updates: Record<string, string>,
): UseDocumentsResult {
  const [state, setState] = useState<DocumentsState>(EMPTY);
  /** 取得済みの更新時刻。同じ版を何度も取りにいかない */
  const fetchedRef = useRef<Record<string, string>>({});
  /** 直前のセッション。替わったら状態を持ち越さないための目印 */
  const lastSessionRef = useRef<string | null>(null);

  // 呼び出し側が updates を描画のたびに作り直しても effect を走らせ直さない。
  // 参照ではなく中身で比較する(値は「名前 → 更新時刻」だけの浅い辞書)
  const updatesKey = JSON.stringify(updates);
  const stableUpdates = useMemo(() => updates, [updatesKey]);

  useEffect(() => {
    // セッションが**替わったら**(null を経由しない直接の切り替えでも)
    // 前のセッションの取得記録と本文を捨てる。持ち越すと、前の商談の
    // Markdownが次の商談の画面に出たり、古い更新時刻との一致で
    // 「取得済み」と誤認して新しい版を取りにいかなくなったりする
    if (sessionId !== lastSessionRef.current) {
      lastSessionRef.current = sessionId;
      fetchedRef.current = {};
      setState(EMPTY);
    }
    if (sessionId === null || token === null) return;

    const stale = Object.entries(stableUpdates).filter(
      ([name, updatedAt]) => fetchedRef.current[name] !== updatedAt,
    );
    if (stale.length === 0) return;

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: stale.map(([name]) => name) }));

    void fetchStale(
      stale,
      (name) => getDocument(sessionId, token, name),
      () => cancelled,
      (name, updatedAt, text) => {
        // 取れてから記録する。失敗した版は次の更新で取り直す
        fetchedRef.current[name] = updatedAt;
        if (text !== null) {
          setState((prev) => ({ ...prev, contents: { ...prev.contents, [name]: text } }));
        }
      },
    ).then((failed) => {
      if (cancelled) return;
      setState((prev) => ({
        ...prev,
        loading: [],
        // 全部取れたなら過去のエラー表示は消す。出しっぱなしにすると、
        // 一時的な失敗が商談の間ずっと赤いまま残る
        error: failed ? "Markdownを取得できませんでした。" : null,
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, token, stableUpdates]);

  const applyLocalEdit = useCallback((name: string, text: string) => {
    setState((prev) => ({ ...prev, contents: { ...prev.contents, [name]: text } }));
  }, []);

  return { ...state, applyLocalEdit };
}
