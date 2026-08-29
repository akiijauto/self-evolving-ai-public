import { useState } from "react";
import { ApiError, startGeneration } from "../gateway/sessionApi";

/**
 * 生成を手動で始めるボタン。
 *
 * 合図の言葉が拾われない場面の逃げ道。実機では「アプリ作って」と言っても
 * 認識誤りで文字にならず、生成へ進めない商談があった。音声だけに頼ると
 * その場で打つ手が無くなる。
 *
 * タップそのものが明示承認にあたる(RETROSPECTIVE.md「誤トリガーは明示承認で防ぐ」)。
 * 進捗は WebSocket の job.progress で流れてくるため、ここでは開始だけを頼む。
 */
export function ManualGenerate({ sessionId, token }: { sessionId: string; token: string }) {
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = (): void => {
    setRequesting(true);
    setError(null);
    startGeneration(sessionId, token)
      .then(() => {
        // 成功すれば job.progress が届き、親がこのボタンを引っ込める
      })
      .catch((cause: unknown) => {
        setRequesting(false);
        setError(
          cause instanceof ApiError ? cause.message : "開始できませんでした。もう一度お試しください。",
        );
      });
  };

  return (
    <div className="manual-generate">
      <button type="button" className="btn" onClick={begin} disabled={requesting}>
        {requesting ? "開始しています…" : "ここまでの内容で試作品を作る"}
      </button>
      <p className="manual-generate-hint">
        合図の言葉が拾われないときは、ここから作れます。
      </p>
      {error !== null && <p className="documents-note">{error}</p>}
    </div>
  );
}
