import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { cellRatio, fontSizeFor, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./pane-fit.ts";

// A simulated terminal, so the property under test is "the 40 columns fill the pane" rather than
// any particular arithmetic. `advance` is the font's cell width per pixel of font size; 0.6 is
// about what a monospace face gives, and the tests do not depend on the value.
const RESERVE = 14;
const COLUMNS = 40;

const proposeCols = (width: number, fontSize: number, advance: number): number =>
  Math.max(2, Math.floor((width - RESERVE) / (fontSize * advance)));

// What the pane would actually look like: the pixels the 40 columns occupy, and what is left over.
const leftover = (width: number, fontSize: number, advance: number): number =>
  width - COLUMNS * fontSize * advance;

void describe("sizing the font so the deck's columns fill the pane", () => {
  void test("the dead margin is under one probe-size cell on every phone width and font", () => {
    // Every width a phone in portrait or landscape plausibly hands the pane, against faces from
    // narrow to wide. The old code floored the font and left tens of pixels on several of these.
    //
    // The residual is not zero and cannot be: the only measurement available is a WHOLE column
    // count, so the cell width read back is high by up to one column's share of the pane. Taking
    // the high estimate is deliberate - it makes the font too small rather than too large, and too
    // large clips the fortieth column. The bound is therefore about one cell AT THE PROBE SIZE,
    // which is why the probe is the smallest font the deck will use.
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

  void test("a pane too wide for 40 legible columns keeps its margin rather than shouting", () => {
    // Landscape and iPad. 40 columns across 744px is 18px cells, which is furniture rather than
    // text, so the clamp holds and the rest of the pane stays empty. Recorded because it looks
    // exactly like the bug above and is not it: the deck is 40 columns by decision, and the
    // alternative to a margin here is text sized for a room.
    const advance = 0.6;
    const ratio = cellRatio(744, RESERVE, proposeCols(744, MIN_FONT_SIZE, advance), 6, COLUMNS);
    assert.ok(ratio !== undefined);
    assert.equal(fontSizeFor(744, COLUMNS, ratio), MAX_FONT_SIZE);
    assert.ok(leftover(744, MAX_FONT_SIZE, advance) > 100);
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
    // The addon subtracts 14px for an overview ruler this deck does not draw, and the reserve
    // cannot be configured to zero - `overviewRuler?.width || 14` reads 0 as absent. Ignoring it
    // makes the ratio too large and the font too small by that fraction, forever.
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
    const advance = 0.6;
    const ratio = cellRatio(393, RESERVE, proposeCols(393, MIN_FONT_SIZE, advance), 6, COLUMNS);
    assert.ok(ratio !== undefined);
    const size = fontSizeFor(393, COLUMNS, ratio);
    assert.notEqual(size, Math.floor(size), "a whole-pixel size means the rounding is back");
    // And the floor it replaced really is worse on this width, by most of a column of text.
    assert.ok(
      leftover(393, Math.floor(size), advance) - leftover(393, size, advance) > 5,
      "flooring the font should cost visible margin, or this test proves nothing",
    );
  });
});
