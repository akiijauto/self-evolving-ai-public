/**
 * セッション作成の回数制限(スライディングウィンドウ)。
 *
 * `POST /sessions` は唯一トークン無しで叩ける入口なので、
 * 放置すると誰でもセッション(=ディスク上のディレクトリ)を
 * 量産できてしまう。営業1〜2名の運用では作成は1日に数回のはずで、
 * 既定の 30回/時間 を超えるのは事故か攻撃だけ。
 *
 * IPごとに分けない。リバースプロキシ配下でのIPの取り出しは
 * 設定を誤ると全員が同一IPになり、制限の意味が変わってしまう。
 * この規模ではサーバー全体でひとつの窓で足りる。
 */
export class SlidingWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #times: number[] = [];

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  /** 枠が空いていれば消費して true。`limit <= 0` は無制限 */
  tryAcquire(): boolean {
    if (this.#limit <= 0) return true;
    const now = this.#now();
    this.#times = this.#times.filter((at) => now - at < this.#windowMs);
    if (this.#times.length >= this.#limit) return false;
    this.#times.push(now);
    return true;
  }

  /** 次に枠が空くまでの秒数(Retry-After 用)。空いていれば 0 */
  retryAfterSeconds(): number {
    if (this.#limit <= 0 || this.#times.length < this.#limit) return 0;
    const oldest = this.#times[0] ?? this.#now();
    return Math.max(1, Math.ceil((oldest + this.#windowMs - this.#now()) / 1000));
  }
}
