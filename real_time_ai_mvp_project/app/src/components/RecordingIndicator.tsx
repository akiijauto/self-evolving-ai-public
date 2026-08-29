import type { RecorderStatus } from "../recorder/types";
import { formatDuration } from "../format";

/**
 * 録音中であることの常時表示。
 *
 * REQUIREMENTS.md のプライバシー要件:
 * 「PWAは録音中であることを常時明示する」
 * 画面のどこにいても見える位置に固定する。
 */
export function RecordingIndicator({
  status,
  elapsedMs,
}: {
  status: RecorderStatus;
  elapsedMs: number;
}) {
  if (status !== "recording" && status !== "paused") return null;

  const recording = status === "recording";

  return (
    <div
      className={`indicator ${recording ? "indicator-recording" : "indicator-paused"}`}
      role="status"
      aria-live="polite"
    >
      <span className={`dot ${recording ? "dot-pulse" : ""}`} aria-hidden="true" />
      <span className="indicator-label">{recording ? "録音中" : "一時停止中"}</span>
      <span className="indicator-time">{formatDuration(elapsedMs)}</span>
    </div>
  );
}
