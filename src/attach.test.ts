import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildSnapshot, planAttach } from "./attach.ts";
import { RingBuffer } from "./ring-buffer.ts";

const filled = (epoch: string, text: string, capacity?: number) => {
  const buffer = new RingBuffer(epoch, capacity);
  buffer.append(Buffer.from(text, "utf8"));
  return buffer;
};

void describe("planning an attach", () => {
  void test("a first attach with no position gets a snapshot", () => {
    const plan = planAttach(filled("e1", "hello"), undefined, undefined);
    assert.deepEqual(plan, { kind: "snapshot", reason: "no-position" });
  });

  void test("a covered client gets chunks from where it left off", () => {
    const plan = planAttach(filled("e1", "hello"), "e1", 2);
    assert.deepEqual(plan, { kind: "chunks", from: 2 });
  });

  void test("a client at the head gets chunks and nothing to render", () => {
    assert.deepEqual(planAttach(filled("e1", "hello"), "e1", 5), { kind: "chunks", from: 5 });
  });

  void test("a client the buffer has rolled past gets a snapshot", () => {
    // Long-running session, small buffer, phone asleep for an hour.
    const plan = planAttach(filled("e1", "abcdefghij", 4), "e1", 0);
    assert.deepEqual(plan, { kind: "snapshot", reason: "buffer-rolled" });
  });
});

void describe("the epoch branch, which is the one that fails silently", () => {
  void test("a stale epoch is a snapshot even when the seq looks comfortably covered", () => {
    // The server restarted while the phone was asleep. The session is alive with the same id, the
    // client holds a seq the new buffer would happily call covered, and sending chunks would mean
    // the client discards every one as already seen - a tab that paints nothing, forever, while
    // every other signal looks correct.
    const buffer = filled("e2", "fresh output after the restart");
    const plan = planAttach(buffer, "e1", 3);
    assert.deepEqual(plan, { kind: "snapshot", reason: "epoch-changed" });
  });

  void test("a client far ahead of the new counter is still a snapshot, not an error", () => {
    const plan = planAttach(filled("e2", "abc"), "e1", 4_000_000);
    assert.deepEqual(plan, { kind: "snapshot", reason: "epoch-changed" });
  });

  void test("the epoch is checked before coverage, so the two are never mixed", () => {
    // Reasons are distinguishable on purpose: buffer-rolled is a long gap, epoch-changed is a
    // restart, and telling them apart is how "reconnect is uneventful" gets verified rather than
    // assumed.
    const rolled = planAttach(filled("e1", "abcdefghij", 4), "e1", 0);
    const restarted = planAttach(filled("e2", "abcdefghij", 4), "e1", 0);
    assert.notEqual(
      rolled.kind === "snapshot" && rolled.reason,
      restarted.kind === "snapshot" && restarted.reason,
    );
  });

  void test("an epoch that happens to match a different session's is still just an epoch", () => {
    // Epochs are per process and random; equality is the whole test, with no structure implied.
    assert.equal(planAttach(filled("shared", "abc"), "shared", 1).kind, "chunks");
  });
});

void describe("building a cold snapshot", () => {
  void test("carries scrollback, the live bytes, and the seq they end at", () => {
    const buffer = filled("e1", "live screen");
    return buildSnapshot({
      buffer,
      captureHistory: async () => await Promise.resolve("older lines\n"),
    }).then((snapshot) => {
      assert.equal(snapshot.epoch, "e1");
      assert.equal(snapshot.seq, buffer.headSeq);
      assert.equal(snapshot.history, "older lines\n");
      assert.equal(snapshot.data, "live screen");
    });
  });

  void test("history is absent rather than empty when there is none", async () => {
    // In alternate-screen mode there is no scrollback to capture at all. Absent is correct rather
    // than degraded: a full-screen TUI has no history to show, and an empty string would make the
    // client render a blank line it was never sent.
    const snapshot = await buildSnapshot({
      buffer: filled("e1", "tui"),
      captureHistory: async () => await Promise.resolve(""),
    });
    assert.equal("history" in snapshot, false);
  });

  void test("the seq is the buffer's head, so chunks at or below it can be discarded", async () => {
    const buffer = filled("e1", "abcdef");
    const snapshot = await buildSnapshot({
      buffer,
      captureHistory: async () => await Promise.resolve(""),
    });
    assert.equal(snapshot.seq, 6);
    // Everything the snapshot already contains is at or below its seq; a client that discards
    // those cannot double-render the tail.
    assert.ok(buffer.covers("e1", snapshot.seq));
    assert.equal(buffer.since(snapshot.seq).length, 0);
  });
});
