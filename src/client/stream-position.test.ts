import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { byteLength, receiveChunk, receiveSnapshot } from "./stream-position.ts";

void describe("a snapshot supersedes everything before it", () => {
  void test("it repaints unconditionally and takes the new position", () => {
    const action = receiveSnapshot({ epoch: "e2", seq: 900, data: "screen" });
    assert.deepEqual(action, {
      kind: "repaint",
      data: "screen",
      position: { epoch: "e2", seq: 900 },
    });
  });

  void test("history is written before the live screen when there is any", () => {
    const action = receiveSnapshot({ epoch: "e1", seq: 12, history: "old lines\n", data: "now" });
    assert.deepEqual(action, {
      kind: "repaint",
      history: "old lines\n",
      data: "now",
      position: { epoch: "e1", seq: 12 },
    });
  });

  void test("no history at all is absent rather than empty", () => {
    // Alternate-screen mode: a full-screen TUI has no scrollback to show, which is correct rather
    // than degraded.
    const action = receiveSnapshot({ epoch: "e1", seq: 3, data: "tui" });
    assert.equal("history" in action, false);
  });
});

void describe("chunks against a tracked position", () => {
  const at = (seq: number) => ({ epoch: "e1", seq });

  void test("a contiguous chunk is written and advances the position", () => {
    const action = receiveChunk(at(10), { epoch: "e1", seq: 15, data: "hello" });
    assert.deepEqual(action, {
      kind: "write",
      data: "hello",
      position: { epoch: "e1", seq: 15 },
    });
  });

  void test("a gap asks for a resync rather than rendering a hole", () => {
    // The missing bytes are usually the escape sequence that would have reset the colour.
    const action = receiveChunk(at(10), { epoch: "e1", seq: 40, data: "hello" });
    assert.deepEqual(action, { kind: "resync", haveEpoch: "e1", haveSeq: 10 });
  });

  void test("bytes already rendered are ignored rather than duplicated", () => {
    assert.deepEqual(receiveChunk(at(10), { epoch: "e1", seq: 10, data: "hi" }), {
      kind: "ignore",
    });
    assert.deepEqual(receiveChunk(at(10), { epoch: "e1", seq: 4, data: "hi" }), { kind: "ignore" });
  });

  void test("a chunk that overlaps our position is a resync, not a slice", () => {
    // seq counts bytes and data is a string; cutting at a byte offset can cut a character in half.
    assert.deepEqual(receiveChunk(at(10), { epoch: "e1", seq: 12, data: "abcdef" }), {
      kind: "resync",
      haveEpoch: "e1",
      haveSeq: 10,
    });
  });

  void test("seq is counted in bytes, not characters", () => {
    // A client comparing string lengths would declare a gap on the first emoji an agent printed.
    assert.equal(byteLength("🙂"), 4);
    assert.deepEqual(receiveChunk(at(0), { epoch: "e1", seq: 4, data: "🙂" }), {
      kind: "write",
      data: "🙂",
      position: { epoch: "e1", seq: 4 },
    });
  });
});

void describe("the epoch branch, which is the one that fails silently", () => {
  void test("a chunk from another epoch is a resync, however plausible its seq", () => {
    // The server restarted while the phone was asleep. Rendering this against our old position
    // would paint the tab from a counter that means nothing here.
    const action = receiveChunk(
      { epoch: "e1", seq: 4_000_000 },
      { epoch: "e2", seq: 5, data: "x" },
    );
    assert.deepEqual(action, { kind: "resync", haveEpoch: "e1", haveSeq: 4_000_000 });
  });

  void test("a chunk with no position at all asks from byte zero of its own epoch", () => {
    // The honest statement of what we hold: nothing of that epoch. The server answers with the
    // whole buffer if it still has it and a snapshot if it does not, and both are correct.
    assert.deepEqual(receiveChunk(undefined, { epoch: "e9", seq: 77, data: "x" }), {
      kind: "resync",
      haveEpoch: "e9",
      haveSeq: 0,
    });
  });
});
