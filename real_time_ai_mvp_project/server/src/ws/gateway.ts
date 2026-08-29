import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CloseCode,
  parseClientMessage,
  type EndReason,
  type ServerMessage,
} from "@rt-mvp/protocol";
import type { Orchestrator } from "../agents/orchestrator.js";
import { TriggerDetector } from "../agents/trigger.js";
import { config } from "../config.js";
import { log } from "../log.js";
import type { SessionDocuments } from "../markdown/sessionDocuments.js";
import { statsOf, type Session, type SessionStore } from "../sessions/store.js";
import { SttProxy } from "../speech/sttProxy.js";
import type { SpeechProvider } from "../speech/types.js";

/**
 * WebSocketゲートウェイ。ARCHITECTURE.md の「WebSocket仕様」に対応する。
 *
 * Sprint 2 の責務は「音声チャンクを受け取り、届いていることを示す」だけ。
 * 文字起こしへの中継は Sprint 3 で STT Proxy として差し込む。
 */

const WS_PATH = /^\/ws\/v1\/sessions\/([^/?]+)$/;

/**
 * セッションごとの STT Proxy。
 *
 * クライアントのWebSocket接続とは寿命が違う。
 * 切断・再接続をまたいで文字起こしを続けるため、ここで保持する。
 */
const sttBySession = new Map<string, SttProxy>();

/**
 * セッションごとのトリガー検出器。
 * 確定文の分割をまたいで拾うため、直近の文を覚えておく必要がある。
 */
const triggerBySession = new Map<string, TriggerDetector>();

/**
 * セッションごとの、現在生きているWebSocket。
 *
 * STT の結果は非同期に届くため、受け取った時点の接続へ送る必要がある。
 * 接続を作ったときのクロージャを掴むと、再接続後に死んだソケットへ送ってしまう。
 */
const socketBySession = new Map<string, WebSocket>();

/**
 * セッションの現在の接続へ送る。接続が無ければ捨てる(再接続時にbacklogで補う)。
 *
 * Orchestrator からの `document.updated` もここを通る。
 * 送り先を探すのはこの関数だけで、呼び出し側は接続の有無を知らない。
 */
export function sendToSession(sessionId: string, message: ServerMessage): void {
  const ws = socketBySession.get(sessionId);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/** セッション終了時に上流を閉じる */
export async function closeStt(sessionId: string): Promise<void> {
  triggerBySession.delete(sessionId);
  const proxy = sttBySession.get(sessionId);
  if (!proxy) return;
  sttBySession.delete(sessionId);
  await proxy.close();
}

export function attachGateway(
  server: Server,
  store: SessionStore,
  speechProvider?: SpeechProvider,
  docs?: SessionDocuments,
  orchestrator?: Orchestrator,
): WebSocketServer {
  // 認証はアップグレード時に行うため、自動での接続受け入れは切る
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = WS_PATH.exec(url.pathname);

    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1] as string;
    const token = url.searchParams.get("token");
    const check = store.verify(sessionId, token);

    // 認証に失敗しても、まずハンドシェイクを完了させてからクローズコードで理由を伝える。
    // HTTPステータスで落とすとブラウザ側がコードを読めないため。
    wss.handleUpgrade(req, socket, head, (ws) => {
      switch (check) {
        case "not_found":
          log.warn("ws.rejected", { sessionId, reason: "not_found" });
          ws.close(CloseCode.NOT_FOUND, "session not found");
          return;
        case "unauthorized":
          log.warn("ws.rejected", { sessionId, reason: "unauthorized" });
          ws.close(CloseCode.UNAUTHORIZED, "invalid token");
          return;
        case "ended":
          log.warn("ws.rejected", { sessionId, reason: "ended" });
          ws.close(CloseCode.ENDED, "session already ended");
          return;
        case "ok":
          break;
      }

      const session = store.get(sessionId);
      if (!session) {
        ws.close(CloseCode.NOT_FOUND, "session not found");
        return;
      }
      handleConnection(ws, session, store, speechProvider, docs, orchestrator);
    });
  });

  return wss;
}

