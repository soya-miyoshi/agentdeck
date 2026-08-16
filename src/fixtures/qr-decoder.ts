// A QR decoder written from the spec, sharing no code with the encoder under test. It reads the
// mask out of the format information rather than assuming one, and does NO error correction.

const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

// Alignment pattern centres, versions 1 to 6. Past 6 the grid carries version information this does
// not read, so it refuses rather than silently mis-decoding.
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
];

// Blocks and data codewords per block at level M, versions 1 to 6. Data is interleaved codeword-wise
// rather than block by block, and a 43-character token is version 4 - two blocks, not a corner case.
const BLOCKS_M: readonly (readonly [blocks: number, dataPerBlock: number])[] = [
  [0, 0],
  [1, 16],
  [1, 28],
  [1, 44],
  [2, 32],
  [2, 43],
  [4, 27],
];

/** The quiet zone `src/qr.ts` renders around the code, in modules. */
export const QUIET_MODULES = 4;

const at = (grid: readonly (readonly boolean[])[], row: number, col: number): boolean => {
  const value = grid[row]?.[col];
  if (value === undefined) throw new Error(`module ${String(row)},${String(col)} is off the grid`);
  return value;
};

/** Which modules are structure rather than data, and so are skipped by the walk. */
const functionMap = (size: number, version: number): boolean[][] => {
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const block = (top: number, left: number, height: number, width: number): void => {
    for (let r = top; r < top + height; r += 1)
      for (let c = left; c < left + width; c += 1) (reserved[r] as boolean[])[c] = true;
  };
  // The three finder patterns with their separators, each of which also covers the format
  // information strip beside it.
  block(0, 0, 9, 9);
  block(0, size - 8, 9, 8);
  block(size - 8, 0, 8, 9);
  // Timing patterns.
  block(6, 0, 1, size);
  block(0, 6, size, 1);
  const centres = ALIGNMENT[version] ?? [];
  for (const r of centres) {
    for (const c of centres) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      block(r - 2, c - 2, 5, 5);
    }
  }
  return reserved;
};

/** The mask and error correction level, from the format information down column 8. */
export const readFormat = (
  grid: readonly (readonly boolean[])[],
): { mask: number; level: number } => {
  const size = grid.length;
  let bits = 0;
  for (let i = 0; i < 15; i += 1) {
    const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    if (at(grid, row, 8)) bits |= 1 << i;
  }
  // The format information is masked with 0x5412 before it is written, so that an all-zero format
  // is not an all-light region. Unmasking is the whole of reading it back.
  const data = (bits ^ 0x5412) >> 10;
  // The low three bits are the mask pattern; the high two are the error correction level, in the
  // spec's own order where M is 0.
  return { mask: data & 7, level: data >> 3 };
};

/** The module grid back to the string that was encoded into it. */
export const decodeGrid = (grid: readonly (readonly boolean[])[]): string => {
  const size = grid.length;
  if ((size - 17) % 4 !== 0) throw new Error("grid is not a whole number of versions across");
  const version = (size - 17) / 4;
  if (version < 1 || version > 6)
    throw new Error(`version ${String(version)} is outside this decoder`);
  for (const row of grid) if (row.length !== size) throw new Error("grid is not square");

  const { mask, level } = readFormat(grid);
  if (level !== 0) throw new Error("error correction level in the format information is not M");
  const masked = MASKS[mask] as (row: number, col: number) => boolean;
  const reserved = functionMap(size, version);

  // The zig-zag: two-module-wide columns from the right, alternating upwards and downwards, with
  // column 6 skipped because the vertical timing pattern lives there.
  const bits: boolean[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if ((reserved[row] as boolean[])[c] === true) continue;
        bits.push(at(grid, row, c) !== masked(row, c));
      }
    }
    upward = !upward;
  }

  // Bits back into codewords, then codewords back out of the interleave.
  const stream: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let value = 0;
    for (let b = 0; b < 8; b += 1) value = (value << 1) | (bits[i + b] === true ? 1 : 0);
    stream.push(value);
  }
  const [blocks, dataPerBlock] = BLOCKS_M[version] as readonly [number, number];
  const data: number[] = [];
  for (let block = 0; block < blocks; block += 1)
    for (let i = 0; i < dataPerBlock; i += 1) data.push(stream[i * blocks + block] as number);

  const message = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((bit) => (byte >> bit) & 1));
  let cursor = 0;
  const take = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | (message[cursor++] ?? 0);
    return value;
  };

  if (take(4) !== 0b0100) throw new Error("mode indicator is not byte mode");
  // Byte mode length is eight bits up to version 9.
  const length = take(8);
  const bytes = Buffer.from(Array.from({ length }, () => take(8)));
  // Latin-1, matching the encoder's own `charCodeAt(i) & 0xff`. Decoding as UTF-8 here would
  // paper over exactly the truncation that reading the dependency turned up.
  return bytes.toString("latin1");
};

/**
 * The rendered terminal lines back to a grid, the way a camera sees them - one text row is TWO
 * module rows. Reading it back this way catches a swapped foreground, or a line that lost its reset.
 */
export const gridFromLines = (lines: readonly string[]): boolean[][] => {
  const rows: boolean[][] = [];
  for (const line of lines) {
    const cells = line.split("[").slice(1, -1);
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const cell of cells) {
      const [fg, bg] = (cell.split("m")[0] ?? "").split(";");
      // 30 is black on the upper half, 40 black on the lower; anything else is the light module.
      top.push(fg === "30");
      bottom.push(bg === "40");
    }
    rows.push(top, bottom);
  }
  // The padded code is square, so one bound trims both axes - taken from a row, because the last
  // text line carries a module row past the bottom edge whenever the padded size is odd.
  const padded = rows[0]?.length ?? 0;
  return rows
    .slice(QUIET_MODULES, padded - QUIET_MODULES)
    .map((row) => row.slice(QUIET_MODULES, padded - QUIET_MODULES));
};

/** The lines a terminal was given, decoded back to the string that was encoded. */
export const decodeLines = (lines: readonly string[]): string => decodeGrid(gridFromLines(lines));

/** The QR block out of a larger stream of terminal output: the lines made of half blocks. */
export const qrBlockLines = (output: string): string[] =>
  output.split("\n").filter((line) => line.includes("▀") && line.includes("["));
