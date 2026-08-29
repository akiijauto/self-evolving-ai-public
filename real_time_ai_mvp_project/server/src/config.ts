/**
 * 環境変数から設定を読む。
 * シークレットはここ以外で読まない(ARCHITECTURE.md のデプロイ構成)。
 */

import { MAX_CODE_ATTEMPTS } from "@rt-mvp/protocol";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num("PORT", 8787),
  host: process.env.HOST ?? "0.0.0.0",

  /** セッションの有効期間。これを過ぎたトークンは 4401 で拒否する */
  sessionTtlMs: num("SESSION_TTL_MS", 4 * 60 * 60 * 1000),

  /** 無音でセッションを自動終了するまでの時間(REQUIREMENTS.md FR-8: 既定10分) */
  silenceTimeoutMs: num("SILENCE_TIMEOUT_MS", 10 * 60 * 1000),

  /** 受信統計をクライアントへ返す間隔 */
  statsIntervalMs: num("STATS_INTERVAL_MS", 5_000),

  /** チャンク受信ログを出す間隔(毎チャンク出すとログが溢れる) */
  chunkLogIntervalMs: num("CHUNK_LOG_INTERVAL_MS", 10_000),

  /** 1接続あたりの受信バイト上限。超えたら 4429 で切る */
  maxSessionBytes: num("MAX_SESSION_BYTES", 512 * 1024 * 1024),

  /** 開発時にPWA(vite)からのアクセスを許可するオリジン */
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // ── 音声認識(Sprint 3) ────────────────────────────

  /**
   * 使用する音声認識プロバイダ。
   * 既定は mock。実APIを使うには資格情報を設定したうえで切り替える。
   */
  speechProvider: (process.env.SPEECH_PROVIDER ?? "mock") as "mock" | "deepgram",

  /** 認識対象の言語。初期は日本語のみ */
  speechLanguage: process.env.SPEECH_LANGUAGE ?? "ja",

  /**
   * 話者分離を要求するか。
   * 採否は Sprint 3 で実測してから決める(RETROSPECTIVE.md の未解決の論点)。
   */
  speechDiarize: process.env.SPEECH_DIARIZE !== "false",

  /**
   * モックの音声認識を必ず失敗させる。
   * ARCHITECTURE.md の縮退動作(STTが落ちても録音は続く)を
   * 実際に再現して確かめるための開発用スイッチ。
   */
  speechFail: process.env.SPEECH_FAIL === "true",

  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
  deepgramModel: process.env.DEEPGRAM_MODEL ?? "nova-2",

  // ── Markdown Store(Sprint 4) ─────────────────────

  /**
   * Markdownの保存先。既定はサーバーの作業ディレクトリ直下の `data/`。
   * 配下に `sessions/{sessionId}/` を掘る。音声データは書かない。
   */
  dataDir: process.env.DATA_DIR ?? "data",

  /**
   * Markdownの保持期間(DATAFLOW.md「保存レイヤー」: 商談終了後30日)。
   * これを過ぎたセッションはディレクトリごと消す。
   */
  documentRetentionMs: num("DOCUMENT_RETENTION_MS", 30 * 24 * 60 * 60 * 1000),

  // ── LLM / Orchestrator(Sprint 5) ─────────────────

  /** `mock`(既定) / `anthropic` */
  llmProvider: process.env.LLM_PROVIDER ?? "mock",

  /** 既定モデル。Agentごとの指定が優先される(AGENTS.md の推奨モデル) */
  llmModel: process.env.LLM_MODEL ?? "claude-sonnet-5",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",

  /** モックを必ず失敗させる。縮退動作の確認用 */
  llmFail: process.env.LLM_FAIL === "true",

  /** モックの応答遅延。実APIの待ち時間を再現する */
  llmLatencyMs: num("LLM_LATENCY_MS", 0),

  /**
   * LLM呼び出し1回の打ち切り時間。
   *
   * 実測でコード生成は約44秒かかる。以前の60秒だと、AI側が少し遅い日に
   * それだけで商談中の生成が落ちる(実機で発生)。倍の120秒を既定とする。
   * これ以上は「待たせ続けるより、失敗を見せて言い直してもらう」ほうがよい
   */
  llmTimeoutMs: num("LLM_TIMEOUT_MS", 120_000),

  /** Issue Agent の実行間隔(AGENTS.md: 60秒ごと) */
  issueIntervalMs: num("ISSUE_INTERVAL_MS", 60_000),

  /** 未処理の文字起こしがこの文字数を超えたら、間隔を待たずに Issue Agent を回す */
  issueThresholdChars: num("ISSUE_THRESHOLD_CHARS", 400),

  // ── コード生成 / 配信(Sprint 6) ──────────────────

  /**
   * `template`(既定) / `llm`
   *
   * `template` は雛形から組み立てる。推論しないぶん速く、必ず動くものが出る。
   * 商談中の最終防壁として既定にしている。
   */
  codeProvider: process.env.CODE_PROVIDER ?? "template",

  /** `CODE_PROVIDER=llm` のときのモデル */
  codeModel: process.env.CODE_MODEL ?? "claude-opus-5",

  /**
   * コード生成をやり直す上限(1〜MAX_CODE_ATTEMPTS)。
   *
   * 商談中の時間予算にそのまま効くが、**既定(3)のままでよい。**
   * 実測では `CODE_PROVIDER=llm` の1周が コード生成44秒 + レビュー24秒 で、
   * 3周しても承認からURLまで約4分20秒。「承認から10分以内にURL」(AGENTS.md)に
   * 5分以上残る。
   *
   * 下げるのは実測がこれから大きく外れたときだけにする。上限に達したときに出るのは
   * 要件定義とUI設計までで**動くものは出ない**ため、往復を削ると
   * 「試作品が出ない」確率が上がる。
   */
  codeAttempts: num("CODE_ATTEMPTS", MAX_CODE_ATTEMPTS),

  /**
   * 生成ジョブの時間予算(2026-08-07 の運用決定)。
   *
   * 「承認から10分以内にURL」は目標のままだが、間に合わない場合に
   * そこで見切らない。画面に進捗を出したまま、この予算まで
   * AIを稼働してよい(混雑の再試行・レビュー差し戻しの周回を含む)。
   */
  jobBudgetMs: num("JOB_BUDGET_MS", 30 * 60_000),

  /** トリガーキーワードの検出を止める。誤検出が煩わしい場面向け */
  triggerDisabled: process.env.TRIGGER_DISABLED === "true",

  /**
   * 確認UIを出したあと、次のトリガーを無視する時間。
   *
   * 会話が同じ話題へ戻るたびに確認が出ると商談の邪魔になり、
   * そのたびに議事録の作り直し(LLM呼び出し)まで走る。
   * 言い直して作り直したい場合は、この時間を過ぎれば再び拾う。
   */
  triggerCooldownMs: num("TRIGGER_COOLDOWN_MS", 3 * 60 * 1000),

  // ── 運用(Sprint 8) ───────────────────────────────

  /**
   * セッション作成の回数制限(回 / 窓)。`POST /sessions` は
   * トークン無しで叩けるため、量産を防ぐ。0 で無制限。
   */
  sessionCreateLimit: num("SESSION_CREATE_LIMIT", 30),
  sessionCreateWindowMs: num("SESSION_CREATE_WINDOW_MS", 60 * 60 * 1000),
} as const;
