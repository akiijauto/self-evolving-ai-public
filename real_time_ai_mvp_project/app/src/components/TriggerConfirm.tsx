import { MarkdownView } from "./MarkdownView";

/**
 * トリガー検出の確認。
 *
 * RETROSPECTIVE.md「誤トリガーは明示承認で防ぐ」:
 * **タップされるまで生成は始まらない。** 自動承認のカウントダウンは置かない。
 * 雑談で「アプリ作って」と言われただけで画面が生成モードへ切り替わると、
 * 商談そのものを壊す。
 *
 * 判断の材料として、この時点までの議事録(summary.md)を一緒に出す。
 * 検出フレーズだけでは「何が作られるのか」を判断できない。
 */
export function TriggerConfirm({
  phrase,
  summary,
  degraded,
  onApprove,
  onCancel,
}: {
  phrase: string;
  /** この時点までの議事録。まだ生成中なら null */
  summary: string | null;
  /** AIが停止しているか。停止中は議事録が永久に届かない */
  degraded: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="trigger" role="alertdialog" aria-labelledby="trigger-title">
      <h2 id="trigger-title" className="trigger-title">
        いま話した内容で試作品を作りますか
      </h2>
      <p className="trigger-phrase">検出した言葉: 「{phrase}」</p>

      <div className="trigger-summary" aria-label="ここまでの議事録">
        <p className="trigger-summary-title">ここまでの議事録</p>
        {summary !== null ? (
          <MarkdownView source={summary} />
        ) : degraded ? (
          // AIが止まっている間「準備しています…」を出し続けると、営業担当は
          // 届かない議事録を待ってしまう。待っても来ないことをその場で伝える
          <p className="documents-placeholder">
            AIが停止しているため、議事録を用意できませんでした。
            <br />
            会話の内容から判断してください。
          </p>
        ) : (
          <p className="documents-placeholder">議事録を準備しています…</p>
        )}
      </div>

      <p className="trigger-note">
        承認すると、この内容から要件をまとめてアプリを生成します。
        <br />
        録音と文字起こしはそのまま続きます。
      </p>

      <div className="trigger-actions">
        <button type="button" className="btn" onClick={onCancel}>
          いいえ
        </button>
        <button type="button" className="btn btn-primary" onClick={onApprove} autoFocus>
          作る
        </button>
      </div>
    </section>
  );
}
