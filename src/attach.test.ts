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
    // The server restarted while the phone slept: the session is alive with the same id and the seq
    // would be called covered, so the client discards every chunk as already seen.
    const buffer = filled("e2", "fresh output after the restart");
    const plan = planAttach(buffer, "e1", 3);
    assert.deepEqual(plan, { kind: "snapshot", reason: "epoch-changed" });
  });

  void test("a client far ahead of the new counter is still a snapshot, not an error", () => {
    const plan = planAttach(filled("e2", "abc"), "e1", 4_000_000);
    assert.deepEqual(plan, { kind: "snapshot", reason: "epoch-changed" });
  });

  void test("the epoch is checked before coverage, so the two are never mixed", () => {
    // Reasons are distinguishable on purpose - a long gap and a restart - which is how "reconnect is
    // uneventful" gets verified rather than assumed.
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
  // A repaint IS the stream: tmux writes it into the PTY already being read, so its seq is the
  // buffer's head afterwards. A fake that returned bytes without moving the counter proves nothing.
  const repainting = (buffer: RingBuffer, text: string) => async () => {
    const seq = buffer.append(Buffer.from(text, "utf8"));
    return await Promise.resolve({ data: text, seq });
  };

  void test("carries scrollback, the live bytes, and the seq they end at", async () => {
    const buffer = filled("e1", "output from an hour ago");
    const snapshot = await buildSnapshot({
      buffer,
      captureHistory: async () => await Promise.resolve("older lines\n"),
      alternateScreen: async () => await Promise.resolve(false),
      repaint: repainting(buffer, "live screen"),
    });
    assert.equal(snapshot.epoch, "e1");
    assert.equal(snapshot.seq, buffer.headSeq);
    assert.equal(snapshot.history, "older lines\n");
    assert.equal(snapshot.data, "live screen");
  });

  void test("data is the repaint, not whatever the ring buffer happens to hold", async () => {
    // A session sitting at a prompt for an hour has a live screen nowhere in the buffer, so sending
    // the buffer paints a stale screen and renders every later chunk against it.
    const buffer = filled("e1", "a fragment of an hour-old build log");
    const snapshot = await buildSnapshot({
      buffer,
      captureHistory: async () => await Promise.resolve(""),
      alternateScreen: async () => await Promise.resolve(false),
      repaint: repainting(buffer, "[H[2Jprompt$ "),
    });
    assert.equal(snapshot.data, "[H[2Jprompt$ ");
    assert.equal(snapshot.data.includes("build log"), false);
  });

  void test("in alternate-screen mode history is absent, not captured", async () => {
    // `capture-pane` there returns the alternate screen's contents - the TUI's current frame, not
    // history - so the capture must not happen rather than happen and be discarded.
    const buffer = filled("e1", "");
    let captured = false;
    const snapshot = await buildSnapshot({
      buffer,
      captureHistory: async () => {
        captured = true;
        return await Promise.resolve("what vim currently looks like\n");
      },
      alternateScreen: async () => await Promise.resolve(true),
      repaint: repainting(buffer, "vim, repainted"),
    });
    assert.equal("history" in snapshot, false);
    assert.equal(captured, false);
    assert.equal(snapshot.data, "vim, repainted");
  });

  void test("history is absent rather than empty when there is none", async () => {
    // An empty string would make the client render a blank line it was never sent.
    const buffer = filled("e1", "");
    const snapshot = await buildSnapshot({
      buffer,
      captureHistory: async () => await Promise.resolve(""),
      alternateScreen: async () => await Promise.resolve(false),
      repaint: repainting(buffer, "screen"),
    });
    assert.equal("history" in snapshot, false);
  });

  void test("the seq is the one the repaint reflects, so chunks at or below it are stale", async () => {
    const buffer = filled("e1", "abcdef");
    const snapshot = await buildSnapshot({
      buffer,
      captureHistory: async () => await Promise.resolve(""),
      alternateScreen: async () => await Promise.resolve(false),
      repaint: repainting(buffer, "0123"),
    });
    assert.equal(snapshot.seq, 10);
    assert.equal(snapshot.seq, buffer.headSeq);
    // Everything the snapshot already contains is at or below its seq; a client that discards
    // those cannot double-render the repaint.
    assert.ok(buffer.covers("e1", snapshot.seq));
    assert.equal(buffer.since(snapshot.seq).length, 0);
  });
});
