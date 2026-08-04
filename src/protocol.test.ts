import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { paneSize, parseClientMessage } from "./protocol.ts";

const ok = (raw: unknown) => {
  const result = parseClientMessage(JSON.stringify(raw));
  assert.ok("message" in result, `expected a message, got: ${JSON.stringify(result)}`);
  return result.message;
};

const err = (raw: unknown) => {
  const result = parseClientMessage(typeof raw === "string" ? raw : JSON.stringify(raw));
  assert.ok("error" in result, `expected an error, got: ${JSON.stringify(result)}`);
  return result.error;
};

void describe("parsing client frames", () => {
  void test("attach carries a viewport", () => {
    const message = ok({ t: "attach", sessionId: "s1", cols: 80, rows: 24 });
    assert.deepEqual(message, { t: "attach", sessionId: "s1", cols: 80, rows: 24 });
  });

  void test("attach carries a resume position only when epoch and seq travel together", () => {
    // A seq without an epoch is a number in no particular space. Treating it as a position is
    // exactly the mistake the epoch exists to prevent, so it is dropped rather than honoured.
    const withBoth = ok({
      t: "attach",
      sessionId: "s1",
      cols: 80,
      rows: 24,
      haveEpoch: "e1",
      haveSeq: 42,
    });
    assert.equal("haveSeq" in withBoth && withBoth.haveSeq, 42);

    const seqOnly = ok({ t: "attach", sessionId: "s1", cols: 80, rows: 24, haveSeq: 42 });
    assert.equal("haveSeq" in seqOnly, false, "a seq with no epoch must not become a position");

    const epochOnly = ok({ t: "attach", sessionId: "s1", cols: 80, rows: 24, haveEpoch: "e1" });
    assert.equal("haveEpoch" in epochOnly, false);
  });

  void test("resync demands both, because its whole purpose is a position", () => {
    assert.match(err({ t: "resync", sessionId: "s1", haveSeq: 5 }), /haveEpoch/);
    assert.match(err({ t: "resync", sessionId: "s1", haveEpoch: "e1" }), /haveSeq/);
    const message = ok({ t: "resync", sessionId: "s1", haveEpoch: "e1", haveSeq: 5 });
    assert.deepEqual(message, { t: "resync", sessionId: "s1", haveEpoch: "e1", haveSeq: 5 });
  });

  void test("input takes a string, including an empty one", () => {
    // An empty string is a real thing to send; only a non-string is a refusal.
    assert.deepEqual(ok({ t: "input", sessionId: "s1", data: "" }), {
      t: "input",
      sessionId: "s1",
      data: "",
    });
    assert.match(err({ t: "input", sessionId: "s1", data: 42 }), /string data/);
  });
});

void describe("refusals are sentences, and nonsense never reaches the session", () => {
  void test("malformed JSON", () => {
    assert.match(err("{not json"), /not JSON/);
  });

  void test("no sessionId", () => {
    assert.match(err({ t: "attach", cols: 80, rows: 24 }), /sessionId/);
  });

  void test("unknown type names what it did not recognise", () => {
    assert.match(err({ t: "teleport", sessionId: "s1" }), /teleport/);
  });

  void test("dimensions must be integers in range", () => {
    for (const bad of [0, -1, 1.5, 100_000, Number.NaN, "80"]) {
      assert.match(
        err({ t: "attach", sessionId: "s1", cols: bad, rows: 24 }),
        /cols and rows/,
        `accepted cols: ${String(bad)}`,
      );
      assert.match(
        err({ t: "resize", sessionId: "s1", cols: 80, rows: bad }),
        /cols and rows/,
        `accepted rows: ${String(bad)}`,
      );
    }
  });

  void test("an array is not a message", () => {
    assert.match(err([1, 2, 3]), /not an object/);
  });

  void test("null is not a message", () => {
    assert.match(err("null"), /not an object/);
  });
});

void describe("pane size is the minimum over attached clients", () => {
  void test("one client gets its own size", () => {
    assert.deepEqual(paneSize([{ cols: 80, rows: 24 }]), { cols: 80, rows: 24 });
  });

  void test("two clients get the smaller of each dimension, independently", () => {
    // Not the smaller client - the smaller of each dimension. A tall narrow phone and a short
    // wide laptop must not produce a pane neither can display.
    assert.deepEqual(
      paneSize([
        { cols: 200, rows: 20 },
        { cols: 60, rows: 60 },
      ]),
      { cols: 60, rows: 20 },
    );
  });

  void test("no clients resizes nothing", () => {
    // With no clients attached the pane keeps the last size anyone asked for, so this must be
    // undefined rather than a default that would silently reflow an unwatched session.
    assert.equal(paneSize([]), undefined);
  });

  void test("a client detaching lets the pane grow back", () => {
    const attached = new Map([
      ["phone", { cols: 60, rows: 40 }],
      ["laptop", { cols: 200, rows: 50 }],
    ]);
    assert.deepEqual(paneSize(attached.values()), { cols: 60, rows: 40 });
    attached.delete("phone");
    assert.deepEqual(paneSize(attached.values()), { cols: 200, rows: 50 });
  });
});
