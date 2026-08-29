import { TRIGGER_PHRASES } from "@rt-mvp/protocol";

/**
 * 使い方と合図の言葉。
 *
 * 商談の最中に「なんて言えば拾われるんだったか」を思い出せる場所が
 * 画面に無く、実機の初回テストで営業担当が詰まった。OPERATIONS.md は
 * 商談中に開けない(顧客に画面共有している)ので、画面に置く。
 *
 * 言い回しの一覧は protocol から取る。検出側と同じものを見るため、
 * 「画面に書いてある言葉が拾われない」は起きない。
 */
export function Usage({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  return (
    <details
      className="usage"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="usage-summary">使い方と合図の言葉</summary>

      <ol className="usage-steps">
        <li>相手の同意を得て「録音を開始」。あとは普通に商談する</li>
        <li>
          試作品を作りたくなったら、下の<strong>合図の言葉を一息で</strong>言う。
          拾われないときは<strong>「ここまでの内容で試作品を作る」ボタン</strong>からも作れる
        </li>
        <li>
          聞き取りの誤り(固有名詞など)は、議題・アイデアのタブの
          <strong>「編集」</strong>で直してから作ると、直した内容で生成される
        </li>
        <li>
          確認画面の議事録を相手と眺めて<strong>「作る」</strong>を押す。
          誤って「いいえ」を押したら<strong>3分あけて</strong>言い直す。
          確認が画面から消えたときは、言い直せば戻ってくる
        </li>
        <li>できあがるまで約2分。待ち時間は相手への質問に使う</li>
        <li>
          QRコードは<strong>自分の2台目の端末</strong>で読む。相手にURLは送らない
        </li>
        <li>
          「停止」→ 1分ほどで「サマリ」「アクション」が増える →
          「Markdownをまとめてダウンロード」で持ち帰る
        </li>
      </ol>

      <p className="usage-phrases-title">合図の言葉(どれかが文に入っていれば拾う):</p>
      <ul className="usage-phrases">
        {TRIGGER_PHRASES.map((phrase) => (
          <li key={phrase} className="usage-phrase">
            {phrase}
          </li>
        ))}
      </ul>

      <p className="usage-note">
        実在の顧客名・実際の数値は話さない(仮名・ダミーに置き換える)。
      </p>

      {/* どの版が動いているかを実機で確かめるため。サーバーを更新しても
          端末に古いアプリが残る事故の切り分けに使う */}
      <p className="usage-build">
        版: {new Date(__BUILD_STAMP__).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })}
      </p>
    </details>
  );
}
