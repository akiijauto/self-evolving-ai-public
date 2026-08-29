import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AudioFormat,
  AudioStats,
  EndReason,
  JobFailure,
  JobStatus,
  JobStep,
  ServerMessage,
} from "@rt-mvp/protocol";
import {
  appendBacklog,
  appendFinal,
  initialTranscriptState,
  setPartial,
  type TranscriptState,
} from "../transcript/merge";
import { GatewayClient, type ConnectionState } from "./GatewayClient";
import { ApiError, createSession, getSession, resolveWsUrl } from "./sessionApi";
import { clearLastSession, loadLastSession, saveLastSession } from "./lastSession";

/**
 * セッション作成から WebSocket 接続までをまとめる React hook。
 *
 * 録音側(useRecorder)とは独立させ、音声チャンクを sendAudio へ渡すだけの関係にする。
 * これにより Sprint 3 以降で文字起こしを足すとき、録音側を変更しなくて済む。
 */

export interface GatewayStatus {
  connection: ConnectionState;
  sessionId: string | null;
  /** サーバーが受信した音声の統計。疎通確認に使う */
  audio: AudioStats | null;
  /** バッファに溜まっている音声の長さ(ミリ秒) */
  bufferedMs: number;
  /** 60秒を超えて捨てたチャンク数 */
  droppedChunks: number;
  error: string | null;
  /** リアルタイム文字起こし */
  transcript: TranscriptState;
  /** 音声認識が停止しているか。録音と受信は続いている */
  sttDegraded: boolean;
  /** Markdownを取り直すためのトークン。セッション作成時に得たもの */
  token: string | null;
  /** 更新のあったMarkdown。名前 → 更新時刻 */
  documentUpdates: Record<string, string>;
  /** AI(Orchestrator)が停止しているか。文字起こしは続いている */
  llmDegraded: boolean;
  /** トリガー検出。承認するまで生成は始まらない */
  trigger: { jobId: string; phrase: string } | null;
  /** 生成ジョブの進捗。failed のときは failure に理由が入る */
  job: { jobId: string; step: JobStep; status: JobStatus; failure?: JobFailure } | null;
  /** 生成できたMVP */
  artifact: { buildId: string; url: string; previewToken: string; expiresAt: string } | null;
}

export interface UseGatewayResult extends GatewayStatus {
  /** セッションを作成して接続する。既に接続済みなら何もしない */
  open: (audio: AudioFormat) => Promise<void>;
  sendAudio: (chunk: Blob) => void;
  pause: () => void;
  resume: () => void;
  /** セッションを終了して接続を閉じる */
  close: (reason: EndReason) => void;
  /** トリガー検出への応答。人がタップしたときだけ呼ぶ */
  confirmGenerate: (jobId: string, approved: boolean) => void;
}

const INITIAL: GatewayStatus = {
  connection: "idle",
  sessionId: null,
  audio: null,
  bufferedMs: 0,
  droppedChunks: 0,
  error: null,
  transcript: initialTranscriptState,
  sttDegraded: false,
  token: null,
  documentUpdates: {},
  llmDegraded: false,
  trigger: null,
  job: null,
  artifact: null,
};

/**
 * 外部API(音声認識 / LLM)の停止か。
 * これらは録音を止めない。セッション全体のエラーと同じ扱いにしない。
 */
function isDegradation(code: string): boolean {
  return code === "stt_unavailable" || code === "llm_unavailable";
}

