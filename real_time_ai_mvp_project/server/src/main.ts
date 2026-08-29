import { createServer } from "node:http";
import { resolve } from "node:path";
import { config } from "./config.js";
import { handleApi } from "./http/api.js";
import { log } from "./log.js";
import { AgentHistory } from "./agents/history.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { createCodeProvider } from "./codegen/index.js";
import { LocalStaticDeployProvider } from "./deploy/localStaticDeployProvider.js";
import { handlePreview } from "./http/preview.js";
import { SlidingWindowLimiter } from "./http/rateLimit.js";
import { createLLMProvider } from "./llm/index.js";
import { MarkdownStore } from "./markdown/store.js";
import { SessionDocuments } from "./markdown/sessionDocuments.js";
import { SessionStore } from "./sessions/store.js";
import { createSpeechProvider } from "./speech/index.js";
import { attachGateway, sendToSession } from "./ws/gateway.js";

/**
 * Gateway Server の起動。
 *
 * ARCHITECTURE.md の通り、このサーバーは「中継・保存・呼び出し・配信」しか行わない。
 * 推論も音声処理も外部APIへ委譲するため、CPU最小構成 / メモリ2GB で足りる。
 */

// トークンを含むメタ情報は data/session-meta/ に置く。再起動しても
// 「Markdownはあるのに読むためのトークンが無い」状態にしない
const store = new SessionStore({
  ttlMs: config.sessionTtlMs,
  persistDir: resolve(config.dataDir, "session-meta"),
});
const markdown = new MarkdownStore({ dataDir: config.dataDir });
const docs = new SessionDocuments(markdown);

const llm = createLLMProvider();
const deploy = new LocalStaticDeployProvider({ dataDir: config.dataDir });

const orchestrator = new Orchestrator({
  docs,
  llm,
  code: createCodeProvider(llm),
  deploy,
  history: new AgentHistory(markdown),
  // 更新の通知先を探すのはゲートウェイの仕事。Orchestratorは接続を知らない
  notify: sendToSession,
  intervalMs: config.issueIntervalMs,
  thresholdChars: config.issueThresholdChars,
  triggerCooldownMs: config.triggerCooldownMs,
  codeAttempts: config.codeAttempts,
  jobBudgetMs: config.jobBudgetMs,
});

const createLimiter = new SlidingWindowLimiter({
  limit: config.sessionCreateLimit,
  windowMs: config.sessionCreateWindowMs,
});

const server = createServer((req, res) => {
  // 生成MVPの配信はAPIとは別の入口。トークンの渡し方も違う(?t= かCookie)
  void handlePreview(req, res, store, deploy)
    .then((served) => (served ? true : handleApi(req, res, store, docs, orchestrator, createLimiter)))
    .then((handled) => {
      if (handled) return;
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "Not Found" } }));
    })
    .catch((error: unknown) => {
      log.error("http.error", {
        url: req.url,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { code: "internal", message: "Internal Server Error" } }));
      } else {
        res.end();
      }
    });
});

attachGateway(server, store, createSpeechProvider(), docs, orchestrator);

/**
 * 保持期間を過ぎたセッションの掃除。
 *
 * セッションの記録とMarkdownは寿命を揃える。片方だけ消えると、
 * 「トークンはあるのに中身が無い」「中身はあるのに読めない」状態になる。
 */
const sweepTimer = setInterval(
  () => {
    const removed = store.sweep(config.documentRetentionMs);
    if (removed.length === 0) return;
    for (const sessionId of removed) {
      orchestrator.stop(sessionId);
      // 生成物も一緒に消す。セッションが無ければ配信もできない
      void deploy.remove(sessionId).catch(() => undefined);
      void docs.store.remove(sessionId).catch((error: unknown) => {
        log.error("documents.remove_failed", {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    log.info("sessions.swept", { removed: removed.length, remaining: store.size });
  },
  60 * 60 * 1000,
);
sweepTimer.unref();

server.listen(config.port, config.host, () => {
  log.info("server.started", {
    host: config.host,
    port: config.port,
    corsOrigins: config.corsOrigins,
    dataDir: config.dataDir,
  });
});

function shutdown(signal: string): void {
  log.info("server.stopping", { signal });
  server.close(() => process.exit(0));
  // 接続が残っていても一定時間で落とす
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
