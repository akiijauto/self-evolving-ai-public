/**
 * 商談の記録を持ち帰る。
 *
 * **試作品を作ったかどうかに関わらず出す。** 以前はここが生成結果(Artifact)の中に
 * あったため、トリガーが出なかった商談・生成を断った商談では
 * ボタンごと画面に現れず、議事録を回収する手段が無かった。
 * 議事録は毎回持ち帰るものなので、毎回そこにある必要がある。
 */
export function SessionExport({
  ended,
  onExport,
}: {
  /** 商談が終わっているか。終了後は文言を変える */
  ended: boolean;
  onExport: (() => void) | null;
}) {
  if (onExport === null) return null;

  return (
    <p className="session-export">
      <button type="button" className="artifact-export" onClick={onExport}>
        Markdownをまとめてダウンロード
      </button>
      {ended && <span className="session-export-hint">この商談の記録はここから持ち帰れます。</span>}
    </p>
  );
}
