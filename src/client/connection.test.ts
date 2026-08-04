import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ServerMessage } from "../protocol.ts";
import {
  Connection,
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
