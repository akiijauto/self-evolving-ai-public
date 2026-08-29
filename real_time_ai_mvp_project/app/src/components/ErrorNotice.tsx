/**
 * 権限拒否・録音失敗の通知。
 *
 * 完了条件「拒否した場合にエラーメッセージが出て、アプリが壊れない」に対応する。
 * 復帰手段を必ず添えること。行き止まりを作らない。
 */
export function ErrorNotice({ message, recoverable }: { message: string; recoverable: boolean }) {
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-message">{message}</p>
      {recoverable && (
        <p className="notice-help">
          許可し直したら、下のボタンからもう一度録音を開始できます。
        </p>
      )}
    </div>
  );
}
