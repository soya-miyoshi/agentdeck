import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PANE_COLS } from "../protocol.ts";
import { cellRatio, fontSizeFor, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./pane-fit.ts";

// A simulated terminal, so the property is "the columns fill the pane" rather than any arithmetic.
// The real PANE_COLS rather than a number of this file's own, because it has already moved once.
const RESERVE = 14;
const COLUMNS = PANE_COLS;

const proposeCols = (width: number, fontSize: number, advance: number): number =>
  Math.max(2, Math.floor((width - RESERVE) / (fontSize * advance)));

// What the pane would actually look like: the pixels the columns occupy, and what is left over.
const leftover = (width: number, fontSize: number, advance: number): number =>
  width - COLUMNS * fontSize * advance;

void describe("sizing the font so the deck's columns fill the pane", () => {
  void test("the dead margin is under one probe-size cell on every phone width and font", () => {
    // Every width a phone plausibly hands the pane. The residual cannot be zero - the only measurement
    // is a WHOLE column count - and the high estimate is deliberate: too large clips the last column.
    for (const width of [320, 360, 375, 390, 393, 402, 430, 744, 820]) {
      for (const advance of [0.5, 0.55, 0.6, 0.62, 0.667]) {
        const probe = MIN_FONT_SIZE;
        const ratio = cellRatio(width, RESERVE, proposeCols(width, probe, advance), probe, COLUMNS);
        assert.ok(ratio !== undefined, `no ratio at width ${width}`);
        const size = fontSizeFor(width, COLUMNS, ratio);
        // A pane wide enough to want text past MAX_FONT_SIZE is the clamp doing its job, not a
        // fit failure, and it keeps its margin. See the landscape test below.
        if (size === MAX_FONT_SIZE) continue;
        const gap = leftover(width, size, advance);
        assert.ok(
          gap >= 0 && gap < 5,
          `width ${width} advance ${advance}: ${String(gap)}px of margin at font ${String(size)}`,
        );
      }
    }
  });

  void test("a pane too wide for legible columns keeps its margin rather than shouting", () => {
    // A desktop window, where filling PANE_COLS would need text sized for a room, so the clamp holds.
    // Recorded because it looks exactly like the bug above and is not it.
    const advance = 0.6;
    const ratio = cellRatio(1400, RESERVE, proposeCols(1400, MIN_FONT_SIZE, advance), 6, COLUMNS);
    assert.ok(ratio !== undefined);
    assert.equal(fontSizeFor(1400, COLUMNS, ratio), MAX_FONT_SIZE);
    assert.ok(leftover(1400, MAX_FONT_SIZE, advance) > 100);
  });

  void test("the columns never overflow the pane, which would clip the last one", () => {
    for (const width of [320, 375, 393, 430]) {
      for (const advance of [0.5, 0.6, 0.667]) {
        const ratio = cellRatio(
          width,
          RESERVE,
          proposeCols(width, MIN_FONT_SIZE, advance),
          MIN_FONT_SIZE,
          COLUMNS,
        );
        assert.ok(ratio !== undefined);
        assert.ok(
          leftover(width, fontSizeFor(width, COLUMNS, ratio), advance) >= 0,
          `width ${width} advance ${advance} overflows`,
        );
      }
    }
  });

  void test("the reserve the addon takes off the width is added back, not left in the ratio", () => {
    // The addon reserves 14px for a ruler this deck does not draw, and `|| 14` means zero cannot turn
    // it off. Ignoring it makes the ratio too large and the font too small, forever.
    const advance = 0.6;
    const cols = proposeCols(393, MIN_FONT_SIZE, advance);
    const right = cellRatio(393, RESERVE, cols, MIN_FONT_SIZE, COLUMNS);
    const ignoring = cellRatio(393, 0, cols, MIN_FONT_SIZE, COLUMNS);
    assert.ok(right !== undefined && ignoring !== undefined);
    assert.ok(ignoring > right, "ignoring the reserve did not inflate the ratio");
    assert.ok(
      leftover(393, fontSizeFor(393, COLUMNS, ignoring), advance) > 10,
      "ignoring the reserve should cost visible margin, or this test proves nothing",
    );
  });

  void test("a pane that is not laid out yet yields no ratio rather than a wrong one", () => {
    // Measured once and never revisited, so a ratio taken before layout would be permanent.
    assert.equal(cellRatio(0, RESERVE, 2, MIN_FONT_SIZE, COLUMNS), undefined);
    assert.equal(cellRatio(393, RESERVE, 2, MIN_FONT_SIZE, COLUMNS), undefined);
    assert.equal(cellRatio(393, RESERVE, 100, 0, COLUMNS), undefined);
    assert.equal(cellRatio(10, RESERVE, 100, MIN_FONT_SIZE, COLUMNS), undefined);
  });

  void test("the size stays inside the bounds a person can read and the pane can hold", () => {
    // A very wide pane would otherwise scale the text past legibility as furniture, and a very
    // narrow one past nothing at all.
    assert.equal(fontSizeFor(4000, COLUMNS, 0.6 * 1), MAX_FONT_SIZE);
    assert.equal(fontSizeFor(50, COLUMNS, 0.6 * 1), MIN_FONT_SIZE);
    assert.equal(fontSizeFor(393, COLUMNS, 0), MIN_FONT_SIZE);
  });

  void test("the font is not rounded to a whole pixel, which is what left the margin", () => {
    // A spread of widths rather than one: flooring costs the fractional part times the column count,
    // so at SOME widths it costs nothing and a single-width test becomes a tautology.
    const advance = 0.6;
    let worst = 0;
    let fractional = false;
    for (const width of [320, 360, 375, 390, 393, 402, 430]) {
      const ratio = cellRatio(
        width,
        RESERVE,
        proposeCols(width, MIN_FONT_SIZE, advance),
        6,
        COLUMNS,
      );
      assert.ok(ratio !== undefined);
      const size = fontSizeFor(width, COLUMNS, ratio);
      if (size !== Math.floor(size)) fractional = true;
      worst = Math.max(
        worst,
        leftover(width, Math.floor(size), advance) - leftover(width, size, advance),
      );
    }
    assert.ok(fractional, "every size came out whole, so the rounding is back");
    assert.ok(
      worst > 10,
      `flooring only ever cost ${String(worst)}px, so this test proves nothing`,
    );
  });
});
