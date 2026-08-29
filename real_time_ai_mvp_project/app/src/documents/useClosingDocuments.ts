import { useEffect, useRef, useState } from "react";
import { listDocuments } from "../gateway/sessionApi";

/** 何秒おきに一覧を取り直すか */
const INTERVAL_MS = 3_000;
/** いつまで待つか。商談後のsummary/todo生成はLLM次第で数十秒かかる */
const DEADLINE_MS = 120_000;

/**
 * 商談が終わったあとのMarkdownを拾う。
 *
 * `document.updated` は WebSocket で届くが、**停止すると同時にソケットは閉じる。**
 * 一方 summary.md と todo.md はその後にLLMが書き上げるので、通知は誰にも届かない。
 * 通知が来ないなら取りに行くしかない。終了済みセッションでもMarkdownは読めるので
 * (Sprint 4 の方針)、一覧を定期的に引いて更新時刻を返す。
 *
 * 返り値は `document.updated` と同じ「名前 → 更新時刻」の形。
 * 呼び出し側で通知ぶんと混ぜて `useDocuments` へ渡す。
 */
export function useClosingDocuments(
  sessionId: string | null,
  token: string | null,
  active: boolean,
): Record<string, string> {
  const [updates, setUpdates] = useState<Record<string, string>>({});
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || sessionId === null || token === null) {
      startedAtRef.current = null;
      // **前のセッションの更新時刻を持ち越さない。**
      // 残したまま次の商談を始めると、App側の合成(閉会分が後勝ち)で
      // 新しいセッションの document.updated を覆い隠し、商談中の議事録が
      // 一切取得されなくなる(実機で発生: セッション開始直後に前セッションの
      // 8ファイルを新セッションへ取りにいって全部404、以後は沈黙)。
      // 中身が既に空なら参照も変えない(無駄な再描画を誘発しない)
      setUpdates((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    startedAtRef.current = Date.now();
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const { documents } = await listDocuments(sessionId, token);
        if (cancelled) return;
        setUpdates((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const doc of documents) {
            if (next[doc.name] !== doc.updatedAt) {
              next[doc.name] = doc.updatedAt;
              changed = true;
            }
          }
          // 中身が同じなら参照も変えない。無駄な再取得を誘発しないため
          return changed ? next : prev;
        });
      } catch {
        // 取れなくても商談は終わっている。次の周期で取り直す
      }
    };

    void poll();
    const timer = setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null && Date.now() - startedAt > DEADLINE_MS) {
        clearInterval(timer);
        return;
      }
      void poll();
    }, INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, sessionId, token]);

  return updates;
}
