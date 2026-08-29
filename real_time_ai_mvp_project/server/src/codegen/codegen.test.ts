import { describe, expect, it } from "vitest";
import { parseFileMap } from "./llmCodeProvider.js";
import { TemplateCodeProvider } from "./templateCodeProvider.js";
import { hasBlock, isSafePath, validate } from "./validate.js";
import type { CodeRequest } from "./types.js";

/**
 * コード生成と検証。ROADMAP.md Sprint 6 の完了条件のうち、
 * 「静的ビルドで通る」「シークレットが含まれていない」を担保する部分。
 */

const REQUIREMENTS = `# Requirements

## 目的
在庫状況を担当者以外も確認できるようにする。

## 対象ユーザー
- 現場担当者(閲覧)

## 機能要件
- FR-1 在庫一覧を表形式で表示する
- FR-2 品目名で絞り込める

## データモデル
- Item: id, name, quantity, unit, updated_at, updated_by

## 画面
- 一覧画面
- 更新モーダル

## 対象外
- 発注機能
`;

const request = (overrides: Partial<CodeRequest> = {}): CodeRequest => ({
  sessionId: `sess_${"0".repeat(32)}`,
  requirements: REQUIREMENTS,
  ui: "# UI\n\n## 画面1: 一覧画面\n- ヘッダー\n",
  instruction: "# AI Instruction\n\n- スタック: 素の HTML / CSS / JavaScript\n",
  review: null,
  ...overrides,
});

describe("雛形からの生成", () => {
  const provider = new TemplateCodeProvider();

  it("エントリと資材が揃う", async () => {
    const files = await provider.generate(request());

    expect(Object.keys(files).sort()).toEqual(["app.js", "index.html", "styles.css"]);
  });

  it("検証を通る", async () => {
    // 既定の生成物が BLOCK を出すようでは、商談中の最終防壁にならない
    expect(validate(await provider.generate(request()))).toEqual([]);
  });

  it("要件定義の題名と項目を反映する", async () => {
    const files = await provider.generate(request());

    expect(files["index.html"]).toContain("在庫状況を担当者以外も確認できるようにする");
    expect(files["index.html"]).toContain("名称");
    expect(files["index.html"]).toContain("数量");
    // id や updated_at は画面に出さず、自動で付ける
    expect(files["index.html"]).not.toContain('name="id"');
  });

  it("ビルド工程を要らない形にする", async () => {
    const files = await provider.generate(request());

    expect(files["index.html"]).toContain('<script src="./app.js">');
    expect(files["app.js"]).not.toContain("import ");
    expect(Object.keys(files)).not.toContain("package.json");
  });

  it("要件定義が空でも生成できる", async () => {
    // 商談が短くて要件が薄いときでも、何かは出す
    const files = await provider.generate(request({ requirements: "# Requirements\n" }));

    expect(validate(files)).toEqual([]);
    expect(files["index.html"]).toContain("<table");
  });

  it("同じ要件からは同じものが出る", async () => {
    const a = await provider.generate(request());
    const b = await provider.generate(request());

    expect(a).toEqual(b);
  });

  it("要件定義の題名をHTMLへ埋め込む際にエスケープする", async () => {
    const files = await provider.generate(
      request({ requirements: "# Requirements\n\n## 目的\n<script>alert(1)</script>を消す\n" }),
    );

    expect(files["index.html"]).not.toContain("<script>alert(1)</script>");
    expect(files["index.html"]).toContain("&lt;script&gt;");
  });
});

/**
 * 要件に応じて形が変わること。
 *
 * 1種類しかないと、2回目の商談で「さっきと同じものが出た」と気づかれ、
 * 「話した内容から作られた」という核の説得力が消える。
 */