function handleConnection(
  ws: WebSocket,
  session: Session,
  store: SessionStore,
  speechProvider: SpeechProvider | undefined,
  docs: SessionDocuments | undefined,
  orchestrator: Orchestrator | undefined,
): void {
  const connectionId = randomUUID();
  const reconnected = session.connectionId !== null;
  // 宣言どおり前の接続を切る。切らずに配信先だけ差し替えると、
  // **前の画面は「接続中」のまま更新だけが止まる。** 営業担当からは
  // 原因の分からない沈黙にしか見えない
  const previous = socketBySession.get(session.id);
  if (previous !== undefined && previous !== ws) {
    previous.close(CloseCode.SUPERSEDED, "superseded by a newer connection");
  }
  session.connectionId = connectionId;
  socketBySession.set(session.id, ws);
  // 再接続時は一時停止を引き継がない。クライアントが start からやり直す。
  session.paused = false;

  log.info("ws.connected", { sessionId: session.id, connectionId, reconnected });

  let started = false;
  let lastChunkLogAt = 0;
  let chunksSinceLog = 0;
  let bytesSinceLog = 0;

  const send = (message: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  const fail = (arg: ErrorCodeArg): void => {
    send({ type: "error", ...arg });
  };

  send({ type: "session.ready", sessionId: session.id, status: session.status, audio: statsOf(session) });

  // 再接続なら、切断中に確定した文字起こしをまとめて返す。
  // クライアントは受け取った最大 seq を送ってこないため、
  // この接続で未送信のぶん(= 全部)を送り、クライアント側で重複排除する。
  const existingStt = sttBySession.get(session.id);
  if (existingStt && existingStt.finalizedCount > 0) {
    send({ type: "transcript.backlog", segments: existingStt.backlogAfter(0) });
  }
  // 一時停止のまま切断された場合の取り残しを防ぐ。上の paused = false と対で、
  // 一時停止中に閉じた音声認識も開き直す(停止中でなければ何もしない)
  existingStt?.resume();

  // 確認UI・進捗・完成通知は一度しか流れないため、リロードで画面から消える。
  // タブレットのブラウザはバックグラウンドのタブを平気で破棄するので、
  // 「ログを見に行って戻ったら確認が消えていた」が実際に起きる。
  // 接続のたびに最新ジョブの状態から出し直す(文字起こしのbacklogと同じ発想)。
  const latest = orchestrator?.latestJob(session.id);
  if (latest !== undefined && latest.status !== "cancelled") {
    if (latest.status === "awaiting_approval") {
      send({ type: "trigger.detected", jobId: latest.jobId, phrase: latest.phrase ?? "" });
    } else {
      send({
        type: "job.progress",
        jobId: latest.jobId,
        step: latest.step,
        status: latest.status,
        ...(latest.failure !== null ? { failure: latest.failure } : {}),
      });
      if (latest.status === "succeeded" && latest.buildId !== null && latest.url !== null) {
        // 実行時と同じ並び(progress succeeded → artifact.ready)で送る。
        // expiresAt はデプロイ時と同じくセッションの寿命
        send({
          type: "artifact.ready",
          kind: "mvp",
          buildId: latest.buildId,
          url: latest.url,
          previewToken: session.previewToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        });
      }
    }
  }

  const statsTimer = setInterval(() => {
    if (session.chunks > 0) send({ type: "session.stats", audio: statsOf(session) });
  }, config.statsIntervalMs);

  // 無音が続いたら自動終了する(REQUIREMENTS.md FR-8)
  const silenceTimer = setInterval(() => {
    const idleSince = session.lastChunkAt ?? session.createdAt;
    if (!started || session.paused) return;
    if (Date.now() - idleSince < config.silenceTimeoutMs) return;
    endSession("silence");
  }, 30_000);

  const endSession = (reason: EndReason): void => {
    store.end(session.id, reason);
    log.info("session.ended", {
      sessionId: session.id,
      reason,
      chunks: session.chunks,
      bytes: session.bytes,
      transcriptSegments: sttBySession.get(session.id)?.finalizedCount ?? 0,
    });
    void closeStt(session.id);
    // 商談後のサマリとアクション。失敗しても transcript.md は残る
    void orchestrator?.runClosing(session).catch(() => undefined);
    // 商談のメタ情報を確定させる。ここから先はMarkdownだけが残る
    void docs?.close(session).catch((error: unknown) => {
      log.error("documents.close_failed", {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    send({ type: "session.ended", reason });
    ws.close(CloseCode.NORMAL, "session ended");
  };

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      const buffer = toBuffer(data);

      if (!started) {
        fail({ code: "not_started", message: "start を送る前に音声が届きました", recoverable: true });
        return;
      }
      if (session.paused) {
        // 一時停止中に届いたら破棄する。完了条件「pause 中は音声が送られない」の担保。
        log.warn("ws.audio_while_paused", { sessionId: session.id, bytes: buffer.byteLength });
        fail({
          code: "unexpected_audio",
          message: "一時停止中に音声が届きました。破棄しました",
          recoverable: true,
        });
        return;
      }

      store.recordChunk(session.id, buffer.byteLength);
      // 音声認識へ中継する。上流が落ちていても録音と受信は続ける。
      sttBySession.get(session.id)?.push(buffer);
      chunksSinceLog += 1;
      bytesSinceLog += buffer.byteLength;

      const now = Date.now();
      if (now - lastChunkLogAt >= config.chunkLogIntervalMs) {
        log.info("ws.audio", {
          sessionId: session.id,
          chunksInWindow: chunksSinceLog,
          bytesInWindow: bytesSinceLog,
          totalChunks: session.chunks,
          totalBytes: session.bytes,
        });
        lastChunkLogAt = now;
        chunksSinceLog = 0;
        bytesSinceLog = 0;
      }

      if (session.bytes > config.maxSessionBytes) {
        log.warn("ws.rate_limited", { sessionId: session.id, bytes: session.bytes });
        ws.close(CloseCode.RATE_LIMITED, "session byte limit exceeded");
      }
      return;
    }

    const message = parseClientMessage(toBuffer(data).toString("utf8"));
    if (!message) {
      fail({ code: "bad_message", message: "解釈できないメッセージです", recoverable: true });
      return;
    }

    switch (message.type) {
      case "start": {
        started = true;
        session.paused = false;
        session.audioFormat = message.audio;
        log.info("ws.start", {
          sessionId: session.id,
          mimeType: message.audio.mimeType,
          timesliceMs: message.audio.timesliceMs,
        });

        // 課題抽出の定期実行を始める。再接続では作り直さない
        orchestrator?.start(session);

        // STT Proxy はセッションに1つ。再接続では作り直さない。
        if (speechProvider && !sttBySession.has(session.id)) {
          sttBySession.set(
            session.id,
            new SttProxy({
              sessionId: session.id,
              provider: speechProvider,
              opts: {
                mimeType: message.audio.mimeType,
                sampleRate: message.audio.sampleRate,
                channels: message.audio.channels,
                language: config.speechLanguage,
                diarize: config.speechDiarize,
              },
              onPartial: (partial) =>
                sendToSession(session.id, {
                  type: "transcript.partial",
                  text: partial.text,
                  speaker: partial.speaker,
                  at: partial.at,
                }),
              onFinal: (segment) => {
                // 画面への反映を先に、保存を後に。どちらも確定分にしか触らない。
                sendToSession(session.id, { type: "transcript.final", segment });
                // トリガーキーワードの検出。**見つけても何も始めない。**
                // 確認UIを出し、承認されるまで待つ(RETROSPECTIVE.md)。
                // 文の分割をまたいで拾うため、セッション単位の検出器へ通す
                if (!config.triggerDisabled) {
                  let detector = triggerBySession.get(session.id);
                  if (detector === undefined) {
                    detector = new TriggerDetector();
                    triggerBySession.set(session.id, detector);
                  }
                  const phrase = detector.feed(segment.text);
                  if (phrase !== null) orchestrator?.proposeGeneration(session, phrase);
                }

                void docs
                  ?.appendTranscript(session, segment)
                  .then((appended) => {
                    // 溜まってきたら間隔を待たずに課題抽出を回す
                    if (appended) return orchestrator?.onTranscriptGrew(session);
                    return undefined;
                  })
                  .catch((error: unknown) => {
                  // 保存に失敗しても文字起こしは止めない。
                  // 表示は続くので商談は進み、欠けたことはログに残る。
                  log.error("documents.transcript_failed", {
                    sessionId: session.id,
                    seq: segment.seq,
                    message: error instanceof Error ? error.message : String(error),
                  });
                });
              },
              onError: (message_) =>
                sendToSession(session.id, {
                  type: "error",
                  code: "stt_unavailable",
                  message: message_,
                  recoverable: true,
                }),
            }),
          );
        }
        break;
      }

      case "pause":
        session.paused = true;
        // 上流の音声認識も止める。開けたままだと無音でアイドル切断され、
        // 再試行を使い切って「再開しても文字起こしが戻らない」になる
        sttBySession.get(session.id)?.suspend();
        log.info("ws.pause", { sessionId: session.id });
        break;

      case "resume":
        session.paused = false;
        sttBySession.get(session.id)?.resume();
        log.info("ws.resume", { sessionId: session.id });
        break;

      case "confirm_generate": {
        const job = orchestrator?.resolveProposal(session, message.jobId, message.approved);
        if (!job) {
          // 既に走り出しているか、古い確認UIからの応答。黙って捨てず理由を返す
          fail({
            code: "bad_message",
            message: "この確認は既に終わっています",
            recoverable: true,
          });
          break;
        }
        log.info("ws.confirm_generate", {
          sessionId: session.id,
          jobId: message.jobId,
          approved: message.approved,
        });
        break;
      }

      case "stop":
        endSession(message.reason);
        break;

      case "ping":
        send({ type: "pong" });
        break;
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(statsTimer);
    clearInterval(silenceTimer);
    // 後から張られた接続が現役なら、こちらの切断で状態を消さない
    if (session.connectionId === connectionId) session.connectionId = null;
    if (socketBySession.get(session.id) === ws) socketBySession.delete(session.id);
    log.info("ws.closed", {
      sessionId: session.id,
      connectionId,
      code,
      reason: reason.toString(),
      totalChunks: session.chunks,
      totalBytes: session.bytes,
    });
  });

  ws.on("error", (error: Error) => {
    log.error("ws.error", { sessionId: session.id, connectionId, message: error.message });
  });
}

interface ErrorCodeArg {
  code: "unexpected_audio" | "bad_message" | "not_started" | "internal";
  message: string;
  recoverable: boolean;
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
