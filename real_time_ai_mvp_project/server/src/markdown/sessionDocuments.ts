import type { TranscriptSegment } from "@rt-mvp/protocol";
import { log } from "../log.js";
import type { Session } from "../sessions/store.js";
import { isDocumentName, type DocumentName, type Writer } from "./documents.js";
import { renderMeeting, renderTranscriptEntry } from "./format.js";
import { DocumentError, MarkdownStore, type DocumentInfo } from "./store.js";

/**
 * セッションの出来事をMarkdownへ落とす層。
 *
 * WebSocketゲートウェイとHTTP APIは、Markdownの中身を知らずにここを呼ぶ。
 * スキーマ(DATAFLOW.md)を知っているのはこのファイルと format.ts だけ。
 *
 * `meeting.md` の所有者は AGENTS.md では Orchestrator だが、
 * Orchestrator は Sprint 5 で作る。それまでは Gateway が代行して書く。
 */

/** 入力アダプタが受け取る入力元。DATAFLOW.md の「入力アダプタ」表に対応する */
export type InputSource = "manual" | "circleback" | "notion";

/** 入力元ごとの既定の正規化先。指定が無ければここへ落ちる */
const DEFAULT_TARGET: Record<InputSource, DocumentName> = {
  manual: "transcript.md",
  circleback: "transcript.md",
  notion: "context.md",
};

export class SessionDocuments {
  readonly store: MarkdownStore;

  /**
   * セッションごとに書き込み済みの最大 seq。
   *
   * 再接続時の `transcript.backlog` や上流の張り直しで同じ確定分が
   * 再度届いても、ファイルへ二重に追記しないための関門。
   */
  readonly #lastSeq = new Map<string, number>();

  constructor(store: MarkdownStore) {
    this.store = store;
  }

  /** セッション開始。`meeting.md` と空の `transcript.md` を作る */
  async open(session: Session): Promise<void> {
    await this.store.ensure(session.id);
    await this.#writeMeeting(session);
    // 追記専用ファイルは見出しだけ先に置く。開始直後でも一覧に出る
    await this.store.append(session.id, "transcript.md", "", "speech_agent");
  }

  /**
   * 確定した文字起こしを `transcript.md` へ追記する。
   * 追記できたら true、既に書き込み済みの seq なら false。
   *
   * 追記は少し粘る(下の #appendWithRetry)。それでも失敗したら
   * seq の関門を戻してから例外を上げる。**書けなかった発言を
   * 「書き込み済み」として黙って落とさない**ためで、上流の再送
   * (`transcript.backlog` など)が来れば同じ seq でもう一度書ける。
   */
  async appendTranscript(session: Session, segment: TranscriptSegment): Promise<boolean> {
    const last = this.#lastSeq.get(session.id) ?? 0;
    if (segment.seq <= last) return false;
    this.#lastSeq.set(session.id, segment.seq);

    const text = renderTranscriptEntry({
      // 見出しは商談開始からの経過を壁時計へ直したもの(DATAFLOW.md の例に合わせる)
      at: new Date(session.createdAt + segment.startMs),
      speaker: segment.speaker,
      text: segment.text,
    });

    try {
      await this.#appendWithRetry(session.id, text);
    } catch (error) {
      // 並行して先の seq が成功していたら、そちらの関門は壊さない
      if (this.#lastSeq.get(session.id) === segment.seq) {
        this.#lastSeq.set(session.id, last);
      }
      throw error;
    }
    return true;
  }

  /**
   * ディスクの一時的な不調(ENOSPC 直後の回復など)で1発言を失わないよう、
   * 間を置いて2回まで追試する。商談中の追記は数秒に1回なので、
   * この待ちが後続の発言を詰まらせることはない(書き込みはセッション単位で直列)。
   */
  async #appendWithRetry(sessionId: string, text: string): Promise<void> {
    const delaysMs = [100, 500];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.store.append(sessionId, "transcript.md", text, "speech_agent");
        return;
      } catch (error) {
        if (attempt >= delaysMs.length) throw error;
        log.warn("documents.append_retry", {
          sessionId,
          attempt: attempt + 1,
          message: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delaysMs[attempt]));
      }
    }
  }

  /** セッション終了。`meeting.md` の `ended_at` と `status` を確定させる */
  async close(session: Session): Promise<void> {
    await this.#writeMeeting(session);
    this.#lastSeq.delete(session.id);
  }

  /**
   * 音声以外の入力を正規化して取り込む(DATAFLOW.md「入力アダプタ」)。
   *
   * 新しい入力元を足すときに変更してよいのはこのメソッドまで。
   * 後段のAgentは、入力が音声だったか手入力だったかを区別しない。
   */
  async input(
    session: Session,
    input: { source: InputSource; payload: string; target?: string; speaker?: string },
  ): Promise<{ normalizedTo: DocumentName }> {
    const target = this.#resolveTarget(input.source, input.target);

    if (target === "transcript.md") {
      await this.store.append(
        session.id,
        target,
        renderTranscriptEntry({
          // 入力した時刻で追記する。文字起こしの確定が遅れていると、
          // 直前の行より古い時刻になりうる。並び順は到着順であって時刻順ではない
          // (DATAFLOW.md の入力アダプタ)。差分処理はカーソルで進むため問題ない。
          at: new Date(),
          speaker: input.speaker ?? labelOf(input.source),
          text: input.payload,
        }),
        "input_adapter",
      );
    } else {
      await this.store.replace(session.id, target, input.payload, "input_adapter");
    }

    log.info("documents.input", { sessionId: session.id, source: input.source, target });
    return { normalizedTo: target };
  }

  /** 手入力による全文置換(`PUT /documents/{name}`) */
  async put(session: Session, name: string, text: string): Promise<DocumentInfo> {
    return this.store.replace(session.id, name, text, "input_adapter" satisfies Writer);
  }

  #resolveTarget(source: InputSource, requested: string | undefined): DocumentName {
    if (requested === undefined) return DEFAULT_TARGET[source];
    if (!isDocumentName(requested)) {
      throw new DocumentError("unknown_document", `${requested} は存在しないドキュメントです`);
    }
    return requested;
  }

  async #writeMeeting(session: Session): Promise<void> {
    await this.store.replace(
      session.id,
      "meeting.md",
      renderMeeting({
        sessionId: session.id,
        startedAt: new Date(session.createdAt),
        endedAt: session.endedAt === null ? null : new Date(session.endedAt),
        title: session.title,
        // 参加者はまだ入力経路が無い。Notion / 手入力から入れられるようにするのは Sprint 5 以降
        participants: [],
        status: session.status,
      }),
      "orchestrator",
    );
  }
}

function labelOf(source: InputSource): string {
  switch (source) {
    case "manual":
      return "手入力";
    case "circleback":
      return "Circleback";
    case "notion":
      return "Notion";
  }
}