describe("要件から形を選ぶ", () => {
  const provider = new TemplateCodeProvider();

  const withPurpose = (purpose: string, features: string[] = []): CodeRequest =>
    request({
      requirements: `# Requirements\n\n## 目的\n${purpose}\n\n## 機能要件\n${features
        .map((feature) => `- ${feature}`)
        .join("\n")}\n\n## データモデル\n- Item: id, name, quantity, unit\n`,
    });

  it("申請と承認の話からは承認フローの画面が出る", async () => {
    const files = await provider.generate(
      withPurpose("備品の申請と承認をシステム化する", ["FR-1 申請を出す", "FR-2 上長が承認・却下する"]),
    );

    expect(files["index.html"]).toContain("申請する");
    expect(files["app.js"]).toContain("approved");
    expect(validate(files)).toEqual([]);
  });

  it("点検の話からはチェックリストの画面が出る", async () => {
    const files = await provider.generate(
      withPurpose("店舗の点検で確認漏れをなくす", ["FR-1 冷蔵庫の温度を確認する", "FR-2 在庫の数を数える"]),
    );

    expect(files["index.html"]).toContain("本日の点検");
    // 会話から起こした機能要件が、そのまま点検項目として並ぶ
    expect(files["app.js"]).toContain("冷蔵庫の温度を確認する");
    expect(validate(files)).toEqual([]);
  });

  it("集計の話からはダッシュボードが出る", async () => {
    const files = await provider.generate(
      withPurpose("部門ごとの件数を可視化して推移を把握する", ["FR-1 合計を集計する"]),
    );

    expect(files["index.html"]).toContain("ごとの内訳");
    expect(files["index.html"]).toContain("合計");
    expect(validate(files)).toEqual([]);
  });

  it("集計軸に名称を選ばない(1件ずつ並ぶだけで内訳にならない)", async () => {
    const files = await provider.generate(
      request({
        requirements:
          "# Requirements\n\n## 目的\n件数を集計して可視化する\n\n## データモデル\n- Item: id, name, quantity, category\n",
      }),
    );

    expect(files["index.html"]).toContain("分類ごとの内訳");
    expect(files["app.js"]).toContain('const GROUP_KEY = "category"');
  });

  it("題名と目的が同じ文なら二度出さない", async () => {
    const files = await provider.generate(
      request({ requirements: "# Requirements\n\n## 目的\n在庫を見える化する\n" }),
    );

    expect(files["index.html"]).not.toContain('class="purpose"');
    expect(files["index.html"]).toContain("在庫を見える化する");
  });

  it("手がかりが無ければ一覧に落ちる(生成を止めない)", async () => {
    const files = await provider.generate(withPurpose("なんとかしたい"));

    expect(files["index.html"]).toContain("<table");
    expect(validate(files)).toEqual([]);
  });

  it("手段の側に語がひとつ紛れただけでは形を変えない", async () => {
    // 台帳を作りたい話に「共有ダッシュボードを用意する」というアイデアが
    // 混ざるのは普通にある。それだけで集計画面へ倒すと要件を読み違える
    const files = await provider.generate(
      withPurpose("在庫を関係者が同じ情報として見られるようにする", [
        "FR-1 共有ダッシュボードを用意する",
        "FR-2 更新時刻と更新者を記録する",
      ]),
    );

    expect(files["index.html"]).toContain("<table");
  });

  it("目的にはっきり出ていれば1語でも倒す", async () => {
    const files = await provider.generate(withPurpose("進捗を可視化したい"));

    expect(files["index.html"]).toContain("ごとの内訳");
  });

  it("どの形でも外部参照を持たない", async () => {
    const cases = [
      withPurpose("申請と承認を回す"),
      withPurpose("点検の確認漏れをなくす"),
      withPurpose("件数を集計して可視化する"),
      withPurpose("台帳を管理する"),
    ];

    for (const input of cases) {
      const files = await provider.generate(input);
      expect(hasBlock(validate(files))).toBe(false);
      expect(files["app.js"]).not.toContain("http");
      expect(Object.keys(files).sort()).toEqual(["app.js", "index.html", "styles.css"]);
    }
  });

  it("同じ要件からは同じ形が出る(実行のたびに入れ替わらない)", async () => {
    const input = withPurpose("申請の承認を早くしつつ、件数も集計したい");
    expect(await provider.generate(input)).toEqual(await provider.generate(input));
  });
});

