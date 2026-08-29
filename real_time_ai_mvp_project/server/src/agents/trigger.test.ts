import { describe, expect, it } from "vitest";
import { detectTrigger, TriggerDetector } from "./trigger.js";

/**
 * トリガーキーワードの検出。
 *
 * 拾いすぎても確認UIが1つ出るだけで商談は止まらないが、
 * 取りこぼすと「話しているだけで試作品ができる」体験が成立しない。
 */

describe("拾うべき言い回し", () => {
  const samples = [
    "じゃあ、この内容でアプリ作ってみましょうか",
    "アプリをつくってもらえますか",
    "これ作ってみて",
    "試作品を作ってほしい",
    "プロトタイプ作ってみせて",
    "デモを作ってください",
    "その画面を作って",
    "動くものを作って見せてほしい",
    "いったん形にしてみましょう",
  ];

  for (const sample of samples) {
    it(sample, () => {
      expect(detectTrigger(sample)).not.toBeNull();
    });
  }

  it("助詞の有無で外さない", () => {
    expect(detectTrigger("アプリを作って")).toBe(detectTrigger("アプリ作って"));
  });

  it("句読点が混ざっても拾う", () => {
    expect(detectTrigger("では、アプリ、作ってみますか。")).not.toBeNull();
  });
});

describe("拾わない発話", () => {
  const samples = [
    "在庫の管理はどうされていますか",
    "毎朝1回、Excelを更新しています",
    "担当者しか触れない状態です",
    "御社のアプリは何本くらいありますか",
    "資料を送っていただけますか",
  ];

  for (const sample of samples) {
    it(sample, () => {
      expect(detectTrigger(sample)).toBeNull();
    });
  }
});

describe("戻り値", () => {
  it("一致した言い回しを返す(確認UIに出すため)", () => {
    expect(detectTrigger("この内容でアプリ作ってください")).toBe("アプリ作って");
  });

  it("空文字は null", () => {
    expect(detectTrigger("")).toBeNull();
  });
});

describe("TriggerDetector(文の分割をまたぐ検出)", () => {
  it("2つの確定文に割れた合図を拾う", () => {
    const detector = new TriggerDetector();
    expect(detector.feed("この内容でアプリを")).toBeNull();
    expect(detector.feed("作ってみましょう")).toBe("アプリ作って");
  });

  it("1文に収まっていれば従来どおり拾う", () => {
    const detector = new TriggerDetector();
    expect(detector.feed("この内容でアプリを作ってみましょう")).toBe("アプリ作って");
  });

  it("検出後は数え直す。直後の文だけで再検出しない", () => {
    const detector = new TriggerDetector();
    detector.feed("この内容でアプリを作ってみましょう");
    expect(detector.feed("はい")).toBeNull();
  });

  it("離れた文どうしの偶然の結合は保持数の外に出て拾わない", () => {
    const detector = new TriggerDetector();
    expect(detector.feed("アプリ")).toBeNull();
    expect(detector.feed("在庫の話です")).toBeNull();
    expect(detector.feed("担当者が休むと困ります")).toBeNull();
    expect(detector.feed("そうなんです")).toBeNull();
    // 最初の「アプリ」は窓の外。「作って」単独では拾わない
    expect(detector.feed("作って直せますか")).toBeNull();
  });
});
