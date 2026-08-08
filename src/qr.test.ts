import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { clientUrl, firstRunLines, qrLines, qrModules } from "./qr.ts";
import { generateToken } from "./token.ts";

// A QR code is verified by decoding it, not by looking at it. Eyeballing the blocks confirms that
// something square was printed; it says nothing about whether a phone can read it, and every
// interesting bug in this area - a mask applied twice, a transposed grid, a missing quiet zone,
// an off-by-one in the zig-zag walk - produces a square that looks perfect and scans as nothing.
//
// So this file contains a decoder, written from the spec rather than from the encoder, and it
// shares no code with the encoder: it reads the format information out of the grid to learn which
// mask was used, rebuilds the function-module map itself, walks the data region and reassembles
// the bytes. It does not do error correction, which means it also proves that the data codewords
// are right on their own rather than being repaired on the way out.

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

// Alignment pattern centre coordinates, versions 1 to 6. Beyond version 6 the grid also carries
// version information blocks, which this decoder does not read - so it asserts the version
// instead of silently mis-decoding one it does not handle.
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
];

// Blocks and data codewords per block at error correction level M, versions 1 to 6. The data is
// not laid down block by block: it is interleaved codeword-wise, so that a burst of damage across
// the printed code is spread over every block instead of destroying one of them. A 43-character
// token needs 45 data codewords, which is version 4 - two blocks - so this is not a corner the
// tests could skip. Every version up to 6 has equal-sized blocks, which is why one pair suffices.
const BLOCKS_M: readonly (readonly [blocks: number, dataPerBlock: number])[] = [
  [0, 0],
  [1, 16],
  [1, 28],
  [1, 44],
  [2, 32],
  [2, 43],
  [4, 27],
];

const at = (grid: readonly (readonly boolean[])[], row: number, col: number): boolean => {
  const value = grid[row]?.[col];
  assert.notEqual(value, undefined, `module ${String(row)},${String(col)} is off the grid`);
  return value === true;
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
  for (const r of ALIGNMENT[version] ?? []) {
    for (const c of ALIGNMENT[version] ?? []) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      block(r - 2, c - 2, 5, 5);
    }
  }
  return reserved;
};

/** The 15-bit format information, from the copy that runs down column 8 and along row 8. */
const readMask = (grid: readonly (readonly boolean[])[], size: number): number => {
  let bits = 0;
  for (let i = 0; i < 15; i += 1) {
    const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    if (at(grid, row, 8)) bits |= 1 << i;
  }
  // The format information is masked with 0x5412 before it is written, so that an all-zero format
  // is not an all-light region. Unmasking is the whole of reading it back.
  const data = (bits ^ 0x5412) >> 10;
  // The low three bits are the mask pattern; the high two are the error correction level, in the
  // spec's own order where M is 0. src/qr.ts asks for M, so this doubles as a check that the
  // level reached the grid.
  assert.equal(data >> 3, 0, "error correction level in the format information is not M");
  return data & 7;
};

const decode = (grid: readonly (readonly boolean[])[]): string => {
  const size = grid.length;
  assert.equal((size - 17) % 4, 0, "grid is not a whole number of versions across");
  const version = (size - 17) / 4;
  assert.ok(version >= 1 && version <= 6, `version ${String(version)} is outside this decoder`);
  for (const row of grid) assert.equal(row.length, size, "grid is not square");

  const mask = readMask(grid, size);
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

  assert.equal(take(4), 0b0100, "mode indicator is not byte mode");
  // Byte mode length is eight bits up to version 9.
  const length = take(8);
  const bytes = Buffer.from(Array.from({ length }, () => take(8)));
  return bytes.toString("latin1");
};

