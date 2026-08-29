/**
 * 録音の状態と型定義。
 *
 * MediaRecorder / getUserMedia への依存をこのファイルの外へ出さないため、
 * ブラウザAPIは最小限のインターフェースとして抽象化する。
 * これによりテストではモックを差し込める。
 */

export type RecorderStatus =
  /** 未開始。マイク権限をまだ要求していない */
  | "idle"
  /** マイク権限を要求中(ブラウザのダイアログ表示中) */
  | "requesting"
  /** マイク権限を拒否された。ユーザー操作で再要求できる */
  | "denied"
  /** 録音中 */
  | "recording"
  /** 一時停止中 */
  | "paused"
  /** 録音完了。clip が再生可能 */
  | "stopped"
  /** 権限以外の理由で失敗した */
  | "error";

/** 録音された音声。Sprint 1 ではローカル再生にのみ使う */
export interface Clip {
  /** 再生用の Object URL。破棄時に revoke すること */
  url: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
}

export interface RecorderState {
  status: RecorderStatus;
  /** denied / error のときのみ非 null */
  error: string | null;
  /** stopped のときのみ非 null */
  clip: Clip | null;
}

export type RecorderEvent =
  /** マイク権限を要求する */
  | { type: "REQUEST" }
  /** 権限が下りた。同時に録音を開始する */
  | { type: "GRANTED" }
  /** 権限を拒否された */
  | { type: "DENIED"; message: string }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  /** 停止を指示した(まだ音声データは揃っていない) */
  | { type: "STOP" }
  /** 音声データが揃った */
  | { type: "RECORDED"; clip: Clip }
  /** 録音結果を破棄して待機状態へ戻す */
  | { type: "RESET" }
  /** 権限以外の失敗 */
  | { type: "FAIL"; message: string };

/**
 * MediaRecorder のうち、このアプリが使う部分だけを写した型。
 * テストではこのインターフェースを満たすモックを渡す。
 */
export interface MediaRecorderLike {
  readonly mimeType: string;
  start(timesliceMs?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** 音声取得とレコーダー生成をまとめた依存。テストで差し替える */
export interface AudioSource {
  /** マイク権限を要求し、レコーダーを生成する。拒否時は例外を投げる */
  open(): Promise<{
    recorder: MediaRecorderLike;
    /**
     * 同じマイクで**新しい**レコーダーを作る。一時停止→再開で使う。
     * 再開時に録音を新規に始め直すのは、WebMのヘッダを新しく作らせるため。
     * 古いストリームの続き(ヘッダ無し・時間が飛んだ状態)を認識サービスへ
     * 流すと、実機ではエラーも出ずに文字起こしが沈黙した。
     */
    renew: () => MediaRecorderLike;
    close: () => void;
  }>;
}
