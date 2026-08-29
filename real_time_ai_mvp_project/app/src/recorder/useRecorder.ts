import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AUDIO_TIMESLICE_MS } from "@rt-mvp/protocol";
import { browserAudioSource } from "./browserAudioSource";
import { MicPermissionError } from "./browserAudioSource";
import { initialRecorderState, isCapturing, recorderReducer } from "./machine";
import type { AudioSource, MediaRecorderLike, RecorderState } from "./types";

/** 経過時間の更新間隔。表示は秒単位なので250msで十分 */
const TICK_MS = 250;

export interface UseRecorderOptions {
  source?: AudioSource;
  /**
   * 音声チャンクが切り出されるたびに呼ばれる。
   * Sprint 2 ではここから WebSocket へ送る。
   *
   * 注意: 最初のチャンクにだけWebMのヘッダが含まれる。
   * 単体で切り離すと再生できないため、順序を保って送ること。
   */
  onChunk?: (chunk: Blob) => void;
  /** チャンクの切り出し間隔。既定は ARCHITECTURE.md の 250ms */
  timesliceMs?: number;
}

export interface UseRecorderResult {
  state: RecorderState;
  /** 録音経過時間(ミリ秒)。一時停止中は進まない */
  elapsedMs: number;
  /** マイク権限を要求し、許可されたら録音を開始する */
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** 録音結果を破棄して初期状態へ戻す */
  reset: () => void;
  /** 実際に使われている音声フォーマット。start 前は null */
  mimeType: string | null;
}

