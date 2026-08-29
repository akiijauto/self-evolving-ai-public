import type { Spec } from "./spec.js";

/**
 * 要件から「どういう形のアプリか」を選ぶ。
 *
 * 雛形が一覧画面1種類しかないと、**どんな商談でも同じ画面が出てくる。**
 * 2回目の商談で見せたときに「さっきと同じものが出た」と気づかれ、
 * 「話した内容から作られた」という核の説得力が消える(RETROSPECTIVE.md の未解決の論点)。
 *
 * 判定はキーワードで行う。**LLMには聞かない** —
 * 商談中に1往復増やす価値がなく、外したときに何が起きたか追えなくなる。
 * 外しても「一覧」に落ちるだけで、生成そのものは必ず成功する。
 */
export type Shape = "list" | "approval" | "checklist" | "dashboard";

/** 形ごとの手がかり。要件の語彙に現れるものを並べる */
const HINTS: Record<Exclude<Shape, "list">, string[]> = {
  approval: [
    "申請", "承認", "却下", "稟議", "決裁", "許可", "依頼", "受付", "審査", "差し戻",
  ],
  checklist: [
    "点検", "チェック", "確認漏れ", "巡回", "洗い出し", "抜け漏れ", "実施済", "完了確認", "手順",
  ],
  dashboard: [
    "集計", "可視化", "見える化", "ダッシュボード", "推移", "件数", "合計", "把握", "分析", "指標",
  ],
};

/**
 * 目的に出た語は機能要件の2倍に数える。
 *
 * 目的は「何がしたいのか」の要約で、機能要件は手段の羅列。
 * 「在庫台帳を作りたい。ついでに共有ダッシュボードがあるとよい」のように、
 * 手段の側に他の形の語が紛れることは普通にある。
 */
const PURPOSE_WEIGHT = 2;

/**
 * 一覧以外へ倒すのに必要な点数。
 *
 * **語がひとつ紛れただけで形が変わってはいけない。** 要件を読み違えた画面が出ると、
 * 「話した内容から作られた」どころか「話を聞いていない」という印象になる。
 * 目的にはっきり出ている(重み2)か、手段の側で2回以上出ている場合だけ倒す。
 */
const MIN_SCORE = 2;

/**
 * 形を決める。手がかりの多い形を採り、決め手が無ければ一覧。
 *
 * 見るのは目的・機能要件・画面。データモデルは見ない
 * (項目名はどの形でも似た語になり、判定の材料にならない)。
 */
export function detectShape(spec: Spec): Shape {
  const means = [...spec.features, ...spec.screens].join(" ");

  let best: Shape = "list";
  let bestScore = 0;

  for (const [shape, hints] of Object.entries(HINTS) as [Exclude<Shape, "list">, string[]][]) {
    const score = hints.reduce(
      (sum, hint) =>
        sum + (spec.purpose.includes(hint) ? PURPOSE_WEIGHT : 0) + (means.includes(hint) ? 1 : 0),
      0,
    );
    // 同点なら先に見た形を残す。実行のたびに形が入れ替わらないようにする
    if (score > bestScore) {
      best = shape;
      bestScore = score;
    }
  }

  return bestScore >= MIN_SCORE ? best : "list";
}
