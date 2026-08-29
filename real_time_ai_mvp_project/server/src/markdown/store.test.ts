import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWrite } from "./documents.js";
import { DocumentError, MarkdownStore } from "./store.js";

/**
 * Markdown Store の検証。実際にファイルを書いて確かめる。
 * ROADMAP.md Sprint 4 の完了条件のうち、保存層で担保するものを網羅する。
 */

const SESSION = "sess_0123456789abcdef0123456789abcdef";
const OTHER = "sess_fedcba9876543210fedcba9876543210";

let dataDir: string;
let store: MarkdownStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "rt-mvp-md-"));
  store = new MarkdownStore({ dataDir });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("書き込みの可否(AGENTS.md のファイル所有者表)", () => {
  it("所有者は書ける", () => {
    expect(checkWrite("issues.md", "issue_agent", "replace")).toBe("ok");
    expect(checkWrite("requirements.md", "requirement_agent", "replace")).toBe("ok");
    expect(checkWrite("transcript.md", "speech_agent", "append")).toBe("ok");
  });

  it("所有者以外は書けない", () => {
    expect(checkWrite("issues.md", "requirement_agent", "replace")).toBe("not_owner");
    expect(checkWrite("transcript.md", "issue_agent", "append")).toBe("not_owner");
    expect(checkWrite("context.md", "orchestrator", "replace")).toBe("not_owner");
  });

  it("入力アダプタだけは所有者でなくても通す", () => {
    // 音声以外の入力を正規化する層。DATAFLOW.md の「入力アダプタ」
    expect(checkWrite("context.md", "input_adapter", "replace")).toBe("ok");
    expect(checkWrite("transcript.md", "input_adapter", "append")).toBe("ok");
  });

  it("追記専用ファイルは全文置換できない", () => {
    expect(checkWrite("transcript.md", "speech_agent", "replace")).toBe("append_only");
    expect(checkWrite("transcript.md", "input_adapter", "replace")).toBe("append_only");
  });

  it("全文置換ファイルへは追記できない", () => {
    expect(checkWrite("requirements.md", "requirement_agent", "append")).toBe("replace_only");
  });

  it("登録簿に無い名前は拒む", () => {
    expect(checkWrite("secrets.md", "orchestrator", "replace")).toBe("unknown_document");
    expect(checkWrite("../../etc/passwd", "orchestrator", "replace")).toBe("unknown_document");
  });
});

describe("読み書き", () => {
  it("書いたものを読める", async () => {
    await store.replace(SESSION, "requirements.md", "# Requirements\n\n## 目的\n在庫の可視化", "requirement_agent");

    expect(await store.read(SESSION, "requirements.md")).toBe("# Requirements\n\n## 目的\n在庫の可視化\n");
  });

  it("末尾を必ず改行で終わらせる", async () => {
    await store.replace(SESSION, "issues.md", "# Issues", "issue_agent");

    expect(await store.read(SESSION, "issues.md")).toBe("# Issues\n");
  });

  it("無いものは null", async () => {
    expect(await store.read(SESSION, "summary.md")).toBeNull();
  });

  it("登録簿に無い名前は読めない", async () => {
    expect(await store.read(SESSION, "../../../etc/passwd")).toBeNull();
  });

  it("セッションIDの形を検証する", async () => {
    await expect(store.read("../../etc", "meeting.md")).rejects.toThrow(/不正なセッションID/);
  });

  it("所有者以外の書き込みは DocumentError", async () => {
    await expect(store.replace(SESSION, "issues.md", "x", "ui_agent")).rejects.toBeInstanceOf(
      DocumentError,
    );
  });

  it("セッションごとに分かれる", async () => {
    await store.replace(SESSION, "issues.md", "# Issues\nA", "issue_agent");
    await store.replace(OTHER, "issues.md", "# Issues\nB", "issue_agent");

    expect(await store.read(SESSION, "issues.md")).toContain("A");
    expect(await store.read(OTHER, "issues.md")).toContain("B");
  });
});

describe("追記", () => {
  it("ファイルが無ければ見出しから始める", async () => {
    await store.append(SESSION, "transcript.md", "\n## 09:00:12 | A\nこんにちは\n", "speech_agent");

    expect(await store.read(SESSION, "transcript.md")).toBe(
      "# Realtime Transcript\n\n## 09:00:12 | A\nこんにちは\n",
    );
  });

  it("既存行を書き換えない", async () => {
    await store.append(SESSION, "transcript.md", "\n## 09:00:12 | A\n1つめ\n", "speech_agent");
    const first = await store.read(SESSION, "transcript.md");

    await store.append(SESSION, "transcript.md", "\n## 09:00:35 | B\n2つめ\n", "speech_agent");
    const second = await store.read(SESSION, "transcript.md");

    expect(second?.startsWith(first ?? "")).toBe(true);
    expect(second).toContain("1つめ");
    expect(second).toContain("2つめ");
  });

  it("同時に追記しても混ざらない", async () => {
    // セッション単位で直列化しているため、途中で切れた行は生まれない
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append(SESSION, "transcript.md", `\n## 09:00:${String(index).padStart(2, "0")}\n行${index}\n`, "speech_agent"),
      ),
    );

    const text = (await store.read(SESSION, "transcript.md")) ?? "";
    for (let index = 0; index < 20; index += 1) {
      expect(text).toContain(`行${index}\n`);
    }
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(20);
  });
});

