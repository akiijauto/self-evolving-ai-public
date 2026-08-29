/**
 * QRコードの生成(バイトモード / 誤り訂正レベル L / 型番1〜10)。
 *
 * ROADMAP.md Sprint 6:「QRコードから自分の別端末でアプリを開ける」。
 * 生成MVPは同じ回線の中でしか開けないため、**外部のQR生成サービスへURLを送れない。**
 * 商談内容から作られたURLを外へ出さない、という方針の当然の帰結として自前で持つ。
 *
 * 型番10(レベルL)で271バイトまで入る。LAN内のURLはこれに収まる。
 */

export interface QrCode {
  /** 一辺のモジュール数 */
  size: number;
  /** true が暗いモジュール。`modules[y][x]` */
  modules: boolean[][];
}

/** 型番ごとの [データ語数, ブロックあたりの誤り訂正語数, グループ1のブロック数, グループ1のデータ語数, グループ2のブロック数, グループ2のデータ語数] */
const VERSIONS: Record<number, [number, number, number, number, number, number]> = {
  1: [19, 7, 1, 19, 0, 0],
  2: [34, 10, 1, 34, 0, 0],
  3: [55, 15, 1, 55, 0, 0],
  4: [80, 20, 1, 80, 0, 0],
  5: [108, 26, 1, 108, 0, 0],
  6: [136, 18, 2, 68, 0, 0],
  7: [156, 20, 2, 78, 0, 0],
  8: [194, 24, 2, 97, 0, 0],
  9: [232, 30, 2, 116, 0, 0],
  10: [274, 18, 2, 68, 2, 69],
};

/** 型番ごとの位置合わせパターンの中心座標 */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;
/** 誤り訂正レベル L の識別子(形式情報で使う2ビット) */
const EC_LEVEL_L = 0b01;

export class QrError extends Error {}

export function encodeQr(text: string): QrCode {
  const data = new TextEncoder().encode(text);
  const version = pickVersion(data.length);
  const codewords = interleave(toDataCodewords(data, version), version);
  const size = version * 4 + 17;

  let best: { modules: boolean[][]; penalty: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = place(size, version, codewords, mask);
    const penalty = score(modules);
    if (best === null || penalty < best.penalty) best = { modules, penalty };
  }

  return { size, modules: (best as { modules: boolean[][] }).modules };
}

/** 収まる最小の型番。大きいほどモジュールが細かくなり、読み取りにくくなる */
function pickVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteLength <= capacityOf(version)) return version;
  }
  throw new QrError(`QRに収まりません (${byteLength} バイト)`);
}

export function capacityOf(version: number): number {
  const spec = VERSIONS[version];
  if (!spec) throw new QrError(`未対応の型番です: ${version}`);
  return Math.floor((spec[0] * 8 - 4 - countBits(version)) / 8);
}

/** 文字数を表すビット数。型番10以上は16ビットになる */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

// ── データ語 ──────────────────────────────────────

function toDataCodewords(data: Uint8Array, version: number): number[] {
  const spec = VERSIONS[version] as [number, number, number, number, number, number];
  const total = spec[0];
  const bits: number[] = [];

  const push = (value: number, length: number): void => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };

  push(0b0100, 4); // バイトモード
  push(data.length, countBits(version));
  for (const byte of data) push(byte, 8);

  // 終端。残りが4ビット未満ならその分だけ
  push(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | (bits[index + offset] as number);
    codewords.push(byte);
  }

  // 埋め草。規格で 0xEC / 0x11 の繰り返しと決まっている
  const PAD = [0xec, 0x11];
  while (codewords.length < total) codewords.push(PAD[codewords.length % 2] as number);

  return codewords;
}

/**
 * ブロックに分けて誤り訂正語を付け、規格の順に並べ替える。
 * データは各ブロックの先頭から1語ずつ、続いて誤り訂正語を同じように並べる。
 */