describe("検証", () => {
  const ok = { "index.html": "<!doctype html><body><script src='./a.js'></script></body>", "a.js": "let x = 1;" };

  it("問題が無ければ空", () => {
    expect(validate(ok)).toEqual([]);
  });

  it("エントリが無ければ BLOCK", () => {
    const findings = validate({ "app.js": "let x = 1;" });

    expect(hasBlock(findings)).toBe(true);
    expect(findings[0]?.message).toContain("index.html");
  });

  it("外部参照を BLOCK にする", () => {
    const findings = validate({
      ...ok,
      "a.js": "fetch('https://api.example.com/items')",
    });

    expect(hasBlock(findings)).toBe(true);
    expect(findings.some((f) => f.message.includes("外部を参照"))).toBe(true);
  });

  it("行コメントを外部参照と間違えない", () => {
    // `// utils.js の説明` のような行を弾くと、まともなコードが通らなくなる
    expect(validate({ ...ok, "a.js": "// app.js を読み込む\nlet x = 1;" })).toEqual([]);
  });

  it("サーバーサイド実行を BLOCK にする", () => {
    for (const body of ["process.env.KEY", "require('fs')", "export const getServerSideProps = 1"]) {
      expect(hasBlock(validate({ ...ok, "a.js": body }))).toBe(true);
    }
  });

  it("シークレットらしき文字列を BLOCK にする", () => {
    const cases = [
      "const key = 'sk-abcdefghijklmnopqrstuvwx';",
      "const id = 'AKIAIOSFODNN7EXAMPLE';",
      'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";',
      'const apiKey = "very-secret-value-here";',
    ];
    for (const body of cases) {
      expect(hasBlock(validate({ ...ok, "a.js": body }))).toBe(true);
    }
  });

  it("配信できないパスを BLOCK にする", () => {
    expect(hasBlock(validate({ ...ok, "../escape.js": "let x = 1;" }))).toBe(true);
    expect(hasBlock(validate({ ...ok, "/etc/passwd": "x" }))).toBe(true);
  });

  it("ファイルが多すぎれば BLOCK", () => {
    const many: Record<string, string> = { ...ok };
    for (let index = 0; index < 40; index += 1) many[`f${index}.js`] = "let x = 1;";

    expect(hasBlock(validate(many))).toBe(true);
  });
});

describe("パスの安全性", () => {
  it("普通の相対パスは通す", () => {
    expect(isSafePath("index.html")).toBe(true);
    expect(isSafePath("assets/app.js")).toBe(true);
  });

  it("外へ出る書き方を拒む", () => {
    for (const name of ["", "/abs", "../up", "a/../../b", "a//b", "C:\\win", "a\u0000b"]) {
      expect(isSafePath(name)).toBe(false);
    }
  });
});

describe("LLM応答の読み取り", () => {
  it("見出しとフェンスからファイルを取り出す", () => {
    const text = [
      "### index.html",
      "```",
      "<!doctype html>",
      "```",
      "",
      "### app.js",
      "```",
      "let x = 1;",
      "```",
    ].join("\n");

    expect(parseFileMap(text)).toEqual({
      "index.html": "<!doctype html>\n",
      "app.js": "let x = 1;\n",
    });
  });

  it("危ないパスは黙って捨てる", () => {
    const text = ["### ../escape.js", "```", "let x = 1;", "```"].join("\n");

    // 捨てた結果 index.html が無くなれば、検証層が BLOCK として拾う
    expect(parseFileMap(text)).toEqual({});
  });

  it("取り出せなければ空", () => {
    expect(parseFileMap("承知しました。作成します。")).toEqual({});
  });

  it("入れ子のフェンスに引きずられない", () => {
    const text = ["### readme.md", "````", "```js", "let x = 1;", "```", "````"].join("\n");

    expect(parseFileMap(text)["readme.md"]).toBe("```js\nlet x = 1;\n```\n");
  });
});
