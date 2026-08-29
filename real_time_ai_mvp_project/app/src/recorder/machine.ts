import type { RecorderEvent, RecorderState } from "./types";

/**
 * 録音の状態遷移。純粋関数として切り出し、ブラウザAPIなしでテストできるようにする。
 *
 * 不正なイベント(例: idle 中の PAUSE)は状態を変えずに無視する。
 * 呼び出し側が状態を確認せずにイベントを送っても壊れないようにするため。
 */

export const initialRecorderState: RecorderState = {
  status: "idle",
  error: null,
  clip: null,
};

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case "REQUEST":
      // idle / denied / error / stopped のいずれからでも再要求できる
      if (state.status === "recording" || state.status === "paused") return state;
      return { status: "requesting", error: null, clip: null };

    case "GRANTED":
      if (state.status !== "requesting") return state;
      return { status: "recording", error: null, clip: null };

    case "DENIED":
      if (state.status !== "requesting") return state;
      return { status: "denied", error: event.message, clip: null };

    case "PAUSE":
      if (state.status !== "recording") return state;
      return { ...state, status: "paused" };

    case "RESUME":
      if (state.status !== "paused") return state;
      return { ...state, status: "recording" };

    case "STOP":
      // 停止指示。音声データは RECORDED で後から届く
      if (state.status !== "recording" && state.status !== "paused") return state;
      return { ...state, status: "stopped", clip: null };

    case "RECORDED":
      // 停止済みのときだけ受け付ける。録音中に届いた場合は破棄する
      if (state.status !== "stopped") return state;
      return { ...state, clip: event.clip };

    case "RESET":
      if (state.status === "recording" || state.status === "paused") return state;
      return initialRecorderState;

    case "FAIL":
      return { status: "error", error: event.message, clip: null };
  }
}

/** 録音中・一時停止中か。インジケータ表示とページ離脱警告に使う */
export function isCapturing(state: RecorderState): boolean {
  return state.status === "recording" || state.status === "paused";
}

/** マイクを解放してよいか */
export function shouldReleaseMic(state: RecorderState): boolean {
  return !isCapturing(state);
}