describe("アトミックな全文置換", () => {
  it("一時ファイルを残さない", async () => {
    await store.replace(SESSION, "ui.md", "# UI\n画面1", "ui_agent");
    await store.replace(SESSION, "ui.md", "# UI\n画面2", "ui_agent");

    const entries = await readdir(store.dirOf(SESSION));
    expect(entries).toEqual(["ui.md"]);
  });

  it("置換前の内容が中途半端に残らない", async () => {
    await store.replace(SESSION, "ideas.md", "# Ideas\n" + "長い内容\n".repeat(500), "issue_agent");
    await store.replace(SESSION, "ideas.md", "# Ideas\n短い\n", "issue_agent");

    expect(await store.read(SESSION, "ideas.md")).toBe("# Ideas\n短い\n");
  });
});

describe("一覧", () => {
  it("名前・更新時刻・バイト数を返す", async () => {
    await store.replace(SESSION, "meeting.md", "# Meeting\n", "orchestrator");
    await store.append(SESSION, "transcript.md", "", "speech_agent");

    const documents = await store.list(SESSION);

    expect(documents.map((d) => d.name)).toEqual(["meeting.md", "transcript.md"]);
    expect(documents[0]?.size).toBe(Buffer.byteLength("# Meeting\n"));
    expect(documents[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("登録簿に無いファイルは出さない", async () => {
    await store.ensure(SESSION);
    await writeFile(join(store.dirOf(SESSION), "notes.txt"), "手で置いたもの");

    expect(await store.list(SESSION)).toEqual([]);
  });

  it("セッションが無ければ空", async () => {
    expect(await store.list(SESSION)).toEqual([]);
  });
});

describe("差分処理のカーソル", () => {
  it("初回は全文が未処理", async () => {
    await store.append(SESSION, "transcript.md", "\n## 09:00:12\nこんにちは\n", "speech_agent");

    const { text, cursor } = await store.readUnprocessed(SESSION, "transcript.md");

    expect(text).toContain("こんにちは");
    expect(cursor).toBe(Buffer.byteLength(text));
  });

  it("進めた分は次から出ない", async () => {
    await store.append(SESSION, "transcript.md", "\n## 09:00:12\n1つめ\n", "speech_agent");
    const first = await store.readUnprocessed(SESSION, "transcript.md");
    store.advanceCursor(SESSION, "transcript.md", first.cursor);

    await store.append(SESSION, "transcript.md", "\n## 09:00:35\n2つめ\n", "speech_agent");
    const second = await store.readUnprocessed(SESSION, "transcript.md");

    expect(second.text).not.toContain("1つめ");
    expect(second.text).toContain("2つめ");
  });

  it("失敗して進めなければ、同じ範囲を再度返す", async () => {
    // AGENTS.md の Issue Agent「失敗時は処理済み位置を進めない」
    await store.append(SESSION, "transcript.md", "\n## 09:00:12\n1つめ\n", "speech_agent");

    const first = await store.readUnprocessed(SESSION, "transcript.md");
    const retry = await store.readUnprocessed(SESSION, "transcript.md");

    expect(retry.text).toBe(first.text);
  });

  it("戻す方向には動かない", async () => {
    await store.append(SESSION, "transcript.md", "\n## 09:00:12\n1つめ\n", "speech_agent");
    const { cursor } = await store.readUnprocessed(SESSION, "transcript.md");

    store.advanceCursor(SESSION, "transcript.md", cursor);
    store.advanceCursor(SESSION, "transcript.md", 0);

    expect(store.cursorOf(SESSION, "transcript.md")).toBe(cursor);
  });

  it("日本語の途中で切れない", async () => {
    await store.append(SESSION, "transcript.md", "\n## 09:00:12\nあいうえお\n", "speech_agent");
    const first = await store.readUnprocessed(SESSION, "transcript.md");
    store.advanceCursor(SESSION, "transcript.md", first.cursor);
    await store.append(SESSION, "transcript.md", "\n## 09:00:35\nかきくけこ\n", "speech_agent");

    const second = await store.readUnprocessed(SESSION, "transcript.md");

    expect(second.text).toBe("\n## 09:00:35\nかきくけこ\n");
    expect(second.text).not.toContain("�");
  });

  it("ファイルが無ければ空", async () => {
    expect(await store.readUnprocessed(SESSION, "issues.md")).toEqual({ text: "", cursor: 0 });
  });
});

describe("保持期間切れの削除", () => {
  it("ディレクトリごと消し、カーソルも捨てる", async () => {
    await store.append(SESSION, "transcript.md", "\n## 09:00:12\nこんにちは\n", "speech_agent");
    store.advanceCursor(SESSION, "transcript.md", 10);

    await store.remove(SESSION);

    expect(await store.list(SESSION)).toEqual([]);
    expect(store.cursorOf(SESSION, "transcript.md")).toBe(0);
    await expect(readFile(join(store.dirOf(SESSION), "transcript.md"))).rejects.toThrow();
  });

  it("他のセッションは残す", async () => {
    await store.replace(SESSION, "issues.md", "# Issues\nA", "issue_agent");
    await store.replace(OTHER, "issues.md", "# Issues\nB", "issue_agent");

    await store.remove(SESSION);

    expect(await store.read(OTHER, "issues.md")).toContain("B");
  });
});