function interleave(data: number[], version: number): number[] {
  const [, ecPerBlock, group1, size1, group2, size2] = VERSIONS[version] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const blocks: number[][] = [];
  let offset = 0;
  for (let index = 0; index < group1; index += 1) {
    blocks.push(data.slice(offset, offset + size1));
    offset += size1;
  }
  for (let index = 0; index < group2; index += 1) {
    blocks.push(data.slice(offset, offset + size2));
    offset += size2;
  }

  const eccs = blocks.map((block) => reedSolomon(block, ecPerBlock));

  const result: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) {
      if (index < block.length) result.push(block[index] as number);
    }
  }
  for (let index = 0; index < ecPerBlock; index += 1) {
    for (const ecc of eccs) result.push(ecc[index] as number);
  }

  return result;
}

// ── ガロア体 GF(256) ──────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d; // QRの原始多項式
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255] as number;
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[((LOG[a] as number) + (LOG[b] as number)) % 255] as number;
}

/** 生成多項式 (x - α^0)(x - α^1)... */
function generator(degree: number): number[] {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position += 1) {
      next[position] = (next[position] as number) ^ (poly[position] as number);
      next[position + 1] =
        (next[position + 1] as number) ^ mul(poly[position] as number, EXP[index] as number);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const remainder = new Array<number>(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) {
      remainder[index] = (remainder[index] as number) ^ mul(gen[index + 1] as number, factor);
    }
  }
  return remainder;
}

// ── 配置 ────────────────────────────────────────

function place(size: number, version: number, codewords: number[], mask: number): boolean[][] {
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );

  drawFinders(modules, size);
  drawTiming(modules, size);
  drawAlignment(modules, version);
  // 常に暗いモジュール。規格で位置が決まっている
  modules[size - 8]![8] = true;
  reserveFormat(modules, size);
  if (version >= 7) drawVersion(modules, size, version);

  drawData(modules, size, codewords, mask);
  drawFormat(modules, size, mask);

  return modules.map((row) => row.map((cell) => cell === true));
}

function drawFinders(modules: (boolean | null)[][], size: number): void {
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as [number, number][]) {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const py = top + y;
        const px = left + x;
        if (py < 0 || py >= size || px < 0 || px >= size) continue;
        const inner = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        const ring = y >= 0 && y <= 6 && x >= 0 && x <= 6 && (y === 0 || y === 6 || x === 0 || x === 6);
        modules[py]![px] = inner || ring;
      }
    }
  }
}

function drawTiming(modules: (boolean | null)[][], size: number): void {
  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    modules[6]![index] = dark;
    modules[index]![6] = dark;
  }
}

function drawAlignment(modules: (boolean | null)[][], version: number): void {
  const centers = ALIGNMENT[version] as number[];
  const last = centers[centers.length - 1];

  for (const cy of centers) {
    for (const cx of centers) {
      // 位置検出パターンと重なる3隅だけを避ける。
      // タイミングパターンと交差する位置には、こちらを上書きして描く
      const onFinder = (cy === 6 && cx === 6) || (cy === 6 && cx === last) || (cy === last && cx === 6);
      if (onFinder) continue;

      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          modules[cy + y]![cx + x] = Math.max(Math.abs(y), Math.abs(x)) !== 1;
        }
      }
    }
  }
}

/** 形式情報の場所を先に埋めておく。データがここへ流れ込まないように */
function reserveFormat(modules: (boolean | null)[][], size: number): void {
  for (let index = 0; index < 9; index += 1) {
    if (modules[8]![index] === null) modules[8]![index] = false;
    if (modules[index]![8] === null) modules[index]![8] = false;
  }
  for (let index = 0; index < 8; index += 1) {
    if (modules[8]![size - 1 - index] === null) modules[8]![size - 1 - index] = false;
    if (modules[size - 1 - index]![8] === null) modules[size - 1 - index]![8] = false;
  }
}

