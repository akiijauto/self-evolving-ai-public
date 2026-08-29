import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@rt-mvp/protocol";
import type { Session } from "../sessions/store.js";
import { MarkdownStore } from "./store.js";
import { SessionDocuments } from "./sessionDocuments.js";

/**
 * transcript.md への追記の再送(REQUIREMENTS.md「文字起こしは失わない」)。
 *
 * ディスクの一時的な不調で1発言が消えると、議事録も要件も
 * その発言を知らないまま進む。追記は粘り、粘っても駄目なら
 * seq の関門を戻して再送に賭ける。
 */

let dataDir: string;
let store: MarkdownStore;
let docs: SessionDocuments;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "rt-mvp-docs-"));
  store = new MarkdownStore({ dataDir });
  docs = new SessionDocuments(store);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function makeSession(): Session {
  return {
    id: `sess_${"a".repeat(32)}`,
    token: "t",
    previewToken: "p",
    title: null,
    clientInfo: null,
    status: "active",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    endedAt: null,
    endReason: null,
    audioFormat: null,
    paused: false,
    chunks: 0,
    bytes: 0,
    lastChunkAt: null,
    connectionId: null,
  };
}

function segment(seq: number, text: string): TranscriptSegment {
  return { seq, text, speaker: "A", startMs: seq * 1_000, endMs: seq * 1_000 + 800, at: new Date().toISOString() };
}

describe("appendTranscript の再送", () => {
  it("一時的な失敗なら追試して書き切る", async () => {
    const session = makeSession();
    const original = store.append.bind(store);
    let failures = 2;
    vi.spyOn(store, "append").mockImplementation(async (id, name, text, writer) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("ENOSPC: 模擬的なディスク不調");
      }
      return original(id, name, text, writer);
    });

    await expect(docs.appendTranscript(session, segment(1, "在庫の話"))).resolves.toBe(true);
    expect(await store.read(session.id, "transcript.md")).toContain("在庫の話");
  });

  it("粘っても駄目なら seq の関門を戻し、再送で書ける", async () => {
    const session = makeSession();
    const original = store.append.bind(store);
    let broken = true;
    vi.spyOn(store, "append").mockImplementation(async (id, name, text, writer) => {
      if (broken) throw new Error("ENOSPC: 模擬的なディスク不調");
      return original(id, name, text, writer);
    });

    await expect(docs.appendTranscript(session, segment(1, "消えてはいけない発言"))).rejects.toThrow();

    // ディスクが復旧し、上流が同じ確定分を再送してきた
    broken = false;
    await expect(docs.appendTranscript(session, segment(1, "消えてはいけない発言"))).resolves.toBe(true);
    expect(await store.read(session.id, "transcript.md")).toContain("消えてはいけない発言");
  });

  it("書き込み済みの seq は二重追記しない(従来の関門は保つ)", async () => {
    const session = makeSession();
    await docs.appendTranscript(session, segment(1, "一度だけ"));
    await expect(docs.appendTranscript(session, segment(1, "一度だけ"))).resolves.toBe(false);

    const text = await store.read(session.id, "transcript.md");
    expect(text?.match(/一度だけ/g)).toHaveLength(1);
  });
});
