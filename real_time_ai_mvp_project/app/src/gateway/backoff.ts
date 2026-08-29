/**
 * 再接続の待ち時間。
 *
 * ARCHITECTURE.md の再接続仕様:
 * 「指数バックオフ(1s / 2s / 4s / 8s、上限30s)」
 *
 * 同時に切断された複数端末が一斉に殺到しないよう、ジッタを加える。
 */

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** 試行回数(0始まり)に対する待ち時間の基準値。ジッタなし */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt);
  // 2^attempt が跳ねすぎないよう先に上限で頭打ちにする
  if (exponent > 30) return BACKOFF_MAX_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

/**
 * ジッタ込みの待ち時間。基準値の 50%〜100% の範囲に散らす。
 * @param random テスト用に差し替える乱数源
 */
export function backoffDelayWithJitterMs(attempt: number, random: () => number = Math.random): number {
  const base = backoffDelayMs(attempt);
  return Math.round(base * (0.5 + 0.5 * random()));
}
