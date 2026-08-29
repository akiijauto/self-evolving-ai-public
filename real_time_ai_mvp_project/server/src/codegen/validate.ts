import { ENTRY_FILE, MAX_FILES, MAX_TOTAL_BYTES, type FileMap } from "./types.js";

/**
 * 生成物の検証。**LLMの判断に任せない部分**をここに置く。
 *
 * ROADMAP.md Sprint 6 の完了条件のうち、
 * 「静的ビルドで通る(SSRを使っていない)」と「シークレットが含まれていない」は
 * 品質の問題ではなく事故の問題なので、規則で必ず弾く。
 * Review Agent(LLM)の指摘は、この上に積む。
 */

export interface Finding {
  level: "BLOCK" | "WARN";
  message: string;
}

/**
 * 外部への参照。ai_instruction.md の「外部APIを呼ばないこと」。
 *
 * スキーム付きURLと、引用符の直後に来るプロトコル相対URLだけを見る。
 * `// utils.js の説明` のような行コメントを外部参照と誤認しないため、
 * 裸の `//host` は対象にしない。
 */
const EXTERNAL_REFS = [
  /\bhttps?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9-]+(?:\.[a-z0-9-]+)+/i,
  /["'(]\/\/(?!localhost|127\.0\.0\.1)[a-z0-9-]+(?:\.[a-z0-9-]+)+/i,
];

/** サーバーサイド実行が要る書き方。静的配信では動かない */
const SERVER_SIDE = [
  { re: /\bprocess\.env\b/, what: "process.env" },
  { re: /\brequire\s*\(/, what: "require()" },
  { re: /\bmodule\.exports\b/, what: "module.exports" },
  { re: /<\?php/, what: "PHP" },
  { re: /\bgetServerSideProps\b/, what: "getServerSideProps" },
  { re: /\bfrom\s+["']next\//, what: "Next.js" },
];

/**
 * シークレットらしき文字列。
 *
 * 完全な検出はできないが、**生成物に鍵が紛れ込む事故**を止めるのが目的。
 * 迷ったら止める側に倒す(商談中に出す成果物なので、誤検知のコストは低い)。
 */
const SECRETS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, what: "APIキーらしき文字列 (sk-...)" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "AWSアクセスキー" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: "GitHubトークン" },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/, what: "Bearerトークン" },
  { re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"']{12,}["']/i, what: "鍵らしき代入" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "秘密鍵" },
];

export function validate(files: FileMap): Finding[] {
  const findings: Finding[] = [];
  const names = Object.keys(files);

  if (!names.includes(ENTRY_FILE)) {
    findings.push({ level: "BLOCK", message: `${ENTRY_FILE} がありません。配信できません` });
  }

  if (names.length === 0) {
    findings.push({ level: "BLOCK", message: "ファイルが1つもありません" });
  }
  if (names.length > MAX_FILES) {
    findings.push({ level: "BLOCK", message: `ファイル数が多すぎます (${names.length} > ${MAX_FILES})` });
  }

  const total = names.reduce((sum, name) => sum + Buffer.byteLength(files[name] ?? ""), 0);
  if (total > MAX_TOTAL_BYTES) {
    findings.push({ level: "BLOCK", message: `生成物が大きすぎます (${total} bytes)` });
  }

  for (const name of names) {
    if (!isSafePath(name)) {
      findings.push({ level: "BLOCK", message: `配信できないパスです: ${name}` });
      continue;
    }

    const body = files[name] ?? "";

    for (const pattern of EXTERNAL_REFS) {
      const external = pattern.exec(body);
      if (external) {
        findings.push({
          level: "BLOCK",
          message: `${name} が外部を参照しています (${external[0].replace(/^["'(]/, "")})。オフラインで動く必要があります`,
        });
        break;
      }
    }

    for (const { re, what } of SERVER_SIDE) {
      if (re.test(body)) {
        findings.push({
          level: "BLOCK",
          message: `${name} が ${what} を使っています。静的配信では動きません`,
        });
      }
    }

    for (const { re, what } of SECRETS) {
      if (re.test(body)) {
        findings.push({ level: "BLOCK", message: `${name} に${what}が含まれています` });
      }
    }
  }

  if (!names.some((name) => name.endsWith(".js")) && findings.length === 0) {
    findings.push({ level: "WARN", message: "スクリプトがありません。静的な表示のみになります" });
  }

  return findings;
}

export function hasBlock(findings: Finding[]): boolean {
  return findings.some((finding) => finding.level === "BLOCK");
}

/** 生成物のMarkdown表現。`review.md` に混ぜる */
export function renderFindings(findings: Finding[]): string {
  return findings.map((finding) => `- [${finding.level}] ${finding.message}`).join("\n");
}

/**
 * 配信ディレクトリの外へ出ないパスか。
 * 絶対パス・`..`・バックスラッシュ・制御文字を弾く。
 */
export function isSafePath(name: string): boolean {
  if (name === "" || name.length > 200) return false;
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  // 制御文字と、配信・展開で問題になる記号
  if (/[\u0000-\u001f\\:*?"<>|]/.test(name)) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
