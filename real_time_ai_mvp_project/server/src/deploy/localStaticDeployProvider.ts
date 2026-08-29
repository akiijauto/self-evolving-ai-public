import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isSafePath, type FileMap } from "../codegen/index.js";
import { log } from "../log.js";

/**
 * 生成物の配信。ARCHITECTURE.md の「交換可能性」に対応する。
 *
 * 既定実装は **Gateway Server 自身による静的配信**。
 * 外部ホスティングへは出さない(RETROSPECTIVE.md:「見せる相手は自分のタブレット。
 * 商談内容から作られたアプリをネット上に置く理由がない」)。
 */

export interface DeployRequest {
  sessionId: string;
  buildId: string;
  files: FileMap;
  /** 閲覧できる期限。セッションの有効期限に合わせる */
  expiresAt: Date;
}

export interface DeployResult {
  /** 閲覧用のパス。トークンはクライアント側で付ける */
  url: string;
  expiresAt: string;
}

export interface DeployProvider {
  deploy(req: DeployRequest): Promise<DeployResult>;
  /** セッションの成果物をすべて捨てる */
  remove(sessionId: string): Promise<void>;
}

export class LocalStaticDeployProvider implements DeployProvider {
  readonly #root: string;

  constructor(options: { dataDir: string }) {
    this.#root = resolve(options.dataDir, "sessions");
  }

  /** ビルドの置き場。`{dataDir}/sessions/{sessionId}/builds/{buildId}/` */
  dirOf(sessionId: string, buildId: string): string {
    if (!/^sess_[0-9a-f]{32}$/.test(sessionId)) throw new Error(`不正なセッションIDです: ${sessionId}`);
    if (!/^build_[0-9a-f]{32}$/.test(buildId)) throw new Error(`不正なビルドIDです: ${buildId}`);
    return join(this.#root, sessionId, "builds", buildId);
  }

  async deploy(req: DeployRequest): Promise<DeployResult> {
    const dir = this.dirOf(req.sessionId, req.buildId);
    // 商談内容から作られたコード。配信はGateway経由だけにする
    await mkdir(dir, { recursive: true, mode: 0o700 });

    for (const [name, body] of Object.entries(req.files)) {
      // 検証層でも見ているが、書き込む直前にもう一度見る。
      // ここを抜けられると配信ディレクトリの外へファイルが出る
      if (!isSafePath(name)) throw new Error(`配信できないパスです: ${name}`);

      const target = join(dir, name);
      // 区切りは `/` 決め打ちにしない。Windows(`\`)では全ファイルが
      // 「外」と誤判定され、開発機でのテストが全滅する
      if (!target.startsWith(dir + sep)) throw new Error(`配信ディレクトリの外です: ${name}`);

      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, body, { encoding: "utf8", mode: 0o600 });
    }

    // 古いビルドは即座に配信対象から外す(ARCHITECTURE.md)
    await this.#removeOtherBuilds(req.sessionId, req.buildId);

    log.info("deploy.done", {
      sessionId: req.sessionId,
      buildId: req.buildId,
      files: Object.keys(req.files).length,
    });

    return {
      url: `/preview/${req.sessionId}/${req.buildId}/`,
      expiresAt: req.expiresAt.toISOString(),
    };
  }

  async remove(sessionId: string): Promise<void> {
    await rm(join(this.#root, sessionId, "builds"), { recursive: true, force: true });
  }

  async #removeOtherBuilds(sessionId: string, keep: string): Promise<void> {
    const builds = join(this.#root, sessionId, "builds");
    let entries: string[];
    try {
      entries = await readdir(builds);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === keep) continue;
      await rm(join(builds, entry), { recursive: true, force: true });
    }
  }
}
