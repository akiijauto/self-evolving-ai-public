import { log } from "../log.js";
import type { CodeProvider, CodeRequest, FileMap } from "./types.js";
import { renderApproval } from "./templates/approval.js";
import { renderChecklist } from "./templates/checklist.js";
import { renderCss } from "./templates/css.js";
import { renderDashboard } from "./templates/dashboard.js";
import { renderList } from "./templates/list.js";
import { detectShape, type Shape } from "./templates/shape.js";
import { readSpec, type Spec } from "./templates/spec.js";

/**
 * 要件定義から、決まった雛形で静的アプリを組み立てる実装(既定)。
 *
 * 推論はしない。`requirements.md` から**題名・機能要件・データモデル・画面**を読み、
 * 要件に合う形を選んで流し込む。
 *
 * これがある意味:
 * - **資格情報なしで「URLが出るところまで」通せる**
 * - 商談で実APIが落ちていても、少なくとも動くものは出る(縮退動作の最終防壁)
 *
 * 形を複数持つのは、**どんな商談でも同じ画面が出てくるのを避ける**ため。
 * 1種類しかないと、2回目の商談で「さっきと同じものが出た」と気づかれ、
 * 「話した内容から作られた」という核の説得力が消える。
 *
 * 生成物はビルド工程を持たない。`index.html` をそのまま開けば動く。
 */

const RENDERERS: Record<Shape, (spec: Spec) => { html: string; js: string }> = {
  list: renderList,
  approval: renderApproval,
  checklist: renderChecklist,
  dashboard: renderDashboard,
};

export class TemplateCodeProvider implements CodeProvider {
  async generate(req: CodeRequest): Promise<FileMap> {
    const spec = readSpec(req.requirements);
    const shape = detectShape(spec);

    // どの形が選ばれたかは後から追えるようにする。
    // 商談で「なぜこの画面になったのか」を振り返る手がかりになる
    log.info("codegen.shape", { sessionId: req.sessionId, shape, title: spec.title });

    const { html, js } = RENDERERS[shape](spec);
    return {
      "index.html": html,
      "app.js": js,
      "styles.css": renderCss(),
    };
  }
}
