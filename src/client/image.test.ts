import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_EDGE, scaleTo } from "./image.ts";

void describe("scaleTo", () => {
  void test("leaves an image already inside the cap alone", () => {
    assert.deepEqual(scaleTo(390, 844), { width: 390, height: 844 });
  });

  void test("brings the longest edge down to the cap, either orientation", () => {
    assert.equal(Math.max(...Object.values(scaleTo(4032, 3024))), MAX_EDGE);
    assert.equal(Math.max(...Object.values(scaleTo(3024, 4032))), MAX_EDGE);
  });

  void test("keeps the aspect ratio", () => {
    const scaled = scaleTo(4000, 2000);
    assert.equal(scaled.width / scaled.height, 2);
  });

  // A long thin image rounded down puts a 0 on one edge, and a 0-wide canvas encodes to nothing -
  // an upload that succeeds and shows the agent an empty picture.
  void test("never produces a zero edge", () => {
    const scaled = scaleTo(20000, 3);
    assert.ok(scaled.height >= 1, JSON.stringify(scaled));
  });

  void test("a zero-sized image is passed through rather than divided by", () => {
    assert.deepEqual(scaleTo(0, 0), { width: 0, height: 0 });
  });
});
