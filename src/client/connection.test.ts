import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ServerMessage } from "../protocol.ts";
import { MAX_FRAME_BYTES } from "../ws.ts";
import {
  Connection,
  MAX_INPUT_FRAME_BYTES,
  type ConnectionEvents,
  type ConnectionStatus,
  type SocketHandlers,
} from "./connection.ts";

// A fake socket and a fake clock, so the reconnection ladder - the part of the client most likely
// to be wrong and least likely to be noticed - is testable without a browser.

interface Harness {
  connection: Connection;
  sockets: FakeSocket[];
  last: () => FakeSocket;
  /** Pending reconnects, newest last. Each is [delayMs, run]. */
  timers: { delayMs: number; run: () => void }[];
  fire: () => void;
  statuses: ConnectionStatus[];
  rendered: { sessionId: string; data: string; cleared: boolean }[];
  errors: string[];
  unauthorized: number;
  tokenAccepted: boolean;
}

interface FakeSocket {
  handlers: SocketHandlers;
  sent: string[];
  closed: boolean;
  deliver: (message: ServerMessage) => void;
}

const harness = (): Harness => {
  const sockets: FakeSocket[] = [];
  const state: Harness = {
    connection: undefined as unknown as Connection,
    sockets,
    last: () => {
      const socket = sockets.at(-1);
      assert.ok(socket, "expected a socket");
      return socket;
    },
    timers: [],
    fire: () => {
      const timer = state.timers.shift();
      assert.ok(timer, "expected a scheduled reconnect");
      timer.run();
    },
    statuses: [],
    rendered: [],
    errors: [],
    unauthorized: 0,
    tokenAccepted: true,
  };

  const events: ConnectionEvents = {
    render: (sessionId, action) => {
      state.rendered.push({ sessionId, data: action.data, cleared: action.kind === "repaint" });
    },
    state: () => undefined,
    sessions: () => undefined,
    error: (_sessionId, message) => state.errors.push(message),
    status: (status) => state.statuses.push(status),
    unauthorized: () => {
      state.unauthorized += 1;
    },
  };

  state.connection = new Connection(
    {
      token: "t0k3n",
      connect: (_token, handlers) => {
        const socket: FakeSocket = {
          handlers,
          sent: [],
          closed: false,
          deliver: (message) => handlers.message(JSON.stringify(message)),
        };
        sockets.push(socket);
        return {
          send: (raw) => socket.sent.push(raw),
          close: () => {
            socket.closed = true;
          },
        };
      },
      verifyToken: () => Promise.resolve(state.tokenAccepted),
      schedule: (run, delayMs) => {
        const timer = { delayMs, run };
        state.timers.push(timer);
        return () => {
          state.timers = state.timers.filter((entry) => entry !== timer);
        };
      },
    },
    events,
  );
  return state;
};

const sentMessages = (socket: FakeSocket): Record<string, unknown>[] =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

