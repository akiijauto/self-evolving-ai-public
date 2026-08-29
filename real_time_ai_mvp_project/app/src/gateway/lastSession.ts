/**
 * 直前のセッションをタブに覚えておく。
 *
 * 商談中に画面が固まったら、営業担当はページを開き直す。そのとき
 * `sessionId` と `token` がReactの状態にしか無いと、**サーバー上にMarkdownは
 * 残っているのに読む手段だけが消える。** 前半の議事録もZIPも二度と取り出せない。
 *
 * `sessionStorage` を使う(`localStorage` ではない)。タブを閉じたら消え、
 * 別の商談へ持ち越さない。トークンはもともとこのタブのJSが握っているもので、
 * 保存によって新しく晒される相手はいない。
 */

const KEY = "rt-mvp.last-session";

export interface LastSession {
  sessionId: string;
  token: string;
  /** 保存した時刻(ミリ秒)。古すぎるものは使わない */
  savedAt: number;
}

/** これより古い記録は使わない。セッション自体の寿命(既定4時間)に合わせる */
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

export function saveLastSession(sessionId: string, token: string): void {
  try {
    const record: LastSession = { sessionId, token, savedAt: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // プライベートモードなどで書けないことがある。記録できなくても商談は続く
  }
}

export function loadLastSession(): LastSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<LastSession>;
    if (typeof record.sessionId !== "string" || typeof record.token !== "string") return null;
    if (typeof record.savedAt !== "number" || Date.now() - record.savedAt > MAX_AGE_MS) {
      clearLastSession();
      return null;
    }
    return { sessionId: record.sessionId, token: record.token, savedAt: record.savedAt };
  } catch {
    return null;
  }
}

export function clearLastSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 消せなくても、期限で無効になる
  }
}