export function useRecorder(options: UseRecorderOptions = {}): UseRecorderResult {
  const source = options.source ?? browserAudioSource;
  const timesliceMs = options.timesliceMs ?? AUDIO_TIMESLICE_MS;

  const [state, dispatch] = useReducer(recorderReducer, initialRecorderState);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mimeType, setMimeType] = useState<string | null>(null);

  // 最新の onChunk を参照する。start をやり直さずにコールバックを差し替えられるようにする
  const onChunkRef = useRef(options.onChunk);
  onChunkRef.current = options.onChunk;

  const recorderRef = useRef<MediaRecorderLike | null>(null);
  const renewRef = useRef<(() => MediaRecorderLike) | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  // 一時停止→再開をまたぐと、複数のWebMが連結された状態になる。
  // 手元再生(ClipPlayer)は最初の区間しか再生できないことがあるが、
  // 商談の記録の本体はサーバー側の文字起こしであり、許容する
  const chunksRef = useRef<Blob[]>([]);
  const clipUrlRef = useRef<string | null>(null);

  // 経過時間は「確定分 + 現在のセグメント」で持つ。一時停止で確定分に繰り入れる。
  const accumulatedRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);

  const releaseMic = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
    recorderRef.current = null;
    renewRef.current = null;
  }, []);

  /**
   * レコーダーへハンドラを取り付ける。
   * start 時と、一時停止→再開での作り直し時の両方で使う。
   */
  const wire = useCallback(
    (recorder: MediaRecorderLike) => {
      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        // ローカル再生用に保持しつつ、同じチャンクを送信側へ渡す
        chunksRef.current.push(event.data);
        onChunkRef.current?.(event.data);
      };

      recorder.onerror = () => {
        releaseMic();
        dispatch({ type: "FAIL", message: "録音中にエラーが発生しました。" });
      };

      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];

        // 停止時点までの経過をここで確定させる
        const finishedAt =
          accumulatedRef.current +
          (segmentStartRef.current === null ? 0 : Date.now() - segmentStartRef.current);
        segmentStartRef.current = null;

        releaseMic();

        if (chunks.length === 0) {
          dispatch({ type: "FAIL", message: "音声が取得できませんでした。もう一度お試しください。" });
          return;
        }

        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        clipUrlRef.current = url;

        dispatch({
          type: "RECORDED",
          clip: { url, mimeType, sizeBytes: blob.size, durationMs: finishedAt },
        });
      };
    },
    [releaseMic],
  );

  const revokeClip = useCallback(() => {
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (isCapturing(state)) return;

    revokeClip();
    dispatch({ type: "REQUEST" });

    let opened: Awaited<ReturnType<AudioSource["open"]>>;
    try {
      opened = await source.open();
    } catch (error) {
      if (error instanceof MicPermissionError) {
        dispatch({ type: "DENIED", message: error.message });
      } else {
        dispatch({
          type: "FAIL",
          message: error instanceof Error ? error.message : "マイクの初期化に失敗しました。",
        });
      }
      return;
    }

    const { recorder, renew, close } = opened;
    recorderRef.current = recorder;
    renewRef.current = renew;
    closeRef.current = close;
    chunksRef.current = [];

    setMimeType(recorder.mimeType || null);
    wire(recorder);

    accumulatedRef.current = 0;
    segmentStartRef.current = Date.now();
    setElapsedMs(0);

    try {
      // timeslice を渡すと、この間隔で ondataavailable が呼ばれる
      recorder.start(timesliceMs);
    } catch (error) {
      releaseMic();
      dispatch({
        type: "FAIL",
        message: error instanceof Error ? error.message : "録音を開始できませんでした。",
      });
      return;
    }

    dispatch({ type: "GRANTED" });
  }, [releaseMic, revokeClip, source, state, timesliceMs, wire]);

  const pause = useCallback(() => {
    if (state.status !== "recording") return;
    if (segmentStartRef.current !== null) {
      accumulatedRef.current += Date.now() - segmentStartRef.current;
      segmentStartRef.current = null;
    }
    recorderRef.current?.pause();
    dispatch({ type: "PAUSE" });
  }, [state.status]);

  const resume = useCallback(() => {
    if (state.status !== "paused") return;

    // MediaRecorder.resume() で古いストリームの続きを送らず、**録音を新規に始め直す。**
    // 続き(ヘッダ無し・時間の飛んだクラスタ)を音声認識へ流すと、
    // 実機ではエラーも出ずに文字起こしが沈黙した。新しいレコーダーなら
    // 最初のチャンクに新しいWebMヘッダが入り、通常のセッション開始と同じ形になる。
    const old = recorderRef.current;
    const renew = renewRef.current;
    if (old !== null && renew !== null) {
      // 古いレコーダーは黙って捨てる。onstop の後始末(クリップ化・マイク解放)は
      // 本当の停止のときだけ動かす
      old.ondataavailable = null;
      old.onstop = null;
      old.onerror = null;
      try {
        old.stop();
      } catch {
        // 既に止まっていても構わない
      }

      const next = renew();
      recorderRef.current = next;
      wire(next);
      try {
        next.start(timesliceMs);
      } catch {
        releaseMic();
        dispatch({ type: "FAIL", message: "録音を再開できませんでした。もう一度開始してください。" });
        return;
      }
    } else {
      // 作り直せない実装(テスト用モック等)では従来どおり続きから
      old?.resume();
    }

    segmentStartRef.current = Date.now();
    dispatch({ type: "RESUME" });
  }, [releaseMic, state.status, timesliceMs, wire]);

  const stop = useCallback(() => {
    if (!isCapturing(state)) return;
    // clip は onstop で届く
    dispatch({ type: "STOP" });
    recorderRef.current?.stop();
  }, [state]);

  const reset = useCallback(() => {
    if (isCapturing(state)) return;
    revokeClip();
    accumulatedRef.current = 0;
    segmentStartRef.current = null;
    setElapsedMs(0);
    dispatch({ type: "RESET" });
  }, [revokeClip, state]);

  // 経過時間の更新
  useEffect(() => {
    if (state.status !== "recording") return;
    const id = window.setInterval(() => {
      const current =
        accumulatedRef.current +
        (segmentStartRef.current === null ? 0 : Date.now() - segmentStartRef.current);
      setElapsedMs(current);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [state.status]);

  // 録音中の誤操作によるページ離脱を防ぐ
  useEffect(() => {
    if (!isCapturing(state)) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state]);

  // アンマウント時にマイクとObject URLを必ず解放する
  useEffect(() => {
    return () => {
      closeRef.current?.();
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    };
  }, []);

  return { state, elapsedMs, start, pause, resume, stop, reset, mimeType };
}