/** Let the token probe's promise settle. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

void describe("one socket, multiplexed", () => {
  void test("every attached session shares a single socket", () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.connection.attach("b", 80, 24);
    assert.equal(h.sockets.length, 1);
    assert.deepEqual(
      sentMessages(h.last()).map((message) => [message["t"], message["sessionId"]]),
      [
        ["attach", "a"],
        ["attach", "b"],
      ],
    );
  });

  void test("typing sends input and renders nothing locally", () => {
    // Input returns as ordinary output because that is what a PTY does, and the agent may be in a
    // mode that transforms or refuses it.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.connection.input("a", "ls\r");
    assert.deepEqual(sentMessages(h.last()).at(-1), { t: "input", sessionId: "a", data: "ls\r" });
    assert.deepEqual(h.rendered, []);
  });
});

void describe("a paste is one onData event and may be larger than a frame", () => {
  const paste = (h: Harness, data: string): Record<string, unknown>[] => {
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.connection.input("a", data);
    return sentMessages(h.last()).filter((message) => message["t"] === "input");
  };

  void test("the client never sends a frame the server's receiver would refuse", () => {
    // `ws` enforces maxPayload BEFORE the message event, so an over-size frame is not answerable
    // with an error frame - the socket closes with 1009, which from the client looks exactly like
    // a phone in a lift. It runs the ladder, re-attaches every tab with a real capture-pane each,
    // and the paste is gone with no explanation, so the user pastes again and it repeats.
    const h = harness();
    // 400 KB of a pasted diff, which is a large paste but an ordinary one.
    const pasted =
      `${"diff --git a/src/x.ts b/src/x.ts +one changed line here".repeat(1)}\n`.repeat(6000);
    const frames = paste(h, pasted);
    assert.ok(frames.length > 1, "expected the paste to be split");
    for (const frame of frames) {
      assert.ok(
        new TextEncoder().encode(JSON.stringify(frame)).length <= MAX_INPUT_FRAME_BYTES,
        "a frame was over the cap the receiver enforces before anything can answer it",
      );
    }
    assert.equal(frames.map((frame) => frame["data"] as string).join(""), pasted);
    assert.equal(h.last().closed, false, "the transport must survive an ordinary paste");
  });

  void test("the budget stays under what the server will accept", () => {
    // Two files, one number. The client cannot import the server's module - it pulls `ws` into the
    // browser bundle - so the agreement is asserted here instead of assumed.
    assert.ok(MAX_INPUT_FRAME_BYTES < MAX_FRAME_BYTES);
  });

  void test("escaping is measured, not assumed, so a frame of control bytes still fits", () => {
    // Every character here serialises as \u00XX: six bytes for one, the worst case JSON has. A
    // chunker that counted characters and hoped would send a frame six times its own budget.
    const h = harness();
    const frames = paste(h, "\u0001".repeat(200_000));
    for (const frame of frames) {
      assert.ok(
        new TextEncoder().encode(JSON.stringify(frame)).length <= MAX_INPUT_FRAME_BYTES,
        "a frame of worst-case-escaping bytes was over the cap",
      );
    }
    assert.equal(frames.map((frame) => frame["data"] as string).join(""), "\u0001".repeat(200_000));
  });

  void test("a code point is never split across two frames", () => {
    // Half a surrogate pair is not the same bytes at the other end; it is U+FFFD, twice.
    const h = harness();
    const frames = paste(h, "\u{1f600}".repeat(60_000));
    for (const frame of frames) {
      const data = frame["data"] as string;
      assert.doesNotMatch(data, /^[\udc00-\udfff]/, "a frame began with a lone low surrogate");
      assert.doesNotMatch(data, /[\ud800-\udbff]$/, "a frame ended with a lone high surrogate");
    }
    assert.equal(
      frames.map((frame) => frame["data"] as string).join(""),
      "\u{1f600}".repeat(60_000),
    );
  });
});

void describe("position tracking across a reconnect", () => {
  void test("a snapshot clears and repaints, and a following chunk appends", () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.last().deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 5, data: "hello" });
    h.last().deliver({ t: "chunk", sessionId: "a", epoch: "e1", seq: 8, data: "!!!" });
    assert.deepEqual(h.rendered, [
      { sessionId: "a", data: "hello", cleared: true },
      { sessionId: "a", data: "!!!", cleared: false },
    ]);
    assert.deepEqual(h.connection.positionOf("a"), { epoch: "e1", seq: 8 });
  });

  void test("a gap sends resync rather than rendering a hole", () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.last().deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 5, data: "hello" });
    h.last().deliver({ t: "chunk", sessionId: "a", epoch: "e1", seq: 40, data: "abc" });
    assert.deepEqual(sentMessages(h.last()).at(-1), {
      t: "resync",
      sessionId: "a",
      haveEpoch: "e1",
      haveSeq: 5,
    });
    assert.equal(h.rendered.length, 1);
  });

  void test("re-attach carries the epoch and seq the tab got to", () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.last().deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 5, data: "hello" });

    h.last().handlers.closed();
    h.fire();
    h.last().handlers.opened();
    assert.deepEqual(sentMessages(h.last()), [
      { t: "attach", sessionId: "a", cols: 80, rows: 24, haveEpoch: "e1", haveSeq: 5 },
    ]);
  });

  void test("a server restart repaints the tab rather than leaving it blank forever", () => {
    // The epoch case: the session is alive with the same id, the client holds a seq in a counter
    // that no longer exists, and every signal except the pane looks correct.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.last().deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 4_000_000, data: "old" });

    h.last().handlers.closed();
    h.fire();
    h.last().handlers.opened();
    h.last().deliver({ t: "snapshot", sessionId: "a", epoch: "e2", seq: 3, data: "new" });
    assert.deepEqual(h.rendered.at(-1), { sessionId: "a", data: "new", cleared: true });
    assert.deepEqual(h.connection.positionOf("a"), { epoch: "e2", seq: 3 });
  });
});

void describe("reconnection", () => {
  void test("the first retry is silent and the second announces itself", async () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();

    h.last().handlers.closed();
    assert.deepEqual(h.statuses, ["connecting", "open"]);
    assert.equal(h.timers[0]?.delayMs, 250);

    h.fire();
    h.last().handlers.closed();
    // The retry never opened, so the token is checked over HTTP before this counts as a network
    // failure at all.
    await settle();
    assert.equal(h.statuses.at(-1), "reconnecting");
    assert.equal(h.timers[0]?.delayMs, 500);
  });

  void test("an open socket that drops is never mistaken for a bad token", async () => {
    const h = harness();
    h.tokenAccepted = false;
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.closed();
    await settle();
    // The server accepted this token seconds ago, so the probe is not even consulted.
    assert.equal(h.unauthorized, 0);
    assert.equal(h.timers.length, 1);
  });
});

void describe("a rejected token is not a network failure", () => {
  void test("it stops the ladder and asks for a new token", async () => {
    const h = harness();
    h.tokenAccepted = false;
    h.connection.start();
    // A browser reports a refused handshake as a close before open, exactly like a phone in a
    // lift. The two are told apart over HTTP, where the 401 survives.
    h.last().handlers.closed();
    await settle();
    assert.equal(h.unauthorized, 1);
    assert.deepEqual(h.timers, []);
    assert.equal(h.statuses.at(-1), "rejected");
  });

  void test("an unreachable server keeps the token and keeps retrying", async () => {
    // Treating "no network" as "bad token" would throw away a working token every time the phone
    // went through a tunnel.
    const h = harness();
    h.connection.start();
    h.last().handlers.closed();
    await settle();
    assert.equal(h.unauthorized, 0);
    assert.equal(h.timers.length, 1);
  });

  void test("stopping cancels the pending retry", () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.closed();
    h.connection.stop();
    assert.deepEqual(h.timers, []);
    assert.equal(h.statuses.at(-1), "closed");
  });
});
