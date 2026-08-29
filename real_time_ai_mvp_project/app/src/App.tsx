import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AUDIO_TIMESLICE_MS } from "@rt-mvp/protocol";
import { useRecorder } from "./recorder/useRecorder";
import { useGateway } from "./gateway/useGateway";
import { RecordingIndicator } from "./components/RecordingIndicator";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { Transcript } from "./components/Transcript";
import { Documents } from "./components/Documents";
import { TriggerConfirm } from "./components/TriggerConfirm";
import { Artifact } from "./components/Artifact";
import { SessionExport } from "./components/SessionExport";
import { Usage } from "./components/Usage";
import { ManualGenerate } from "./components/ManualGenerate";
import { useDocuments } from "./documents/useDocuments";
import { useClosingDocuments } from "./documents/useClosingDocuments";
import { ErrorNotice } from "./components/ErrorNotice";
import { ClipPlayer } from "./components/ClipPlayer";
import { downloadExport } from "./gateway/sessionApi";
import { formatDuration } from "./format";

export function App() {
  const gateway = useGateway();
  // 商談が終わったか。トークンは残しているので、記録の閲覧と持ち帰りは続けられる
  const ended = gateway.sessionId !== null && gateway.connection === "closed";
  // 停止と同時にWebSocketは閉じるので、そのあとに書かれる summary/todo の
  // 通知は誰にも届かない。終了後は自分で取りに行く
  const closingUpdates = useClosingDocuments(gateway.sessionId, gateway.token, ended);
  // 更新の通知を受けてMarkdownを取り直す。
  // **描画のたびに混ぜ直さない。** updates の参照が毎回変わると
  // useDocuments の effect が描画ごとに走り直し、取得→中断→再取得の
  // 無限ループになる(実機のモバイル回線で発生)
  const documentUpdates = useMemo(
    () => ({ ...gateway.documentUpdates, ...closingUpdates }),
    [gateway.documentUpdates, closingUpdates],
  );
  const documents = useDocuments(gateway.sessionId, gateway.token, documentUpdates);
  const handleExport =
    gateway.sessionId !== null && gateway.token !== null
      ? () => void downloadExport(gateway.sessionId as string, gateway.token as string)
      : null;

  // 録音チャンクをそのままサーバーへ流す
  const handleChunk = useCallback((chunk: Blob) => gateway.sendAudio(chunk), [gateway]);

  const recorder = useRecorder({ onChunk: handleChunk, timesliceMs: AUDIO_TIMESLICE_MS });
  const { state, elapsedMs, mimeType } = recorder;
  const { status } = state;

  const busy = status === "requesting";
  const capturing = status === "recording" || status === "paused";

  // 使い方は開始前に読むもの。録音が始まったら畳む(顧客に画面共有するため)。
  // 商談中に言い回しを確かめたくなったら、自分で開き直せる
  const [usageOpen, setUsageOpen] = useState(true);
  useEffect(() => {
    if (capturing) setUsageOpen(false);
  }, [capturing]);

  // 録音が始まったらセッションを作って接続する。
  // mimeType は MediaRecorder が決めるため、start 後にしか分からない。
  const openedRef = useRef(false);
  useEffect(() => {
    if (status !== "recording" || openedRef.current || !mimeType) return;
    openedRef.current = true;
    void gateway.open({
      mimeType,
      codec: mimeType.includes("opus") ? "opus" : "unknown",
      sampleRate: 48000,
      channels: 1,
      timesliceMs: AUDIO_TIMESLICE_MS,
    });
  }, [gateway, mimeType, status]);

  const handleStart = useCallback(() => {
    openedRef.current = false;
    void recorder.start();
  }, [recorder]);

  const handlePause = useCallback(() => {
    recorder.pause();
    gateway.pause();
  }, [gateway, recorder]);

  const handleResume = useCallback(() => {
    recorder.resume();
    gateway.resume();
  }, [gateway, recorder]);

  const handleStop = useCallback(() => {
    recorder.stop();
    gateway.close("button");
    openedRef.current = false;
  }, [gateway, recorder]);

  return (
    <div className="app">
      <RecordingIndicator status={status} elapsedMs={elapsedMs} />

      <header className="header">
        <h1>RealTime AI MVP Generator</h1>
        {/* 顧客に画面共有する前提。開発の進捗(Sprint番号など)は出さない */}
        <p className="subtitle">話した内容が、その場でかたちになります</p>
      </header>

      <main className="main">
        <Usage open={usageOpen} onToggle={setUsageOpen} />

        <div className="timer">{formatDuration(elapsedMs)}</div>

        {status === "idle" && (
          <p className="hint">
            録音を開始すると、ブラウザがマイクの使用許可を求めます。
            <br />
            商談で使う際は、相手の同意を得てから開始してください。
          </p>
        )}

        <ConnectionStatus
          connection={gateway.connection}
          sessionId={gateway.sessionId}
          audio={gateway.audio}
          bufferedMs={gateway.bufferedMs}
          droppedChunks={gateway.droppedChunks}
        />

        {gateway.connection !== "idle" && (
          <Transcript state={gateway.transcript} degraded={gateway.sttDegraded} />
        )}

        {gateway.trigger !== null && (
          <TriggerConfirm
            phrase={gateway.trigger.phrase}
            summary={documents.contents["summary.md"] ?? null}
            degraded={gateway.llmDegraded}
            onApprove={() => gateway.confirmGenerate(gateway.trigger?.jobId ?? "", true)}
            onCancel={() => gateway.confirmGenerate(gateway.trigger?.jobId ?? "", false)}
          />
        )}

        <Artifact job={gateway.job} artifact={gateway.artifact} />

        {/* 合図が拾われないときの逃げ道。走行中・確認中・終了後は出さない */}
        {gateway.sessionId !== null &&
          gateway.token !== null &&
          !ended &&
          gateway.trigger === null &&
          !(
            gateway.job !== null &&
            ["awaiting_approval", "queued", "running"].includes(gateway.job.status)
          ) && <ManualGenerate sessionId={gateway.sessionId} token={gateway.token} />}

        {/* 試作品の有無に関わらず出す。議事録は毎回持ち帰るもの */}
        <SessionExport ended={ended} onExport={handleExport} />

        {gateway.connection !== "idle" && (
          <Documents
            state={documents}
            // 商談中の通知ぶんと、停止後にポーリングで拾ったぶんの合成。
            // 通知ぶんだけを渡すと、停止後のサマリ/アクションのタブが出ない
            updates={documentUpdates}
            degraded={gateway.llmDegraded}
            sessionId={gateway.sessionId}
            token={gateway.token}
          />
        )}

        {state.error !== null && (
          <ErrorNotice
            message={state.error}
            recoverable={status === "denied" || status === "error"}
          />
        )}

        {gateway.error !== null && <ErrorNotice message={gateway.error} recoverable={false} />}

        <div className="controls">
          {!capturing && (
            <button className="btn btn-primary" onClick={handleStart} disabled={busy}>
              {busy ? "許可を待っています…" : status === "stopped" ? "もう一度録音する" : "録音を開始"}
            </button>
          )}

          {status === "recording" && (
            <button className="btn" onClick={handlePause}>
              一時停止
            </button>
          )}

          {status === "paused" && (
            <button className="btn btn-primary" onClick={handleResume}>
              再開
            </button>
          )}

          {capturing && (
            <button className="btn btn-danger" onClick={handleStop}>
              停止
            </button>
          )}
        </div>

        {status === "stopped" && <ClipPlayer clip={state.clip} onDiscard={recorder.reset} />}
      </main>

      <footer className="footer">
        <p>
          音声はサーバーを通過するだけで保存されません。保存するのは文字起こしのテキストのみです。
        </p>
      </footer>
    </div>
  );
}
