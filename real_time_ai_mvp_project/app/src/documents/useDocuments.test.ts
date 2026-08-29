import { describe, expect, it } from "vitest";
import { fetchStale } from "./useDocuments";

/**
 * 実機で起きた無限再取得ループの回帰テスト。
 *
 * effect の作り直しで取得が「中断」されたとき、完了済みの結果まで捨てると、
 * 「開始 → 描画 → 中断 → 再取得」が自走する。応答が速いローカルでは
 * 成立しないため、ロジック単体で確かめる。
 */

/** 手動で解決できるPromiseを作る */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("fetchStale", () => {
  it("中断されても、完了した取得は記録する(無限ループの再発防止)", async () => {
    const recorded: string[] = [];
    let cancelled = false;
    const gate = deferred<string | null>();

    const run = fetchStale(
      [["ideas.md", "t1"]],
      () => gate.promise,
      () => cancelled,
      (name) => recorded.push(name),
    );

    // 取得が飛んでいる間に中断される(= effect が作り直された)
    cancelled = true;
    gate.resolve("# Ideas");
    await run;

    // 結果は捨てない。捨てると同じ版を次の実行がまた取りにいく
    expect(recorded).toEqual(["ideas.md"]);
  });

  it("中断後は新しい取得を始めない", async () => {
    const requested: string[] = [];
    let cancelled = false;

    await fetchStale(
      [
        ["issues.md", "t1"],
        ["ideas.md", "t1"],
      ],
      (name) => {
        requested.push(name);
        cancelled = true; // 1件目の取得中に中断された
        return Promise.resolve("本文");
      },
      () => cancelled,
      () => undefined,
    );

    expect(requested).toEqual(["issues.md"]);
  });

  it("1件の失敗で残りを止めず、失敗があったことを返す", async () => {
    const recorded: string[] = [];

    const failed = await fetchStale(
      [
        ["issues.md", "t1"],
        ["ideas.md", "t1"],
      ],
      (name) =>
        name === "issues.md" ? Promise.reject(new Error("網が切れた")) : Promise.resolve("本文"),
      () => false,
      (name) => recorded.push(name),
    );

    expect(failed).toBe(true);
    // 失敗した版は記録されず(次で取り直す)、成功した版は記録される
    expect(recorded).toEqual(["ideas.md"]);
  });

  it("404(まだ無い)は失敗ではなく、版だけ記録される", async () => {
    const recorded: [string, string | null][] = [];

    const failed = await fetchStale(
      [["summary.md", "t1"]],
      () => Promise.resolve(null),
      () => false,
      (name, _updatedAt, text) => recorded.push([name, text]),
    );

    expect(failed).toBe(false);
    expect(recorded).toEqual([["summary.md", null]]);
  });
});
