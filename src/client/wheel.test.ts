import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { scrollTarget, wheelBytes, wheelDrag } from "./wheel.ts";

const ESC = String.fromCharCode(27);

void describe("scrollTarget", () => {
  void test("scrolls locally when no application is tracking the mouse", () => {
    assert.equal(scrollTarget("none"), "local");
  });

  void test("stays local for x10, which reports presses and has no wheel", () => {
    assert.equal(scrollTarget("x10"), "local");
  });

  void test("hands the drag to an application that tracks the mouse", () => {
    assert.equal(scrollTarget("vt200"), "application");
    assert.equal(scrollTarget("drag"), "application");
    assert.equal(scrollTarget("any"), "application");
  });
});

void describe("wheelBytes", () => {
  void test("reports a wheel up as SGR button 64 at the cell", () => {
    assert.equal(wheelBytes("up", 40, 10), `${ESC}[<64;40;10M`);
  });

  void test("reports a wheel down as button 65", () => {
    assert.equal(wheelBytes("down", 1, 1), `${ESC}[<65;1;1M`);
  });

  void test("never addresses a cell before the first one", () => {
    assert.equal(wheelBytes("up", 0, -3), `${ESC}[<64;1;1M`);
  });
});

void describe("wheelDrag", () => {
  void test("sends one report per line, earlier output being a wheel up", () => {
    assert.equal(wheelDrag(-2, 5, 6), `${ESC}[<64;5;6M${ESC}[<64;5;6M`);
  });

  void test("sends wheel downs for a positive delta", () => {
    assert.equal(wheelDrag(3, 5, 6), `${ESC}[<65;5;6M`.repeat(3));
  });

  void test("sends nothing for a drag that has not crossed a row", () => {
    assert.equal(wheelDrag(0, 5, 6), "");
  });
});
