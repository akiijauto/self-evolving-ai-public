import type { Clip } from "../recorder/types";
import { formatBytes, formatDuration } from "../format";

/**
 * 録音結果のローカル再生。
 *
 * 完了条件「録音した音声をその場で再生できる」に対応する。
 * Sprint 1 では音声が取れていることの目視確認が目的であり、
 * サーバーへは一切送らない。
 */
export function ClipPlayer({ clip, onDiscard }: { clip: Clip | null; onDiscard: () => void }) {
  if (!clip) {
    return (
      <div className="notice" role="status">
        <p>音声を書き出しています…</p>
      </div>
    );
  }

  return (
    <section className="clip">
      <h2 className="clip-title">録音結果</h2>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- 本人の録音であり字幕は不要 */}
      <audio className="clip-audio" src={clip.url} controls preload="metadata" />

      <dl className="clip-meta">
        <div>
          <dt>長さ</dt>
          <dd>{formatDuration(clip.durationMs)}</dd>
        </div>
        <div>
          <dt>サイズ</dt>
          <dd>{formatBytes(clip.sizeBytes)}</dd>
        </div>
        <div>
          <dt>形式</dt>
          <dd className="clip-mime">{clip.mimeType}</dd>
        </div>
      </dl>

      <button className="btn btn-quiet" onClick={onDiscard}>
        破棄する
      </button>
    </section>
  );
}