function drawData(
  modules: (boolean | null)[][],
  size: number,
  codewords: number[],
  mask: number,
): void {
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // 6列目は縦のタイミングパターン。飛ばす
    const column = right <= 6 ? right - 1 : right;

    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [column, column - 1]) {
        if (modules[y]![x] !== null) continue;

        const byte = codewords[bitIndex >> 3];
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
        // マスク条件を満たす位置は反転する(ビットとの排他的論理和)
        modules[y]![x] = bit === 1 ? !maskAt(mask, y, x) : maskAt(mask, y, x);
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

export function maskAt(mask: number, y: number, x: number): boolean {
  switch (mask) {
    case 0:
      return (y + x) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (y + x) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6:
      return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    default:
      return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
  }
}

function drawFormat(modules: (boolean | null)[][], size: number, mask: number): void {
  const bits = formatBits(mask);

  for (let index = 0; index < 15; index += 1) {
    const dark = ((bits >> index) & 1) === 1;

    // 左上
    if (index < 6) modules[8]![index] = dark;
    else if (index === 6) modules[8]![7] = dark;
    else if (index === 7) modules[8]![8] = dark;
    else if (index === 8) modules[7]![8] = dark;
    else modules[14 - index]![8] = dark;

    // 右上・左下
    if (index < 8) modules[8]![size - 1 - index] = dark;
    else modules[size - 15 + index]![8] = dark;
  }
}

/** BCH(15,5)。誤り訂正レベルとマスク番号を符号化する */
export function formatBits(mask: number): number {
  const data = (EC_LEVEL_L << 3) | mask;
  let value = data << 10;
  for (let index = 14; index >= 10; index -= 1) {
    if ((value >> index) & 1) value ^= 0x537 << (index - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

/** BCH(18,6)。型番7以上で必要 */
export function versionBits(version: number): number {
  let value = version << 12;
  for (let index = 17; index >= 12; index -= 1) {
    if ((value >> index) & 1) value ^= 0x1f25 << (index - 12);
  }
  return (version << 12) | value;
}

function drawVersion(modules: (boolean | null)[][], size: number, version: number): void {
  const bits = versionBits(version);

  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >> index) & 1) === 1;
    const row = Math.floor(index / 3);
    const column = index % 3;
    modules[row]![size - 11 + column] = dark;
    modules[size - 11 + column]![row] = dark;
  }
}

// ── マスクの評価 ──────────────────────────────────

/** 規格の4つの減点規則。読み取りやすいマスクを選ぶために使う */
function score(modules: boolean[][]): number {
  const size = modules.length;
  let penalty = 0;

  // 規則1: 同色が5つ以上並ぶ
  for (let index = 0; index < size; index += 1) {
    penalty += runPenalty(modules[index] as boolean[]);
    penalty += runPenalty(modules.map((row) => row[index] as boolean));
  }

  // 規則2: 同色の2x2
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = modules[y]![x];
      if (
        value === modules[y]![x + 1] &&
        value === modules[y + 1]![x] &&
        value === modules[y + 1]![x + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // 規則3: 位置検出パターンに似た並び
  for (let index = 0; index < size; index += 1) {
    penalty += patternPenalty(modules[index] as boolean[]);
    penalty += patternPenalty(modules.map((row) => row[index] as boolean));
  }

  // 規則4: 暗いモジュールの偏り
  const dark = modules.flat().filter(Boolean).length;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

function runPenalty(line: boolean[]): number {
  let penalty = 0;
  let run = 1;

  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === line[index - 1]) {
      run += 1;
      if (run === 5) penalty += 3;
      else if (run > 5) penalty += 1;
    } else {
      run = 1;
    }
  }
  return penalty;
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

function patternPenalty(line: boolean[]): number {
  let penalty = 0;

  for (let index = 0; index + 7 <= line.length; index += 1) {
    if (!FINDER_LIKE.every((value, offset) => line[index + offset] === value)) continue;

    const before = line.slice(Math.max(0, index - 4), index);
    const after = line.slice(index + 7, index + 11);
    if (before.length === 4 && before.every((value) => !value)) penalty += 40;
    if (after.length === 4 && after.every((value) => !value)) penalty += 40;
  }
  return penalty;
}
