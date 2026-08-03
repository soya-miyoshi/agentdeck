import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RingBuffer } from "./ring-buffer.ts";

const buf = (s: string): Buffer => Buffer.from(s, "utf8");

void describe("ring buffer: seq is a byte count", () => {
  void test("headSeq counts bytes, not messages", () => {
    const ring = new RingBuffer("e1");
    assert.equal(ring.headSeq, 0);
    ring.append(buf("hello"));
    assert.equal(ring.headSeq, 5);
    ring.append(buf("!"));
    assert.equal(ring.headSeq, 6);
  });

  void test("an empty append does not move the counter", () => {
    const ring = new RingBuffer("e1");
    ring.append(buf("abc"));
    ring.append(Buffer.alloc(0));
    assert.equal(ring.headSeq, 3);
  });

  void test("multi-byte characters count as bytes", () => {
    // The counter has to agree with what the socket actually carried, not with string length.
    const ring = new RingBuffer("e1");
    const chunk = buf("日本語");
    ring.append(chunk);
    assert.equal(ring.headSeq, chunk.length);
    assert.equal(ring.headSeq, 9);
  });
});

void describe("ring buffer: the coverage test is two-sided", () => {
  void test("serves a client inside the window", () => {
    const ring = new RingBuffer("e1");
    ring.append(buf("abcdef"));
    assert.equal(ring.covers("e1", 2), true);
    assert.equal(ring.since(2).toString(), "cdef");
  });

  void test("a client at headSeq is covered and gets nothing", () => {
    const ring = new RingBuffer("e1");
    ring.append(buf("abc"));
    assert.equal(ring.covers("e1", 3), true);
    assert.equal(ring.since(3).length, 0);
  });

  void test("a client below tailSeq is not covered", () => {
    const ring = new RingBuffer("e1", 4);
    ring.append(buf("abcdefgh"));
    assert.equal(ring.tailSeq, 4);
    assert.equal(ring.covers("e1", 3), false);
    assert.equal(ring.covers("e1", 4), true);
  });

  void test("a client AHEAD of headSeq is not covered, which is the assertion that matters", () => {
    // Redundant once epochs are correct - which is exactly why it is here. If it ever fires,
    // epochs are broken, and the alternative is sending chunks a client discards as already seen
    // while its tab stays blank forever and every other signal looks healthy.
    const ring = new RingBuffer("e1");
    ring.append(buf("abc"));
    assert.equal(ring.covers("e1", 9_999), false);
  });

  void test("since() refuses a position outside the window rather than returning a hole", () => {
    const ring = new RingBuffer("e1", 4);
    ring.append(buf("abcdefgh"));
    assert.throws(() => ring.since(0), RangeError);
    assert.throws(() => ring.since(99), RangeError);
  });
});

void describe("ring buffer: epoch gates the arithmetic", () => {
  void test("a mismatched epoch is never covered, whatever the numbers say", () => {
    const ring = new RingBuffer("e2");
    ring.append(buf("abcdef"));
    // A seq that would be comfortably inside the window if the epochs matched.
    assert.equal(ring.covers("e1", 2), false);
  });

  void test("a missing epoch is never covered", () => {
    const ring = new RingBuffer("e2");
    ring.append(buf("abcdef"));
    assert.equal(ring.covers(undefined, 2), false);
  });

  void test("the restart case: same id, client far ahead, fresh counter", () => {
    // The client attaches after a server restart holding a seq in the millions. The session is
    // still alive with the same id, so nothing else looks wrong. Without the epoch this returns
    // true and the tab never paints again.
    const afterRestart = new RingBuffer("e2");
    afterRestart.append(buf("fresh output"));
    assert.equal(afterRestart.covers("e1", 4_000_000), false);
  });

  void test("a non-integer seq is not covered", () => {
    const ring = new RingBuffer("e1");
    ring.append(buf("abcdef"));
    assert.equal(ring.covers("e1", 1.5), false);
    assert.equal(ring.covers("e1", Number.NaN), false);
  });
});

void describe("ring buffer: eviction keeps tailSeq exact", () => {
  void test("holds at most `capacity` bytes", () => {
    const ring = new RingBuffer("e1", 8);
    for (let i = 0; i < 10; i++) ring.append(buf("xyz"));
    assert.ok(ring.byteLength <= 8, `held ${String(ring.byteLength)} bytes`);
  });

  void test("evicting part of a chunk still serves a client inside it", () => {
    // The reason eviction slices rather than dropping whole chunks: `covers` must never claim
    // more than `since` can deliver, or the client renders a hole where an escape sequence was.
    const ring = new RingBuffer("e1", 5);
    ring.append(buf("abcdefgh"));
    assert.equal(ring.tailSeq, 3);
    assert.equal(ring.covers("e1", 3), true);
    assert.equal(ring.since(3).toString(), "defgh");
  });

  void test("covers and since agree at every position in the window", () => {
    const ring = new RingBuffer("e1", 6);
    ring.append(buf("abcd"));
    ring.append(buf("efgh"));
    ring.append(buf("ij"));
    for (let seq = 0; seq <= ring.headSeq + 2; seq++) {
      if (ring.covers("e1", seq)) {
        assert.doesNotThrow(() => ring.since(seq), `covers(${String(seq)}) but since() threw`);
      } else {
        assert.throws(() => ring.since(seq), `since(${String(seq)}) worked but covers() said no`);
      }
    }
  });

  void test("headSeq keeps counting past eviction", () => {
    const ring = new RingBuffer("e1", 4);
    ring.append(buf("abcdefghij"));
    assert.equal(ring.headSeq, 10);
    assert.equal(ring.snapshot().toString(), "ghij");
  });

  void test("rejects a nonsense capacity", () => {
    assert.throws(() => new RingBuffer("e1", 0), RangeError);
  });
});
