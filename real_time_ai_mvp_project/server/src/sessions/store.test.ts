import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore, statsOf, viewOf } from "./store";

describe("SessionStore", () => {
  let now = 1_000_000;
  let store: SessionStore;

  beforeEach(() => {
    now = 1_000_000;
    store = new SessionStore({ ttlMs: 60_000, now: () => now });
  });

  describe("作成", () => {
    it("id と token を発行し、active で始まる", () => {
      const session = store.create({});
      expect(session.id).toMatch(/^sess_[0-9a-f]{32}$/);
      expect(session.status).toBe("active");
      expect(session.expiresAt).toBe(now + 60_000);
    });

    it("トークンは推測困難な長さを持つ", () => {
      const session = store.create({});
      expect(session.token.length).toBeGreaterThanOrEqual(43);
    });

    it("セッションごとに token が異なる", () => {
      expect(store.create({}).token).not.toBe(store.create({}).token);
    });
  });

  describe("トークン検証", () => {
    it("正しいトークンなら ok", () => {
      const session = store.create({});
      expect(store.verify(session.id, session.token)).toBe("ok");
    });

    it("不正なトークンは unauthorized(→ 4401)", () => {
      const session = store.create({});
      expect(store.verify(session.id, "wrong")).toBe("unauthorized");
    });

    it("トークン未指定は unauthorized", () => {
      const session = store.create({});
      expect(store.verify(session.id, null)).toBe("unauthorized");
    });

    it("存在しないセッションは not_found(→ 4404)", () => {
      expect(store.verify("sess_missing", "x")).toBe("not_found");
    });

    it("期限切れは unauthorized", () => {
      const session = store.create({});
      now += 60_001;
      expect(store.verify(session.id, session.token)).toBe("unauthorized");
    });

    it("終了済みは ended(→ 4409)", () => {
      const session = store.create({});
      store.end(session.id, "button");
      expect(store.verify(session.id, session.token)).toBe("ended");
    });

    it("長さの違うトークンで例外を投げない", () => {
      const session = store.create({});
      expect(() => store.verify(session.id, "short")).not.toThrow();
      expect(store.verify(session.id, session.token + "extra")).toBe("unauthorized");
    });
  });

  describe("終了", () => {
    it("理由と時刻を記録する", () => {
      const session = store.create({});
      now += 5_000;
      const ended = store.end(session.id, "silence");
      expect(ended?.status).toBe("ended");
      expect(ended?.endReason).toBe("silence");
      expect(ended?.endedAt).toBe(now);
    });

    it("二重終了で理由が上書きされない", () => {
      const session = store.create({});
      store.end(session.id, "button");
      store.end(session.id, "silence");
      expect(store.get(session.id)?.endReason).toBe("button");
    });
  });

  describe("実行中の件数", () => {
    // 更新スクリプトが「商談中は更新しない」の判定に使う。
    // size で判定すると、終了済みが30日残るため二度と更新できなくなる
    it("終了した商談は数えない", () => {
      const first = store.create({});
      store.create({});
      expect(store.activeCount).toBe(2);

      store.end(first.id, "button");
      expect(store.activeCount).toBe(1);
      // 保持は続く。持ち帰りのためにトークンは生きている
      expect(store.size).toBe(2);
    });

    it("全部終わっていれば0", () => {
      const session = store.create({});
      store.end(session.id, "button");
      expect(store.activeCount).toBe(0);
      expect(store.size).toBe(1);
    });
  });

  describe("音声チャンクの記録", () => {
    it("件数とバイト数を累積する", () => {
      const session = store.create({});
      store.recordChunk(session.id, 100);
      const stats = store.recordChunk(session.id, 250);
      expect(stats).toEqual({
        chunks: 2,
        bytes: 350,
        lastChunkAt: new Date(now).toISOString(),
      });
    });

    it("存在しないセッションでは undefined", () => {
      expect(store.recordChunk("sess_missing", 10)).toBeUndefined();
    });

    it("未受信なら lastChunkAt は null", () => {
      const session = store.create({});
      expect(statsOf(session).lastChunkAt).toBeNull();
    });
  });

  describe("掃除", () => {
    it("終了から一定時間経ったものを消す", () => {
      const session = store.create({});
      store.end(session.id, "button");
      now += 10_000;
      expect(store.sweep(5_000)).toEqual([session.id]);
      expect(store.size).toBe(0);
    });

    it("終了直後は消さない", () => {
      const session = store.create({});
      store.end(session.id, "button");
      expect(store.sweep(5_000)).toEqual([]);
    });

    it("期限切れのまま放置されたものを消す", () => {
      const session = store.create({});
      now += 60_000 + 5_001;
      expect(store.sweep(5_000)).toEqual([session.id]);
    });

    it("有効なセッションは残す", () => {
      store.create({});
      expect(store.sweep(5_000)).toEqual([]);
      expect(store.size).toBe(1);
    });
  });

  describe("表示用の変換", () => {
    it("トークンを含めない(漏洩防止)", () => {
      const session = store.create({ title: "テスト商談" });
      const view = viewOf(session);
      expect(JSON.stringify(view)).not.toContain(session.token);
      expect(view.title).toBe("テスト商談");
      expect(view.artifacts).toEqual([]);
    });
  });

  describe("永続化(persistDir)", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "rt-mvp-sess-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("再起動をまたいでもトークンで検証できる", () => {
      const first = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      const session = first.create({ title: "商談A" });
      first.end(session.id, "button");

      // 新しいインスタンス = 再起動後のプロセス
      const second = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      expect(second.verify(session.id, session.token, { allowEnded: true })).toBe("ok");
      expect(second.get(session.id)?.title).toBe("商談A");
      expect(second.get(session.id)?.endReason).toBe("button");
    });

    it("実行中に落ちたセッションは server_restart で終了扱いになる", () => {
      const first = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      const session = first.create({});

      const second = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      const recovered = second.get(session.id);
      expect(recovered?.status).toBe("ended");
      expect(recovered?.endReason).toBe("server_restart");
      // 終了扱いでもMarkdownの読み出しはできる(allowEnded)
      expect(second.verify(session.id, session.token, { allowEnded: true })).toBe("ok");
      expect(second.verify(session.id, session.token)).toBe("ended");
    });

    it("壊れたファイルは飛ばして起動する", async () => {
      const first = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      const session = first.create({});
      await writeFile(join(dir, "sess_" + "0".repeat(32) + ".json"), "{壊れている", "utf8");

      const second = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      expect(second.size).toBe(1);
      expect(second.get(session.id)).toBeDefined();
    });

    it("掃除でファイルも消える", async () => {
      const first = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      const session = first.create({});
      first.end(session.id, "button");
      now += 10_000;
      expect(first.sweep(5_000)).toEqual([session.id]);

      const entries = await readdir(dir);
      expect(entries.filter((name) => name.endsWith(".json"))).toEqual([]);
    });

    // Windows は POSIX の権限ビットを持たないため、本番と同じ Linux でだけ検証する
    it.skipIf(process.platform === "win32")("保存したファイルは本人しか読めない", async () => {
      // トークンが平文で入る。既定のumask(022)だと0644になり、
      // 既にサイトが同居しているサーバーでは他ユーザーから読める
      const store = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      const session = store.create({});

      const file = await stat(join(dir, `${session.id}.json`));
      expect(file.mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    });

    it("プレビュー用トークンは操作用と別の値で、用途を跨がない", async () => {
      const store = new SessionStore({ ttlMs: 60_000, now: () => now });
      const session = store.create({});

      expect(session.previewToken).not.toBe(session.token);
      // 操作用でプレビューは開けない
      expect(store.verify(session.id, session.token, { purpose: "preview" })).toBe("unauthorized");
      // プレビュー用でAPIは通らない
      expect(store.verify(session.id, session.previewToken)).toBe("unauthorized");
      // それぞれ本来の用途では通る
      expect(store.verify(session.id, session.token)).toBe("ok");
      expect(store.verify(session.id, session.previewToken, { purpose: "preview" })).toBe("ok");
    });

    it("分離前に保存されたセッションは、操作用を流用せずプレビューだけ通さない", async () => {
      // 古い形式には previewToken が無い。操作用で埋めると分離した意味が消える
      const old = {
        id: `sess_${"b".repeat(32)}`,
        token: "operate-token",
        title: null,
        clientInfo: null,
        status: "ended",
        createdAt: now,
        expiresAt: now + 60_000,
        endedAt: now,
        endReason: "button",
        audioFormat: null,
        paused: false,
        chunks: 0,
        bytes: 0,
        lastChunkAt: null,
        connectionId: null,
      };
      await writeFile(join(dir, `${old.id}.json`), JSON.stringify(old), "utf8");

      const store = new SessionStore({ ttlMs: 60_000, now: () => now, persistDir: dir });
      const revived = store.get(old.id);
      expect(revived?.previewToken).not.toBe("operate-token");
      // Markdownの閲覧と持ち帰りは続けられる
      expect(store.verify(old.id, "operate-token", { allowEnded: true })).toBe("ok");
      expect(store.verify(old.id, "operate-token", { allowEnded: true, purpose: "preview" })).toBe(
        "unauthorized",
      );
    });

    it("persistDir 無しではファイルを作らない(既定の挙動が変わらない)", async () => {
      const memory = new SessionStore({ ttlMs: 60_000, now: () => now });
      memory.create({});
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
