import { useEffect, useRef } from "react";
import { toDisplayLines, type TranscriptState } from "../transcript/merge";

/**
 * リアルタイム文字起こしの表示。
 *
 * 商談中に画面共有される前提で作る。顧客が読んで違和感のない見た目にすること。
 * 未確定(partial)は薄字にして、確定していないことが一目で分かるようにする。
 */
export function Transcript({
  state,
  degraded,
}: {
  state: TranscriptState;
  degraded: boolean;
}) {
  const lines = toDisplayLines(state);
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 新しい行が出たら末尾へ送る。ただし利用者が上へスクロールして
  // 読み返している最中は邪魔しない。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom > 120) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, state.partial?.text]);

  if (lines.length === 0) {
    return (
      <section className="transcript transcript-empty">
        <p className="transcript-placeholder">
          {degraded
            ? "音声認識が停止しています。録音は続いています。"
            : "話し始めると、ここに文字起こしが表示されます。"}
        </p>
      </section>
    );
  }

  return (
    <section className="transcript" aria-label="文字起こし">
      <div className="transcript-body" ref={containerRef}>
        {lines.map((line) => (
          <p
            key={line.key}
            className={`transcript-line ${line.confirmed ? "" : "transcript-line-partial"}`}
          >
            {line.speaker !== null && <span className="transcript-speaker">{line.speaker}</span>}
            <span className="transcript-text">{line.text}</span>
          </p>
        ))}
        <div ref={endRef} />
      </div>

      {degraded && (
        <p className="transcript-note">
          音声認識が停止しました。ここから先は文字起こしされません。
        </p>
      )}
    </section>
  );
}
