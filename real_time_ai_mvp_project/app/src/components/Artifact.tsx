import { useEffect, useMemo, useRef, useState } from "react";
import type { JobFailure, JobStatus, JobStep } from "@rt-mvp/protocol";
import { formatDuration } from "../format";
import { encodeQr } from "../qr/encode";

/**
 * 生成の進捗と、できあがったMVPの提示。
 *
 * PROJECT.md の最重要価値である「その場でアプリが完成する」体験の出口。
 * **URLは自分の別端末で開くためのもの**で、顧客へ渡すものではない
 * (RETROSPECTIVE.md: 生成MVPは外部公開しない)。
 */

const STEP_LABEL: Record<JobStep, string> = {
  requirements: "要件定義",
  ui: "画面設計",
  code: "コード生成",
  review: "レビュー",
  deploy: "配信の準備",
};

const STEPS: JobStep[] = ["requirements", "ui", "code", "review", "deploy"];

export function Artifact({
  job,
  artifact,
}: {
  job: { jobId: string; step: JobStep; status: JobStatus; failure?: JobFailure } | null;
  artifact: { buildId: string; url: string; previewToken: string; expiresAt: string } | null;
}) {
  // トークン付きの絶対URL。別端末から開くため、ホスト名まで含める。
  //
  // **ここに載せるのはプレビュー用トークンで、操作用のトークンではない。**
  // このURLはQRコードとして画面に映り、開いた端末の履歴にも残る。
  // 操作用を載せていたら、写真1枚で商談の全文が読めてしまう
  const fullUrl = useMemo(() => {
    if (artifact === null) return null;
    return `${window.location.origin}${artifact.url}?t=${encodeURIComponent(artifact.previewToken)}`;
  }, [artifact]);

  if (job === null && artifact === null) return null;

  return (
    <section className="artifact">
      {job !== null && artifact === null && <Progress job={job} />}

      {job?.status === "failed" && (
        <div className="artifact-failed">
          {/* 理由によって取る行動が違う: 一時的なら言い直す、内容起因なら
              話題を変える、設定起因なら管理者へ。「失敗しました」だけでは
              営業担当がこの判断をできない */}
          <p className="artifact-failed-reason">
            {job.failure?.message ?? "生成できませんでした。"}
          </p>
          <p className="artifact-failed-guide">
            {(job.failure?.retryable ?? true)
              ? "合図の言葉を言い直すと、もう一度作れます。ここまでの記録は残っています。"
              : "言い直しても同じ結果になる見込みです。ここまでの記録は残っています。"}
          </p>
          {job.failure !== undefined && (
            <p className="artifact-failed-detail">詳細: {job.failure.detail}</p>
          )}
        </div>
      )}

      {fullUrl !== null && artifact !== null && (
        <div className="artifact-ready">
          <h2 className="artifact-title">試作品ができました</h2>

          <div className="artifact-body">
            <QrView text={fullUrl} />

            <div className="artifact-links">
              <a className="btn btn-primary" href={fullUrl} target="_blank" rel="noreferrer">
                開く
              </a>
              {/* QRが読めない端末への逃げ道。URLは長すぎて口頭では伝えられない。
                  合言葉そのものなので、画面には出さずクリップボードへ渡す */}
              <CopyUrl url={fullUrl} />
              <p className="artifact-hint">
                QRコードから開けます。このURLを知っている人は誰でも開けます。
              </p>
              <p className="artifact-expires">
                有効期限: {new Date(artifact.expiresAt).toLocaleString("ja-JP")}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CopyUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="artifact-copy"
      onClick={() => {
        void navigator.clipboard
          .writeText(url)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          })
          // 権限が無い環境がある。押しても何も起きないより、理由が分かる方がよい
          .catch(() => setCopied(false));
      }}
    >
      {copied ? "コピーしました" : "URLをコピー"}
    </button>
  );
}

function Progress({ job }: { job: { step: JobStep; status: JobStatus } }) {
  const current = STEPS.indexOf(job.step);
  const running = job.status !== "failed";

  // 経過時間。長引いても止まっていないことを画面で示す
  // (運用ルール: 10分で見切らず、最大30分まで作り続ける)。
  // 開始時刻はこの画面が進捗を見始めた時点。リロードすると測り直しになるが、
  // 「動いているか」を示す用途には足りる
  const startedAtRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsedMs = now - startedAtRef.current;

  return (
    <div className="artifact-progress">
      <p className="artifact-progress-title">
        {job.status === "failed" ? "生成に失敗しました" : "試作品を作っています…"}
      </p>
      {running && (
        <p className="artifact-progress-elapsed">
          経過 {formatDuration(elapsedMs)}
          {elapsedMs > 10 * 60_000 && " — 10分を超えましたが、最大30分まで作り続けます"}
        </p>
      )}
      <ol className="artifact-steps">
        {STEPS.map((step, index) => (
          <li
            key={step}
            className={
              index < current
                ? "artifact-step artifact-step-done"
                : index === current
                  ? "artifact-step artifact-step-current"
                  : "artifact-step"
            }
          >
            {STEP_LABEL[step]}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * QRコードをSVGで描く。
 *
 * 外部のQR生成サービスへURLを送らない。**商談内容から作られたURLを外へ出さない**という
 * 方針は、画像の作り方にも及ぶ。
 */
function QrView({ text }: { text: string }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(text);
    } catch {
      // URLが長すぎて収まらない場合。URLそのものは出しているので致命ではない
      return null;
    }
  }, [text]);

  if (qr === null) {
    return <p className="artifact-hint">QRコードを作れませんでした。URLから開いてください。</p>;
  }

  // 静区(quiet zone)は規格上4モジュール必要。これが無いと読み取れない
  const quiet = 4;
  const total = qr.size + quiet * 2;

  return (
    <svg
      className="artifact-qr"
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label="生成したアプリのURLのQRコード"
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      {qr.modules.map((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${y}-${x}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#000" /> : null,
        ),
      )}
    </svg>
  );
}
