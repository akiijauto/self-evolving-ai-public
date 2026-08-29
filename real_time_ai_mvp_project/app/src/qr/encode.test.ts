import { describe, expect, it } from "vitest";
import { capacityOf, encodeQr, formatBits, maskAt, QrError } from "./encode";

/**
 * QR生成の検証。
 *
 * 「それらしい絵が出る」では足りない。**書いたものを読み返して**、
 * 元の文字列に戻ることを確かめる。位置・マスク・ビット順のどれが崩れても落ちる。
 */

const URL =
  "http://192.168.1.20:8787/preview/sess_0123456789abcdef0123456789abcdef/build_fedcba9876543210fedcba9876543210/?t=zN8Qk2LmRtY7Xw4Vb9Fh1Jd3Ps6Gc0Ae5Ui2Ko8Lq1";

describe("構造", () => {
  it("型番に応じた大きさになる", () => {
    // 短い文字列は小さい型番に収まる
    expect(encodeQr("hi").size).toBe(21); // 型番1
    expect(encodeQr(URL).size % 4).toBe(1); // 4*version+17
  });

  it("3隅に位置検出パターンがある", () => {
    const { modules, size } = encodeQr(URL);

    const corners: [number, number][] = [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ];
    for (const [top, left] of corners) {
      // 外周は暗く、その内側は明るく、中心3x3は暗い
      expect(modules[top]?.[left]).toBe(true);
      expect(modules[top + 1]?.[left + 1]).toBe(false);
      expect(modules[top + 3]?.[left + 3]).toBe(true);
    }
  });

  it("タイミングパターンが交互になる", () => {
    const { modules, size } = encodeQr(URL);

    for (let index = 8; index < size - 8; index += 1) {
      expect(modules[6]?.[index]).toBe(index % 2 === 0);
      expect(modules[index]?.[6]).toBe(index % 2 === 0);
    }
  });

  it("常に暗いモジュールが立っている", () => {
    const { modules, size } = encodeQr(URL);

    expect(modules[size - 8]?.[8]).toBe(true);
  });

  it("長すぎる文字列は拒む", () => {
    expect(() => encodeQr("a".repeat(300))).toThrow(QrError);
  });

  it("容量が型番とともに増える", () => {
    expect(capacityOf(1)).toBe(17);
    expect(capacityOf(10)).toBe(271);
  });
});

describe("形式情報", () => {
  it("誤り訂正レベルLとマスク番号を符号化する", () => {
    // 規格が定める既知の値(レベルL / マスク0〜2)
    expect(formatBits(0)).toBe(0b111011111000100);
    expect(formatBits(1)).toBe(0b111001011110011);
    expect(formatBits(2)).toBe(0b111110110101010);
  });
});

describe("読み返し", () => {
  const samples = ["hi", "http://localhost:8787/preview/x/y/", URL, "日本語も入る"];

  for (const sample of samples) {
    it(`${sample.slice(0, 24)} を復元できる`, () => {
      expect(decode(encodeQr(sample).modules)).toBe(sample);
    });
  }

  it("容量いっぱいでも復元できる", () => {
    const text = "a".repeat(capacityOf(10));

    expect(decode(encodeQr(text).modules)).toBe(text);
  });
});

/**
 * 生成したモジュールから元の文字列を読み返す。
 *
 * 誤り訂正は使わない(壊れていない前提)。
 * データ語の並べ替えを逆にたどり、モード・文字数・本体を取り出す。
 */
function decode(modules: boolean[][]): string {
  const size = modules.length;
  const version = (size - 17) / 4;
  const mask = readMask(modules);
  const raw = readCodewords(modules, size, mask);
  const data = deinterleave(raw, version);

  const bits: number[] = [];
  for (const byte of data) {
    for (let index = 7; index >= 0; index -= 1) bits.push((byte >> index) & 1);
  }

  const take = (length: number): number => {
    let value = 0;
    for (let index = 0; index < length; index += 1) value = (value << 1) | (bits.shift() ?? 0);
    return value;
  };

  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`バイトモードではありません: ${mode}`);

  const length = take(version < 10 ? 8 : 16);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = take(8);

  return new TextDecoder().decode(bytes);
}

/** 左上の形式情報からマスク番号を読む */
function readMask(modules: boolean[][]): number {
  let bits = 0;
  for (let index = 0; index < 15; index += 1) {
    let dark: boolean;
    if (index < 6) dark = modules[8]?.[index] === true;
    else if (index === 6) dark = modules[8]?.[7] === true;
    else if (index === 7) dark = modules[8]?.[8] === true;
    else if (index === 8) dark = modules[7]?.[8] === true;
    else dark = modules[14 - index]?.[8] === true;
    if (dark) bits |= 1 << index;
  }

  for (let mask = 0; mask < 8; mask += 1) {
    if (formatBits(mask) === bits) return mask;
  }
  throw new Error("形式情報を読めません");
}

/** データ領域をジグザグにたどって語に戻す */
function readCodewords(modules: boolean[][], size: number, mask: number): number[] {
  const reserved = reservedMap(size, (size - 17) / 4);
  const bits: number[] = [];
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    const column = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [column, column - 1]) {
        if (reserved[y]?.[x]) continue;
        const dark = modules[y]?.[x] === true;
        bits.push(dark !== maskAt(mask, y, x) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | (bits[index + offset] as number);
    codewords.push(byte);
  }
  return codewords;
}

/** 機能パターンの位置。生成側と同じ規則で組み立てる */
function reservedMap(size: number, version: number): boolean[][] {
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (y: number, x: number): void => {
    if (y >= 0 && y < size && x >= 0 && x < size) map[y]![x] = true;
  };

  const corners: [number, number][] = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const [top, left] of corners) {
    for (let y = -1; y <= 7; y += 1) for (let x = -1; x <= 7; x += 1) mark(top + y, left + x);
  }

  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }

  const centers: Record<number, number[]> = {
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
  const list = centers[version] as number[];
  const last = list[list.length - 1];
  for (const cy of list) {
    for (const cx of list) {
      if ((cy === 6 && cx === 6) || (cy === 6 && cx === last) || (cy === last && cx === 6)) continue;
      for (let y = -2; y <= 2; y += 1) for (let x = -2; x <= 2; x += 1) mark(cy + y, cx + x);
    }
  }

  for (let index = 0; index < 9; index += 1) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(8, size - 1 - index);
    mark(size - 1 - index, 8);
  }

  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const row = Math.floor(index / 3);
      const column = index % 3;
      mark(row, size - 11 + column);
      mark(size - 11 + column, row);
    }
  }

  return map;
}

/** 並べ替えを逆にたどってデータ語だけを取り出す */
function deinterleave(raw: number[], version: number): number[] {
  const specs: Record<number, [number, number, number, number, number, number]> = {
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
  const [, , group1, size1, group2, size2] = specs[version] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const sizes = [
    ...new Array<number>(group1).fill(size1),
    ...new Array<number>(group2).fill(size2),
  ];
  const blocks: number[][] = sizes.map(() => []);

  let cursor = 0;
  const longest = Math.max(...sizes);
  for (let index = 0; index < longest; index += 1) {
    for (const [position, length] of sizes.entries()) {
      if (index < length) blocks[position]!.push(raw[cursor++] as number);
    }
  }

  return blocks.flat();
}
