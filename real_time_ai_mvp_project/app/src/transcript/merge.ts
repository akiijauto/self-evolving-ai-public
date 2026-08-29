import type { TranscriptSegment } from "@rt-mvp/protocol";

/**
 * 文字起こしの表示状態と、その更新規則。
 *
 * 純粋関数として切り出し、Reactもブラウザも無しでテストできるようにする。
 *
 * 表示の約束:
 * - 確定(final)は追記され、以後変わらない
 * - 未確定(partial)は常に末尾に1つだけ。次の partial か final で置き換わる
 * - 再接続時の再送(backlog)で行が重複しない
 */

export interface Partial {
  text: string;
  speaker: string | null;
}

export interface TranscriptState {
  /** 確定した行。seq 昇順 */
  segments: TranscriptSegment[];
  /** 未確定の行。無ければ null */
  partial: Partial | null;
  /** 受け取った最大の seq。再接続時の重複排除に使う */
  lastSeq: number;
}

export const initialTranscriptState: TranscriptState = {
  segments: [],
  partial: null,
  lastSeq: 0,
};

/**
 * 確定した行を追加する。
 * 既に持っている seq は無視する(再接続で同じ行が再送されるため)。
 */
export function appendFinal(state: TranscriptState, segment: TranscriptSegment): TranscriptState {
  if (segment.seq <= state.lastSeq) {
    // 既知の行。partial だけは消す(確定済みの内容を未確定として残さない)
    return state.partial === null ? state : { ...state, partial: null };
  }

  return {
    segments: [...state.segments, segment],
    // 確定したら未確定は消える。これが「置き換わる際に表示が乱れない」の実装。
    partial: null,
    lastSeq: segment.seq,
  };
}

/** 再接続時にまとめて届いた確定分を取り込む */
export function appendBacklog(
  state: TranscriptState,
  segments: TranscriptSegment[],
): TranscriptState {
  return segments
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .reduce(appendFinal, state);
}

/** 未確定を差し替える */
export function setPartial(state: TranscriptState, partial: Partial): TranscriptState {
  // 空文字は「未確定なし」と同じ。ちらつきを避けるため無視する。
  if (partial.text.length === 0) return state.partial === null ? state : { ...state, partial: null };
  return { ...state, partial };
}

export function clearTranscript(): TranscriptState {
  return initialTranscriptState;
}

/** 画面に出す行。確定分の後ろに未確定を1つ足したもの */
export interface DisplayLine {
  key: string;
  text: string;
  speaker: string | null;
  confirmed: boolean;
}

export function toDisplayLines(state: TranscriptState): DisplayLine[] {
  const lines: DisplayLine[] = state.segments.map((segment) => ({
    key: `seq-${segment.seq}`,
    text: segment.text,
    speaker: segment.speaker,
    confirmed: true,
  }));

  if (state.partial !== null) {
    lines.push({
      key: "partial",
      text: state.partial.text,
      speaker: state.partial.speaker,
      confirmed: false,
    });
  }

  return lines;
}
