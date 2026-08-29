import { TRIGGER_PHRASES } from "@rt-mvp/protocol";

/**
 * トリガーキーワードの検出。
 *
 * PROJECT.md の「話しているだけで試作品が完成する」体験の入口。
 * ただし**検出しただけでは何も始めない。** 営業担当がタップして承認するまで待つ
 * (RETROSPECTIVE.md「誤トリガーは明示承認で防ぐ」)。
 *
 * そのため、ここは**拾いすぎるくらいで構わない。** 取りこぼすと体験が成立しないが、
 * 拾いすぎても確認UIが1つ出るだけで、商談は止まらない。
 *
 * 言い回しの一覧は protocol にある。画面の「使い方」と同じものを見るため
 * (二重管理にすると「画面に書いてある言葉が拾われない」が起きる)。
 */
/**
 * 検出したフレーズを返す。見つからなければ null。
 *
 * 戻すのは**元の発話から切り出した文字列**ではなく、
 * 一致した言い回しそのもの。確認UIに何が引っかかったかを出すために使う。
 *
 * 文字起こしの表記ゆれ(漢字/ひらがな、助詞の有無)を吸収するため、
 * 正規化した文字列に対する部分一致で見る。
 */
export function detectTrigger(text: string): string | null {
  const normalized = normalize(text);
  for (const phrase of TRIGGER_PHRASES) {
    if (normalized.includes(normalize(phrase))) return phrase;
  }
  return null;
}

/**
 * 比較用に均す。
 *
 * 空白と句読点、「を」「で」といった助詞の有無で外さないようにする。
 * 「この内容でアプリを作って」も「アプリ作って」として拾う。
 * カタカナはひらがなへ寄せる。文字起こしが「ツクッテ」と出しても外さない。
 */
function normalize(text: string): string {
  return (
    text
      .replace(/\s+/g, "")
      .replace(/[。、,.!?！？「」『』()（）]/g, "")
      // 助詞の除去はカナ変換より先。後にすると「デモ」→「でも」が助詞として
      // 消え、「デモ作って」が「作って」だけになり何でも拾ってしまう
      .replace(/[をがはにへとでも]/g, "")
      .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
  );
}

export { TRIGGER_PHRASES };

/**
 * 直近の確定文をつないで検出する。
 *
 * 文字起こしは「この内容でアプリを」「作ってみましょう」のように
 * 文の途中で確定が割れることがあり、単文の部分一致では取りこぼす
 * (実機で「アプリ作って」と言っても確認が出ない事例)。
 * 直近数文をつないだ文字列に対して同じ検出を行う。
 */
export class TriggerDetector {
  /** つないで見る確定文の数。長くしすぎると离れた語の偶然の結合を拾う */
  static readonly TAIL = 3;

  #tail: string[] = [];

  /** 確定文を1つ受け取り、直近の結合で検出する。見つかったら結合を捨てる */
  feed(text: string): string | null {
    this.#tail.push(text);
    if (this.#tail.length > TriggerDetector.TAIL) this.#tail.shift();

    const phrase = detectTrigger(this.#tail.join(""));
    // 同じ結合で次の文のたびに再検出しない。次は新しい発話から数え直す
    if (phrase !== null) this.#tail = [];
    return phrase;
  }
}
