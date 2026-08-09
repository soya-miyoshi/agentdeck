import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { paneRows } from "./protocol.ts";
import { SessionStream, WORKING_LINGER_MS } from "./stream.ts";

/** A clock the test drives, so cadence is exercised without waiting for wall-clock time. */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const build = () => {
  const c = clock();
  return { clock: c, stream: new SessionStream({ sessionId: "s1", now: c.now }) };
};

const bytes = (n: number): Buffer => Buffer.alloc(n, 0x61);

void describe("status from output cadence", () => {
  void test("a fresh session is idle, not working", () => {
    const { stream } = build();
    assert.equal(stream.state(), "idle");
  });

  void test("sustained output is working", () => {
    const { stream } = build();
    stream.write(bytes(200));
    assert.equal(stream.state(), "working");
  });

  void test("it falls back to idle once output stops", () => {
    const { stream, clock: c } = build();
    stream.write(bytes(200));
    c.advance(WORKING_LINGER_MS + 1);
    assert.equal(stream.state(), "idle");
  });

  void test("a single keystroke echoing back is not an agent thinking", () => {
    // The threshold exists so typing does not light the strip as `working`.
    const { stream } = build();
    stream.write(Buffer.from("a"));
    assert.equal(stream.state(), "idle");
  });

  void test("bytes accumulate within a window but not across a quiet gap", () => {
    const { stream } = build();
    stream.write(bytes(8));
    stream.write(bytes(8));
    assert.equal(stream.state(), "working", "16 bytes inside one window");

    const fresh = build();
    fresh.stream.write(bytes(8));
    fresh.clock.advance(WORKING_LINGER_MS + 1);
    fresh.stream.write(bytes(8));
    assert.equal(fresh.stream.state(), "idle", "a gap resets the count rather than summing");
  });
});

void describe("declared states outrank inference", () => {
  void test("exit is definitive and sticky, even with bytes still arriving", () => {
    // A dead pane can still have bytes read out of it; that must not resurrect it as `working`.
    const { stream } = build();
    stream.declare("exited", 137);
    stream.write(bytes(200));
    assert.equal(stream.state(), "exited");
    assert.equal(stream.exitCode, 137);
  });

  void test("a declared waiting survives quiet, where cadence alone would say idle", () => {
    // This is the whole value of the agent's own hook: quiet and blocked-on-a-person look
    // identical from the byte stream.
    const { stream, clock: c } = build();
    stream.declare("waiting");
    c.advance(WORKING_LINGER_MS * 10);
    assert.equal(stream.state(), "waiting");
  });

  void test("output contradicts waiting, because the agent is evidently doing something", () => {
    const { stream } = build();
    stream.declare("waiting");
    stream.write(bytes(200));
    assert.equal(stream.state(), "working");
  });

  void test("an agent with no mechanism never claims waiting", () => {
    // Fewer states, never a wrong one. Nothing in the cadence path can produce `waiting`.
    const { stream, clock: c } = build();
    for (const step of [0, 500, 5000, 60_000]) {
      c.advance(step);
      stream.write(bytes(100));
      assert.notEqual(stream.state(), "waiting");
      c.advance(step);
      assert.notEqual(stream.state(), "waiting");
    }
  });
});

void describe("chunks and the buffer", () => {
  void test("every write reaches listeners with the epoch and the new seq", () => {
    const { stream } = build();
    const seen: { epoch: string; seq: number; data: string }[] = [];
    stream.onChunk((c) => seen.push({ epoch: c.epoch, seq: c.seq, data: c.data.toString() }));

    stream.write(Buffer.from("abc"));
    stream.write(Buffer.from("de"));

    assert.deepEqual(
      seen.map((c) => [c.data, c.seq]),
      [
        ["abc", 3],
        ["de", 5],
      ],
    );
    assert.equal(new Set(seen.map((c) => c.epoch)).size, 1, "epoch is per session, not per chunk");
  });

  void test("unsubscribing stops delivery", () => {
    const { stream } = build();
    let count = 0;
    const off = stream.onChunk(() => count++);
    stream.write(Buffer.from("a"));
    off();
    stream.write(Buffer.from("b"));
    assert.equal(count, 1);
  });

  void test("an empty write changes nothing", () => {
    const { stream } = build();
    let count = 0;
    stream.onChunk(() => count++);
    stream.write(Buffer.alloc(0));
    assert.equal(count, 0);
    assert.equal(stream.buffer.headSeq, 0);
  });

  void test("two streams get different epochs, so a restart cannot be mistaken for continuity", () => {
    assert.notEqual(
      new SessionStream({ sessionId: "s" }).epoch,
      new SessionStream({ sessionId: "s" }).epoch,
    );
  });
});

void describe("attached clients drive the pane height", () => {
  void test("the pane is the minimum over attached clients", () => {
    const { stream } = build();
    stream.attach("phone", 60, 40);
    stream.attach("laptop", 200, 50);
    assert.equal(paneRows(stream.clients.values()), 40);
  });

  void test("detaching releases the constraint and the pane grows back", () => {
    const { stream } = build();
    stream.attach("phone", 60, 40);
    stream.attach("laptop", 200, 50);
    stream.detach("phone");
    assert.equal(paneRows(stream.clients.values()), 50);
  });

  void test("with nobody attached the pane keeps whatever it had", () => {
    const { stream } = build();
    stream.attach("phone", 60, 40);
    stream.detach("phone");
    assert.equal(paneRows(stream.clients.values()), undefined);
  });

  void test("a resize from a detached client constrains nothing", () => {
    // Otherwise a client that went away could hold a pane short for everyone still looking.
    const { stream } = build();
    stream.attach("laptop", 200, 50);
    stream.resize("ghost", 20, 5);
    assert.equal(paneRows(stream.clients.values()), 50);
  });

  void test("the stream reads output whether or not anyone is attached", () => {
    // The unwatched session is the one most likely to be the one that needs you, so its status
    // has to keep working with zero clients.
    const { stream } = build();
    assert.equal(stream.attachedCount, 0);
    stream.write(bytes(200));
    assert.equal(stream.state(), "working");
    assert.equal(stream.buffer.headSeq, 200);
  });
});