void describe("qr", () => {
  void test("a generated token decodes back out of the grid it was encoded into", () => {
    const token = generateToken();
    assert.equal(decode(qrModules(token)), token);
  });

  void test("the printed lines decode back, not just the grid behind them", () => {
    // What a phone photographs is the terminal, not the array. So this reads the rendered lines
    // back the way a camera would - each half block is two module rows, foreground on top,
    // background underneath - strips the quiet zone off again, and decodes that. It is the check
    // that catches an off-by-one in the quiet zone or a swapped foreground and background, both
    // of which leave `qrModules` perfectly correct.
    const token = generateToken();
    const lines = firstRunLines(token, "http://127.0.0.1:7777", "/tmp/token").filter((line) =>
      line.includes("["),
    );
    const rows: boolean[][] = [];
    for (const line of lines) {
      const cells = line.split("[").slice(1, -1);
      const top: boolean[] = [];
      const bottom: boolean[] = [];
      for (const cell of cells) {
        const [fg, bg] = (cell.split("m")[0] ?? "").split(";");
        top.push(fg === "30");
        bottom.push(bg === "40");
      }
      rows.push(top, bottom);
    }
    const size = rows[0]?.length ?? 0;
    const inner = rows
      .slice(4, size - 4)
      .map((row) => row.slice(4, size - 4))
      .filter((row) => row.length > 0);
    assert.equal(decode(inner), token);
  });

  void test("decodes tokens from many runs, not one lucky grid", () => {
    // The mask is chosen per code by a penalty search, and the version by length, so a single
    // sample exercises one mask out of eight. Fifty random tokens is enough to see several.
    for (let i = 0; i < 50; i += 1) {
      const token = generateToken();
      assert.equal(decode(qrModules(token)), token);
    }
  });

  void test("the decoder is not a mirror of the encoder: a flipped module breaks it", () => {
    // Guards against the failure mode where a decoder written alongside an encoder shares the
    // same misunderstanding and agrees with it. Corrupting one data module must change what comes
    // out - which it does only if the walk is genuinely reading the data region.
    const token = generateToken();
    const grid = qrModules(token);
    const last = grid.length - 1;
    (grid[last] as boolean[])[last] = !(grid[last] as boolean[])[last];
    let decoded: string | undefined;
    try {
      decoded = decode(grid);
    } catch {
      // A flip in the mode indicator makes the stream unreadable rather than merely different.
      decoded = undefined;
    }
    assert.notEqual(decoded, token);
  });

  void test("renders half a module row per line, with the quiet zone", () => {
    const modules = qrModules(generateToken());
    const lines = qrLines("x".repeat(43));
    const width = qrModules("x".repeat(43)).length + 8;
    assert.equal(lines.length, Math.ceil(width / 2));
    // One character per module column, each preceded by its own colour escape, and one reset at
    // the end of the line.
    for (const line of lines) {
      assert.equal(line.split("\u001b[").length - 1, width + 1);
      assert.ok(line.endsWith("\u001b[0m"));
    }
    assert.ok(modules.length >= 21);
  });

  void test("the first-run block prints the URL and the token file beside the code", () => {
    const token = generateToken();
    const lines = firstRunLines(token, "http://127.0.0.1:7777", "/home/x/.agentdeck/token");
    const text = lines.join("\n");
    assert.ok(text.includes("http://127.0.0.1:7777"));
    assert.ok(text.includes("/home/x/.agentdeck/token"));
    // The token itself is never printed as text. Printing it beside the QR would put the
    // credential in the terminal's own scrollback and in any log the operator is capturing, which
    // is the thing the file's 0600 mode exists to avoid.
    assert.ok(!text.includes(token));
  });

  void test("the URL is the configured origin when there is one, and never a guessed ts.net", () => {
    assert.equal(
      clientUrl("https://host.tailXXXXXX.ts.net", 7777),
      "https://host.tailXXXXXX.ts.net",
    );
    assert.equal(clientUrl(undefined, 7777), "http://127.0.0.1:7777");
    // The hostname of a tailnet this process may not be on is not derivable from here, and
    // m4/tailscale-serve has not put anything in front of the port yet.
    assert.ok(!clientUrl(undefined, 7777).includes("ts.net"));
  });

  void test("the encoder stays out of the browser bundle", async () => {
    // It is a server-side need: the QR goes to a terminal. Pulling it into the client would spend
    // the sixth dependency on bytes the phone downloads and never runs.
    const dir = join(import.meta.dirname, "client");
    const files = await readdir(dir, { recursive: true });
    for (const file of files) {
      if (!/\.(ts|vue)$/.test(file)) continue;
      const source = readFileSync(join(dir, file), "utf8");
      assert.ok(
        !source.includes("qrcode-generator") && !source.includes("./qr.ts"),
        `${file} imports the QR encoder, which is server-side only`,
      );
    }
  });

  void test("the encoder has no transitive dependencies", () => {
    // Plan 003 allows the sixth dependency on the condition that it is one that can be read. A
    // package that arrives with a tree behind it spends the budget more than once, and it would do
    // so quietly - nothing else in this repo would notice.
    const manifest: unknown = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "node_modules", "qrcode-generator", "package.json"),
        "utf8",
      ),
    );
    const deps = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {};
    assert.deepEqual(Object.keys(deps), []);
    assert.equal((manifest as { version: string }).version, "2.0.4");
  });
});