export function useGateway(): UseGatewayResult {
  const [status, setStatus] = useState<GatewayStatus>(INITIAL);
  const clientRef = useRef<GatewayClient | null>(null);
  // バッファ量は毎チャンク変わるため、描画のたびに read する
  const bufferTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const open = useCallback(async (audio: AudioFormat) => {
    if (clientRef.current) return;

    setStatus({ ...INITIAL, connection: "connecting" });

    let created;
    try {
      created = await createSession({
        clientInfo: navigator.userAgent.slice(0, 200),
      });
    } catch (error) {
      setStatus({
        ...INITIAL,
        connection: "closed",
        error: error instanceof ApiError ? error.message : "セッションを作成できませんでした。",
      });
      return;
    }

    const client = new GatewayClient({
      wsUrl: resolveWsUrl(created.wsUrl, created.sessionId),
      token: created.token,
      timesliceMs: audio.timesliceMs,
      onState: (connection) => setStatus((prev) => ({ ...prev, connection })),
      onMessage: (message: ServerMessage) => {
        switch (message.type) {
          case "session.ready":
          case "session.stats":
            setStatus((prev) => ({ ...prev, audio: message.audio }));
            break;
          case "session.ended":
            setStatus((prev) => ({ ...prev, connection: "closed" }));
            break;

          case "transcript.partial":
            setStatus((prev) => ({
              ...prev,
              sttDegraded: false,
              transcript: setPartial(prev.transcript, {
                text: message.text,
                speaker: message.speaker,
              }),
            }));
            break;

          case "transcript.final":
            setStatus((prev) => ({
              ...prev,
              sttDegraded: false,
              transcript: appendFinal(prev.transcript, message.segment),
            }));
            break;

          case "transcript.backlog":
            // 再接続時にまとめて届く。既知の行は merge 側で捨てられる。
            setStatus((prev) => ({
              ...prev,
              transcript: appendBacklog(prev.transcript, message.segments),
            }));
            break;

          case "document.updated":
            setStatus((prev) => ({
              ...prev,
              llmDegraded: false,
              documentUpdates: { ...prev.documentUpdates, [message.name]: message.updatedAt },
            }));
            break;

          case "trigger.detected":
            setStatus((prev) => ({
              ...prev,
              trigger: { jobId: message.jobId, phrase: message.phrase },
            }));
            break;

          case "job.progress":
            setStatus((prev) => ({
              ...prev,
              // 走り出したら確認UIは引っ込める
              trigger: prev.trigger?.jobId === message.jobId ? null : prev.trigger,
              job: {
                jobId: message.jobId,
                step: message.step,
                status: message.status,
                ...(message.failure !== undefined ? { failure: message.failure } : {}),
              },
            }));
            break;

          case "artifact.ready":
            setStatus((prev) => ({
              ...prev,
              artifact: {
                buildId: message.buildId,
                url: message.url,
                previewToken: message.previewToken,
                expiresAt: message.expiresAt,
              },
            }));
            break;

          case "error":
            setStatus((prev) => ({
              ...prev,
              // 外部APIの停止は、セッション全体のエラーとは区別する。
              // 録音と送信は続いているため、赤いエラー表示にはしない。
              sttDegraded: message.code === "stt_unavailable" ? true : prev.sttDegraded,
              llmDegraded: message.code === "llm_unavailable" ? true : prev.llmDegraded,
              error: isDegradation(message.code) ? prev.error : message.message,
            }));
            break;
          case "pong":
            break;
        }
      },
      onFatal: (reason) => {
        const message =
          reason === "ended"
            ? "セッションは既に終了しています。"
            : "セッションの認証に失敗しました。最初からやり直してください。";
        setStatus((prev) => ({ ...prev, connection: "closed", error: message }));
      },
      onDropped: (droppedChunks) => setStatus((prev) => ({ ...prev, droppedChunks })),
    });

    clientRef.current = client;
    // 画面が固まって開き直したときに、記録へ戻れるようにする
    saveLastSession(created.sessionId, created.token);
    setStatus((prev) => ({ ...prev, sessionId: created.sessionId, token: created.token }));
    client.connect();
    client.start(audio);

    bufferTimerRef.current = setInterval(() => {
      setStatus((prev) =>
        prev.bufferedMs === client.bufferedMs ? prev : { ...prev, bufferedMs: client.bufferedMs },
      );
    }, 500);
  }, []);

  const sendAudio = useCallback((chunk: Blob) => {
    clientRef.current?.sendAudio(chunk);
  }, []);

  const confirmGenerate = useCallback((jobId: string, approved: boolean) => {
    clientRef.current?.confirmGenerate(jobId, approved);
    // 応答したら確認UIは閉じる。サーバーからの job.progress を待たない
    setStatus((prev) => ({ ...prev, trigger: null }));
  }, []);

  const pause = useCallback(() => clientRef.current?.pause(), []);
  const resume = useCallback(() => clientRef.current?.resume(), []);

  const close = useCallback((reason: EndReason) => {
    const client = clientRef.current;
    if (!client) return;
    client.stop(reason);
    client.dispose();
    clientRef.current = null;
    if (bufferTimerRef.current !== null) {
      clearInterval(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    setStatus((prev) => ({ ...prev, connection: "closed", bufferedMs: 0 }));
  }, []);

  /**
   * 開き直したときに、直前の商談の記録へ戻れるようにする。
   *
   * 録音は再開しない(できない)。**議事録を読んで持ち帰るための復帰**で、
   * これが無いと「記録は消えない」と書いてある手順書が嘘になる。
   */
  useEffect(() => {
    const last = loadLastSession();
    if (last === null) return;
    let cancelled = false;

    void (async () => {
      try {
        await getSession(last.sessionId, last.token);
        if (cancelled) return;
        setStatus((prev) =>
          // その間に新しい商談が始まっていたら、そちらを邪魔しない
          prev.sessionId !== null
            ? prev
            : { ...prev, sessionId: last.sessionId, token: last.token, connection: "closed" },
        );
      } catch {
        // 失効・削除済み。押しても401になるボタンを出さない
        clearLastSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // アンマウント時に必ず接続を閉じる
  useEffect(() => {
    return () => {
      clientRef.current?.dispose();
      clientRef.current = null;
      if (bufferTimerRef.current !== null) clearInterval(bufferTimerRef.current);
    };
  }, []);

  return { ...status, open, sendAudio, pause, resume, close, confirmGenerate };
}
