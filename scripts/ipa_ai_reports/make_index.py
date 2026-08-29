#!/usr/bin/env python3
"""catalog.json から一覧 (data/ipa-ai-reports/INDEX.md) を生成する。"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "ipa-ai-reports"

CATEGORY_LABEL = {
    "ai-hakusho": "AI白書（IPA刊）",
    "ai-portal": "IPA AIポータル掲載資料",
    "ai-security": "AIセキュリティ（豆知識・短信）",
    "ai-workshop": "AI共生型社会実現促進ワークショップ",
    "ai-guideline": "AI事業者ガイドライン検討会 資料",
    "aisi": "AIセーフティ・インスティテュート（aisi.go.jp）",
    "chousa": "調査報告",
    "dx-hakusho": "DX白書",
    "dx-trend": "DX動向・ディスカッションペーパー",
    "guideline": "生成AI導入・運用ガイドライン等",
    "ny-dayori": "ニューヨークだより（AI回）",
    "software-engineering": "ソフトウェアエンジニアリング／AI時代のルール",
    "technicalwatch": "IPAテクニカルウォッチ",
    "other": "その他",
}


def main():
    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    md_dir = DATA / "markdown"

    lines = [
        "# IPA AI関連レポート 収集一覧",
        "",
        f"IPA（独立行政法人 情報処理推進機構）が公開している AI 関連の"
        f"レポート・ガイド・白書 **{len(catalog)}件** を収集し、"
        f"文字起こしと Markdown 化を行ったもの。",
        "",
        "| 列 | 内容 |",
        "| --- | --- |",
        "| PDF | 配布元の PDF（`scripts/ipa_ai_reports/download.py` で取得） |",
        "| 文字起こし | `text/<id>.txt` — pdftotext / OCR による生テキスト |",
        "| 全文MD | `transcript/<id>.md` — 文字起こしをページ単位で Markdown 化 |",
        "| 整理MD | `markdown/<id>.md` — 構成・要点を整理した読み物版 |",
        "",
    ]

    def md_kind(entry):
        """整理MD の種別を返す: 要約(Opus整形) / 抽出(自動生成) / なし。"""
        path = md_dir / f"{entry['id']}.md"
        if not path.exists():
            return None
        head = path.read_text(encoding="utf-8", errors="replace")[:600]
        return "auto" if 'generated: "auto"' in head else "opus"

    kinds = {e["id"]: md_kind(e) for e in catalog}
    total_pages = sum(e.get("pages", 0) for e in catalog)
    total_chars = sum(e.get("chars", 0) for e in catalog)
    n_opus = sum(1 for v in kinds.values() if v == "opus")
    n_auto = sum(1 for v in kinds.values() if v == "auto")
    lines += [
        f"- 総ページ数: {total_pages:,} ページ",
        f"- 文字起こし総文字数: {total_chars:,} 字",
        f"- 整理MD: {n_opus + n_auto} / {len(catalog)} 件"
        f"（要約整形 {n_opus} 件 / 自動抽出 {n_auto} 件）",
        "",
        "整理MD の「要約」は資料を読み込んで構成・要点をまとめたもの、"
        "「抽出」は見出し・目次・図表キャプションを機械的に取り出したもの。",
        "",
        "「公開」の † は、掲載ページに公開日の記載が無く、"
        "id・題名・掲載ページURL の数字から年だけを推定した資料"
        f"（{sum(1 for e in catalog if e.get('published_basis', '').startswith('inferred'))}件）。"
        "根拠は catalog.json の `published_basis` に記録している。",
        "",
    ]

    for cat in sorted({e["category"] for e in catalog},
                      key=lambda c: list(CATEGORY_LABEL).index(c)
                      if c in CATEGORY_LABEL else 99):
        items = [e for e in catalog if e["category"] == cat]
        lines += [f"## {CATEGORY_LABEL.get(cat, cat)}（{len(items)}件）", "",
                  "| 資料 | 公開 | 頁 | 抽出 | PDF | 文字起こし | 全文MD | 整理MD |",
                  "| --- | --- | ---: | --- | --- | --- | --- | --- |"]
        for e in sorted(items, key=lambda x: (x.get("published", ""), x["id"])):
            kind = kinds[e["id"]]
            label = {"opus": "要約", "auto": "抽出"}.get(kind)
            extract = e.get("extract", "")
            if e.get("ocr_supplement"):
                extract += "+ocr"
            md_cell = f"[{label}](markdown/{e['id']}.md)" if kind else "—"
            # 掲載ページに公開日が無く id・題名・URL の数字から推定した資料は
            # 確認済みのものと区別できるようにしておく
            published = e.get("published", "")
            if published and e.get("published_basis", "").startswith("inferred"):
                published += "†"
            lines.append(
                f"| {e['title']} | {published} | {e.get('pages', '')} "
                f"| {extract} | [PDF]({e['url']}) "
                f"| [txt](text/{e['id']}.txt) "
                f"| [md](transcript/{e['id']}.md) "
                f"| {md_cell} |"
            )
        lines.append("")

    (DATA / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"INDEX.md: {len(catalog)} entries, "
          f"整理MD 要約 {n_opus} 件 / 自動抽出 {n_auto} 件")


if __name__ == "__main__":
    main()
