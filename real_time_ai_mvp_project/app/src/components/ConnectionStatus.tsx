import type { AudioStats } from "@rt-mvp/protocol";
import type { ConnectionState } from "../gateway/GatewayClient";
import { formatBytes } from "../format";

/**
 * サーバーとの接続状態。
 *
 * Sprint 2 の完了条件「音声チャンクが連続して届く」を
 * 画面上で確認できるようにするため、受信件数も出す。
 */

const LABELS: Record<ConnectionState, string> = {
  idle: "未接続",
  connecting: "接続中…",
  open: "接続済み",
  reconnecting: "再接続中…",
  closed: "切断",
};

export function ConnectionStatus({
  connection,
  sessionId,
  audio,
  bufferedMs,
  droppedChunks,
}: {
  connection: ConnectionState;
  sessionId: string | null;
  audio: AudioStats | null;
  bufferedMs: number;
  droppedChunks: number;
}) {
  if (connection === "idle") return null;

  return (
    // data-session-id は動作確認とサポート問い合わせのために出す。
    // トークンではないため画面に出しても安全。
    <section
      className={`conn conn-${connection}`}
      aria-live="polite"
      data-session-id={sessionId ?? undefined}
    >
      <div className="conn-row">
        <span className={`conn-dot ${connection === "open" ? "conn-dot-ok" : ""}`} aria-hidden="true" />
        <span className="conn-label">{LABELS[connection]}</span>
        {audio && (
          // 画面共有で顧客の目に入る場所なので「チャンク」という語は出さない。
          // 細かい件数は title(ホバー)とdata属性に退避し、疎通確認はそちらで行う
          <span className="conn-stats" title={`${audio.chunks} チャンク受信`}>
            音声 {formatBytes(audio.bytes)} を送信
          </span>
        )}
      </div>

      {bufferedMs > 0 && (
        <p className="conn-note">
          {/* 250ms のチャンク1つでも「0秒」と出ないよう切り上げる */}
          未送信の音声を {Math.ceil(bufferedMs / 1000)} 秒ぶん保持しています。
          接続が戻り次第まとめて送信します。
        </p>
      )}

      {droppedChunks > 0 && (
        <p className="conn-note conn-note-warn">
          切断が60秒を超えたため、古い音声を一部破棄しました。
        </p>
      )}
    </section>
  );
}
