import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ServerMessage } from "../protocol.ts";
import { MAX_FRAME_BYTES, MAX_FRAMES_PER_WINDOW, PING_INTERVAL_MS } from "../ws.ts";
import type { TokenVerdict } from "./api.ts";
import {
  Connection,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_GRACE_INTERVALS,
  INPUT_WINDOW_MS,
  MAX_INPUT_FRAME_BYTES,
  MAX_INPUT_FRAMES_PER_WINDOW,
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
  /** Every timer the connection has outstanding: reconnects, input windows, silence watchdogs. */
  timers: { delayMs: number; run: () => void }[];
  fire: () => void;
  /**
   * Whether an INPUT WINDOW is still pending, which is what a drain loop is waiting on.
   *
   * Not "any timer": an open connection always has the heartbeat-silence watchdog outstanding, so
   * a loop that drained until the timer list emptied would go on to fire the watchdog, drop the
   * socket, and then read its assertions off a fresh socket that had sent nothing.
   */
  pendingWindow: () => boolean;
  statuses: ConnectionStatus[];
  rendered: { sessionId: string; data: string; cleared: boolean }[];
  errors: string[];
  unauthorized: number;
  /** What the HTTP probe says when a socket closes having carried nothing. */
  verdict: TokenVerdict;
  /** How many times the token has been re-presented to the server over HTTP. */
  probes: number;
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
    // The SOONEST timer, not the first one scheduled. Since the client watches for heartbeat
    // silence, an open connection always has a long timer outstanding, and popping the queue in
    // order fired that 30-second watchdog ahead of the 1-second input window sitting behind it -
    // which is not an ordering any clock produces.
    fire: () => {
      const soonest = Math.min(...state.timers.map((timer) => timer.delayMs));
      const [timer] = state.timers.splice(
        state.timers.findIndex((candidate) => candidate.delayMs === soonest),
        1,
      );
      assert.ok(timer, "expected a scheduled timer");
      timer.run();
    },
    pendingWindow: () => state.timers.some((timer) => timer.delayMs === INPUT_WINDOW_MS),
    statuses: [],
    rendered: [],
    errors: [],
    unauthorized: 0,
    verdict: "ok",
    probes: 0,
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
      verifyToken: () => {
        state.probes += 1;
        return Promise.resolve(state.verdict);
      },
      // The ladder's jitter pinned to its top, so these tests still assert the delays the ladder
      // is designed around rather than a draw. The spread itself is tested in backoff.test.ts.
      random: () => 1,
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

/** The bytes the pieces carry, rejoined - which is what the pty at the far end sees. */
const joined = (frames: Record<string, unknown>[]): string =>
  frames.map((frame) => frame["data"] as string).join("");

/** The size the server's receiver measures: the serialised frame, in bytes. */
const frameBytes = (frame: Record<string, unknown>): number =>
  new TextEncoder().encode(JSON.stringify(frame)).length;

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
    const pasted = "diff --git a/src/x.ts b/src/x.ts +one changed line here\n".repeat(6000);
    const frames = paste(h, pasted);
    assert.ok(frames.length > 1, "expected the paste to be split");
    for (const frame of frames) {
      assert.ok(
        frameBytes(frame) <= MAX_INPUT_FRAME_BYTES,
        "a frame was over the cap the receiver enforces before anything can answer it",
      );
    }
    assert.equal(joined(frames), pasted);
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
        frameBytes(frame) <= MAX_INPUT_FRAME_BYTES,
        "a frame of worst-case-escaping bytes was over the cap",
      );
    }
    assert.equal(joined(frames), "\u0001".repeat(200_000));
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
    assert.equal(joined(frames), "\u{1f600}".repeat(60_000));
  });

  void test("typing is still one frame per keystroke", () => {
    // The regression the chunker could quietly introduce at the other end of the range. A
    // keystroke that arrived as two frames would be two writes into the pty for one key, and the
    // per-socket frame budget is what a person typing fast would then be spending.
    const h = harness();
    const frames = paste(h, "l");
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], { t: "input", sessionId: "a", data: "l" });
  });

  void test("every piece is a whole input frame for the same session", () => {
    // A split that lost the envelope would be bytes with no destination. The server routes on
    // sessionId per frame, not on what the previous frame said.
    const h = harness();
    const frames = paste(h, "x".repeat(200_000));
    assert.ok(frames.length > 1);
    for (const frame of frames) {
      assert.equal(frame["t"], "input");
      assert.equal(frame["sessionId"], "a");
      assert.equal(typeof frame["data"], "string");
      assert.notEqual(frame["data"], "");
    }
  });

  void test("an ordinary paste stays well inside the server's per-window frame budget", () => {
    // The second way the same paste can vanish, and the quieter one. Frames past
    // MAX_FRAMES_PER_WINDOW are DROPPED by the receiver rather than closing the socket
    // (src/ws.ts withinRate), so a chunker that cut too finely would trade a 1009 close for a
    // silently truncated paste - the same lost bytes with less to go on. 500 KB is the top of
    // what a person pastes into a terminal by hand.
    const h = harness();
    const frames = paste(
      h,
      "a line of a pasted build log, about sixty bytes long\n".repeat(10_000),
    );
    assert.ok(
      frames.length < MAX_FRAMES_PER_WINDOW / 2,
      `a 500 KB paste became ${String(frames.length)} frames against a budget of ${String(MAX_FRAMES_PER_WINDOW)} per second`,
    );
  });

  void test("the release budget stays under what the server drops at", () => {
    // Our window and the server's start at different moments, so a burst that straddles the
    // boundary spends against two of ours and one of theirs. Half is the value that cannot.
    assert.ok(MAX_INPUT_FRAMES_PER_WINDOW <= MAX_FRAMES_PER_WINDOW / 2);
  });

  void test("a multi-megabyte paste is paced rather than spliced", () => {
    // The frames past MAX_FRAMES_PER_WINDOW are DROPPED by the receiver mid-stream, not refused,
    // so an unpaced 4 MiB paste reaches the pty with a hole in the middle of it and the shell
    // runs the concatenation of two fragments nobody typed.
    const h = harness();
    const pasted = "a line of a pasted build log, about sixty bytes long\n".repeat(80_000);
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.connection.input("a", pasted);

    const released = (): Record<string, unknown>[] =>
      sentMessages(h.last()).filter((message) => message["t"] === "input");
    assert.ok(
      released().length <= MAX_INPUT_FRAMES_PER_WINDOW,
      `${String(released().length)} frames went out in one window`,
    );

    let windows = 0;
    while (h.pendingWindow()) {
      const before = released().length;
      h.fire();
      windows += 1;
      assert.ok(
        released().length - before <= MAX_INPUT_FRAMES_PER_WINDOW,
        "a window released more than the budget",
      );
      assert.ok(windows < 100, "the queue never drained");
    }
    assert.equal(joined(released()), pasted, "the pty would have seen a hole");
  });

  void test("a megabyte of control bytes is paced too", () => {
    // Worst-case escaping: six bytes on the wire for one character, so the same megabyte costs
    // many more frames than its length suggests.
    const h = harness();
    const pasted = "\u0001".repeat(1_000_000);
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.connection.input("a", pasted);

    const released = (): Record<string, unknown>[] =>
      sentMessages(h.last()).filter((message) => message["t"] === "input");
    assert.ok(released().length <= MAX_INPUT_FRAMES_PER_WINDOW);
    let windows = 0;
    while (h.pendingWindow()) {
      const before = released().length;
      h.fire();
      windows += 1;
      assert.ok(released().length - before <= MAX_INPUT_FRAMES_PER_WINDOW);
      assert.ok(windows < 200, "the queue never drained");
    }
    for (const frame of released()) {
      assert.ok(frameBytes(frame) <= MAX_INPUT_FRAME_BYTES);
    }
    assert.equal(joined(released()), pasted);
  });

  void test("an agent's own terminal replies cannot starve a keystroke", () => {
    // `input()` is not only the keyboard. TerminalPane wires xterm's onData straight in, and xterm
    // fires onData for the replies it owes to escape sequences the AGENT wrote - one event per
    // `\e[6n`. Paced one frame per slot regardless of size, 200,000 eight-byte replies hold the
    // window for over an hour, and Ctrl-C is exactly what a person reaches for by then.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    for (let i = 0; i < 200_000; i += 1) h.connection.input("a", "\u001b[24;80R");
    h.connection.input("a", "\u0003");

    const released = (): Record<string, unknown>[] =>
      sentMessages(h.last()).filter((message) => message["t"] === "input");
    let windows = 0;
    while (h.pendingWindow() && !joined(released()).endsWith("\u0003")) {
      h.fire();
      windows += 1;
      assert.ok(windows < 40, "the interrupt was still queued a second later");
    }
    assert.ok(joined(released()).endsWith("\u0003"), "the interrupt never reached the pty");
    for (const frame of released()) {
      assert.ok(frameBytes(frame) <= MAX_INPUT_FRAME_BYTES, "coalescing exceeded the frame cap");
    }
  });

  void test("the queue is bounded, and what it drops it says out loud", () => {
    // The producer is an agent in a loop; the drain is fixed. Unbounded, the tab dies instead.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    const megabyte = "x".repeat(1024 * 1024);
    for (let i = 0; i < 64; i += 1) h.connection.input("a", megabyte);
    assert.equal(
      h.errors.length,
      1,
      "the dropped input was not reported, or was reported per piece",
    );
    assert.match(h.errors[0] as string, /dropped/);
  });

  void test("input typed before the socket opens is held, not destroyed", () => {
    // `#socket` is assigned before the socket is OPEN, and browserSocket.send silently discards
    // anything written while it is still CONNECTING. Draining into that window loses the head of a
    // paste and delivers the tail, so the pty runs the middle of what was pasted.
    const h = harness();
    h.connection.start();
    h.connection.attach("a", 80, 24);
    h.connection.input("a", "echo hello\r");
    assert.deepEqual(
      sentMessages(h.last()).filter((message) => message["t"] === "input"),
      [],
      "input went out while the socket was still connecting",
    );
    h.last().handlers.opened();
    assert.deepEqual(
      joined(sentMessages(h.last()).filter((message) => message["t"] === "input")),
      "echo hello\r",
    );
  });

  void test("a paste cut short by a disconnect is reported rather than silently truncated", () => {
    // Frames 1-40 have already been applied to the shell; the rest are discarded by the reset. A
    // silent discard is indistinguishable from a paste that never started, so the user pastes
    // again and the lines that already ran run twice.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.attach("a", 80, 24);
    h.connection.input(
      "a",
      "a line of a pasted build log, about sixty bytes long\n".repeat(80_000),
    );
    h.last().handlers.closed();
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0] as string, /only the beginning of it reached the terminal/);
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
    // The socket carried nothing, so the token is checked over HTTP before this counts as a
    // network failure at all - a handshake alone is not evidence the server is there.
    await settle();
    assert.deepEqual(h.statuses, ["connecting", "open"]);
    assert.equal(h.timers[0]?.delayMs, 250);

    h.fire();
    h.last().handlers.closed();
    await settle();
    assert.equal(h.statuses.at(-1), "reconnecting");
    assert.equal(h.timers[0]?.delayMs, 500);
  });

  void test("a socket that carried traffic and drops is never mistaken for a bad token", async () => {
    const h = harness();
    h.verdict = "rejected";
    h.connection.start();
    h.last().handlers.opened();
    // The server was talking to this client seconds ago, so the probe is not even consulted - and
    // the token is not re-presented over HTTP for an ordinary outage.
    h.last().deliver({ t: "ping", intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS });
    h.last().handlers.closed();
    await settle();
    assert.equal(h.probes, 0);
    assert.equal(h.unauthorized, 0);
    assert.equal(h.timers.length, 1);
  });
});

void describe("a token rejected mid-session, rather than at startup", () => {
  void test("the first reconnect after the rotation asks, and stops", async () => {
    // Rotating the token does not close the socket that is already open - it refuses the NEXT
    // handshake. So the discovery is one ladder step after the drop, and no sooner: the drop
    // itself arrives on a connection that was working, which is the ordinary outage. What must not
    // happen is the refused handshake being read as more of the same outage.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().deliver({ t: "ping", intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS });
    h.last().handlers.closed();
    await settle();
    assert.equal(h.probes, 0, "an ordinary mid-session drop re-presented the token over HTTP");

    h.verdict = "rejected";
    h.fire(); // the reconnect, whose handshake the rotated token is refused at
    h.last().handlers.closed();
    await settle();
    assert.equal(h.unauthorized, 1);
    assert.deepEqual(h.timers, [], "the ladder kept running against a rejected token");
    assert.equal(h.statuses.at(-1), "rejected");
  });

  void test("a handshake that succeeds and carries nothing is not evidence the token is good", async () => {
    // A `101` is answered by whatever sits in front of the server as readily as by the server, so
    // a socket that opened and then said nothing has proved nothing. Reading it as proof left this
    // case going round the ladder once more for no information.
    const h = harness();
    h.verdict = "rejected";
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.closed();
    await settle();
    assert.equal(h.unauthorized, 1);
    assert.deepEqual(h.timers, []);
  });

  void test("a 403 that arrives after a period of success stops it too, and keeps the token", async () => {
    // The server was restarted with a different AGENTDECK_ORIGIN under a client that had been
    // connected all along. Nothing about the token changed, so asking for a new one would send the
    // user after the wrong thing.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().deliver({ t: "ping", intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS });
    h.last().handlers.closed();
    await settle();

    h.verdict = "forbidden";
    h.fire();
    h.last().handlers.closed();
    await settle();
    assert.equal(h.unauthorized, 0, "a configuration mistake asked for a new token");
    assert.deepEqual(h.timers, []);
    assert.equal(h.statuses.at(-1), "forbidden");
    assert.ok(h.errors.some((message) => /AGENTDECK_ORIGIN/.test(message)));
  });
});

void describe("a socket that is stuck rather than absent", () => {
  void test("the ladder says what is wrong instead of re-presenting the token forever", async () => {
    // The audit's open finding: the watchdog drops a stuck-CONNECTING socket, `#onClosed` probes
    // the token, the probe says the server is fine, and the loop runs again - a bearer token
    // re-presented once a cycle, forever, with no diagnosis. The probe is what makes this case
    // diagnosable at all: HTTP works and the socket does not, which is neither the network nor the
    // token.
    const h = harness();
    h.connection.start();
    for (let cycle = 0; cycle < 6; cycle++) {
      h.fire(); // the silence bound gives up on a socket that never reached the 101
      await settle();
      h.fire(); // the reconnect
    }
    assert.ok(h.probes >= 6, "the stuck socket was never diagnosed against HTTP at all");
    const said = h.errors.filter((message) => /not the network and not the token/.test(message));
    assert.equal(said.length, 1, `expected exactly one diagnosis, got ${String(said.length)}`);
    // Still trying, because unlike a 401 or a 403 this is an inference rather than a verdict: a
    // proxy that starts passing upgrades makes it wrong.
    assert.ok(h.timers.length > 0, "an inference stopped the ladder as if it were a verdict");
  });

  void test("a socket that completes the handshake and then says nothing is diagnosed too", async () => {
    // The 101 is answered by whatever is in front of the server as readily as by the server, so
    // "it opened" is not evidence and this case would otherwise have nothing to diagnose it from.
    const h = harness();
    h.connection.start();
    for (let cycle = 0; cycle < 6; cycle++) {
      h.last().handlers.opened();
      h.fire();
      await settle();
      h.fire();
    }
    assert.equal(
      h.errors.filter((message) => /not the network and not the token/.test(message)).length,
      1,
    );
  });

  void test("one frame ends the silence, and a later one is diagnosed afresh", async () => {
    const h = harness();
    h.connection.start();
    for (let cycle = 0; cycle < 5; cycle++) {
      h.fire();
      await settle();
      h.fire();
    }
    const first = h.errors.length;
    h.last().handlers.opened();
    h.last().deliver({ t: "ping", intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS });
    h.last().handlers.closed();
    await settle();
    // That close carried traffic, so it scheduled a retry rather than probing. Consume it, which
    // puts the loop back on the same footing as the first one: a stuck socket being watched.
    h.fire();
    for (let cycle = 0; cycle < 5; cycle++) {
      h.fire();
      await settle();
      h.fire();
    }
    assert.equal(
      h.errors.filter((message) => /not the network and not the token/.test(message)).length,
      2,
      "a second outage repeated the first one's diagnosis, or never said it again",
    );
    assert.ok(first > 0);
  });

  void test("an unreachable server is never diagnosed as a broken socket", async () => {
    // A phone in a lift. The probe does not answer either, so the sentence above - which claims
    // the server IS answering - would be a guess presented to the user as a finding. This is why
    // "could not reach it" is a verdict of its own rather than folded into "ok": the two retry
    // identically, and they are opposite evidence about everything else.
    const h = harness();
    h.verdict = "unreachable";
    h.connection.start();
    for (let cycle = 0; cycle < 6; cycle++) {
      h.fire();
      await settle();
      h.fire();
    }
    assert.deepEqual(h.errors, [], "an outage was reported as a misconfigured proxy");
    assert.ok(h.statuses.includes("reconnecting"));
    assert.ok(h.timers.length > 0, "an outage stopped the ladder");
  });
});

void describe("a rejected token is not a network failure", () => {
  void test("it stops the ladder and asks for a new token", async () => {
    const h = harness();
    h.verdict = "rejected";
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
    h.verdict = "unreachable";
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

void describe("a refused origin is neither the network nor the token", () => {
  void test("it stops the ladder and says what has to change", async () => {
    // The audit's open half of the AGENTDECK_ORIGIN finding: a 403 used to read as "not a 401, so
    // the token is still good, so it must be the network", and the client reconnected forever
    // while the server answered every request correctly.
    const h = harness();
    h.verdict = "forbidden";
    h.connection.start();
    h.last().handlers.closed();
    await settle();
    assert.deepEqual(h.timers, [], "a configuration mistake was retried as a network failure");
    assert.equal(h.statuses.at(-1), "forbidden");
    // Not the token: the paste field would be the wrong thing to ask for.
    assert.equal(h.unauthorized, 0);
    assert.ok(
      h.errors.some((message) => /AGENTDECK_ORIGIN/.test(message)),
      `nothing named the cause: ${h.errors.join(" | ")}`,
    );
  });
});

void describe("what is typed while disconnected", () => {
  void test("is dropped and said so, not delivered into whatever comes next", async () => {
    // The rule this file has always stated: a keystroke held through an outage arrives seconds or
    // minutes later, into whatever the agent is showing by then. A "y" answers a question that is
    // no longer on screen; two halves of a command line concatenate into one nobody typed. Pacing
    // a paste means holding input across the CONNECTING window - `#socket` is assigned before the
    // socket opens - and that is all it means.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.closed();
    await settle();

    const before = h.last().sent.length;
    h.connection.input("s1", "y\r");
    h.connection.input("s1", "rm -rf something\r");

    h.fire();
    h.last().handlers.opened();
    await settle();

    const sentAfter = h.last().sent.filter((raw) => raw.includes('"input"'));
    assert.deepEqual(sentAfter, [], "input typed while disconnected was replayed into a live pty");
    assert.equal(h.last().sent.length >= before, true);
    assert.equal(
      h.errors.some((message) => /not connected/.test(message)),
      true,
      "the user was not told that what they typed went nowhere",
    );
  });

  void test("the overflow warning is once per overflow, not once per socket", () => {
    // `#overflowed` was cleared only on close, so a queue that overflowed, drained, and overflowed
    // again an hour later dropped input in silence. What is dropped is the tail of what is in
    // flight while everything queued after it is still sent, so the pty receives a hole and then
    // resumes - the concatenation of two fragments nobody typed, which this file names as worse
    // than dropping the lot.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();

    const flood = (): void => {
      // Well past MAX_PENDING_INPUT_BYTES, with the window budget spent so nothing drains.
      for (let i = 0; i < 400; i++) h.connection.input("s1", "x".repeat(64 * 1024));
    };
    flood();
    const first = h.errors.filter((m) => /dropped/.test(m)).length;
    assert.equal(first, 1, "the first overflow was not announced exactly once");

    // Drain the queue the way the window timer does, then overflow again. Each fired window
    // schedules the next while anything is still queued, so this runs until nothing is pending
    // rather than a fixed number of times.
    for (let i = 0; i < 2000 && h.pendingWindow(); i++) h.fire();
    flood();
    const second = h.errors.filter((m) => /dropped/.test(m)).length;
    assert.ok(second > first, "a later overflow dropped input silently");
  });
});

// THE CLIENT-VISIBLE HEARTBEAT, at the level where the clock is fake.
//
// src/half-open.test.ts proves the real thing end to end, over a genuinely half-open socket, and
// that is the acceptance test. It cannot reach these cases: a real run only ever fires the
// watchdog at the one deadline the server's interval sets, so nothing there distinguishes "the
// bound came from the frame" from "the bound was compiled in and happened to match", and nothing
// there can hold a socket at exactly the moment before the deadline to show it is the ping that
// pushed the deadline out. The failure this design refuses - a confidently wrong tab - lives in
// that distinction.

/** The pending silence watchdogs, told apart from the input window by their delay. */
const watchdogs = (h: Harness): { delayMs: number; run: () => void }[] =>
  h.timers.filter(
    (timer) => timer.delayMs === DEFAULT_HEARTBEAT_INTERVAL_MS * HEARTBEAT_GRACE_INTERVALS,
  );

const openHarness = (): Harness => {
  const h = harness();
  h.connection.start();
  h.last().handlers.opened();
  return h;
};

void describe("the client-visible heartbeat", () => {
  void test("the pre-first-frame default is the server's interval, not a second number", () => {
    // The window before the first heartbeat lands is timed against a constant on this side, and a
    // constant duplicated across the wire is a number free to drift. Plan 002 puts `intervalMs` on
    // the frame for everything after; this asserts the one value the frame cannot cover.
    assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, PING_INTERVAL_MS);
    assert.equal(HEARTBEAT_GRACE_INTERVALS, 2);
  });

  void test("an open socket is watched from the moment it opens", () => {
    // Not from the first heartbeat: a socket that opens and goes silent immediately - the proxy
    // froze during the handshake - would otherwise be watched by nothing at all.
    const h = openHarness();
    assert.equal(watchdogs(h).length, 1);
  });

  void test("two intervals of silence drop the socket and run the ladder", async () => {
    // The half-open case, in miniature. Nothing closes, nothing errors; this timer is the only
    // thing that can notice, and what it must produce is a reconnect rather than a status change.
    const h = openHarness();
    assert.equal(watchdogs(h).length, 1);
    h.fire();
    assert.equal(h.last().closed, true, "the dead socket was left open");
    await settle();
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [250],
      "the silence bound fired without starting the reconnection ladder",
    );
  });

  void test("the bound is the interval the server stated, not the one compiled in", () => {
    const h = openHarness();
    h.last().deliver({ t: "ping", intervalMs: 4000 });
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [8000],
      "the client kept timing against its own constant after the server named its interval",
    );

    // And it follows a server that changes its mind, rather than holding the first value it saw.
    h.last().deliver({ t: "ping", intervalMs: 1000 });
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [2000],
    );
  });

  void test("a tab whose agent says nothing for hours is never reported as dead", () => {
    // THE FAILURE MODE THIS DESIGN EXISTS TO PREVENT, and the one a blind silence timer causes.
    // This connection receives no snapshot, no chunk and no state for the whole test - the agent
    // is simply idle - and every heartbeat must retire the outstanding deadline rather than
    // letting it stand. One watchdog at a time, replaced each beat, never reached.
    const h = openHarness();
    let previous = watchdogs(h)[0];
    for (let beat = 0; beat < 200; beat++) {
      h.last().deliver({ t: "ping", intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS });
      const pending = watchdogs(h);
      assert.equal(pending.length, 1, `beat ${String(beat)} left ${String(pending.length)} bounds`);
      assert.notEqual(pending[0], previous, "the heartbeat did not push the deadline out");
      previous = pending[0];
    }
    assert.equal(h.sockets.length, 1, "an idle tab reconnected");
    assert.equal(h.last().closed, false);
    assert.deepEqual(
      h.statuses,
      ["connecting", "open"],
      "an idle tab was reported as anything else",
    );
    assert.deepEqual(h.rendered, [], "the tab was not idle, so this proves nothing");
  });

  void test("a nonsense stated interval falls back to the default rather than bricking the tab", () => {
    // `#receive` runs no parser over a server frame, so `intervalMs` is a wire value used as a
    // control parameter. Absent, zero, negative, NaN or overflowing, an unchecked value arms a
    // bound that expires on the next tick - and because the interval is Connection state rather
    // than socket state, the same instantly-expiring bound is re-armed on every replacement
    // socket, so one bad frame reconnects forever against a healthy server.
    const bad: unknown[] = [undefined, 0, -1, NaN, Infinity, 1e308, "15000", null, 1, 1e9];
    for (const intervalMs of bad) {
      const h = openHarness();
      h.last().deliver({ t: "ping", intervalMs } as unknown as ServerMessage);
      assert.deepEqual(
        h.timers.map((timer) => timer.delayMs),
        [DEFAULT_HEARTBEAT_INTERVAL_MS * HEARTBEAT_GRACE_INTERVALS],
        `intervalMs ${String(intervalMs)} armed a bound the default does not cover`,
      );

      // And the socket survives the next tick of the clock the ping was supposed to reset: the
      // pending bound is the default one, so firing it is the first thing that touches the socket.
      assert.equal(h.sockets.length, 1, `intervalMs ${String(intervalMs)} dropped a live socket`);
      assert.equal(h.last().closed, false);
      assert.deepEqual(h.statuses, ["connecting", "open"]);
    }
  });

  void test("a poisoned interval does not survive into the next socket", () => {
    // The permanent half of the failure: a replacement socket arms its bound from Connection
    // state, so a value that was never clamped would outlive the socket that carried it. Only a
    // page reload clears that, and the tab shows "Reconnecting..." the whole time.
    const h = openHarness();
    h.last().deliver({ t: "ping", intervalMs: 0 } as unknown as ServerMessage);
    h.last().handlers.closed();
    h.fire(); // the reconnection backoff
    h.last().handlers.opened();
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [DEFAULT_HEARTBEAT_INTERVAL_MS * HEARTBEAT_GRACE_INTERVALS],
      "the replacement socket inherited an instantly-expiring bound",
    );
  });

  void test("the heartbeat costs the tab nothing to answer", () => {
    // It is answered with nothing at all - the frame having arrived is the whole proof - so an
    // idle tab spends none of a user's typing allowance on staying alive.
    const h = openHarness();
    h.connection.attach("a", 80, 24);
    const before = h.last().sent.length;
    for (let i = 0; i < 100; i++) h.last().deliver({ t: "ping", intervalMs: 15_000 });
    assert.equal(h.last().sent.length, before, "the client replied to a heartbeat");
  });

  void test("heartbeats do not spend the per-window input allowance", () => {
    // The client's budget counts input frames only. Were the heartbeat inside it, an idle tab
    // would arrive at the keyboard with its allowance already gone - the starvation direction.
    const h = openHarness();
    for (let i = 0; i < 100; i++) h.last().deliver({ t: "ping", intervalMs: 15_000 });
    for (let i = 0; i < MAX_INPUT_FRAMES_PER_WINDOW; i++) h.connection.input("a", "x");
    const released = sentMessages(h.last()).filter((message) => message["t"] === "input");
    assert.equal(
      released.length,
      MAX_INPUT_FRAMES_PER_WINDOW,
      "heartbeats ate part of a window the user had not typed into",
    );
  });

  void test("a socket dropped by the bound and later closed for real reconnects once", async () => {
    // A half-open socket does eventually get an RST, minutes after the watchdog gave up on it.
    // Two runs of the ladder for one connection is two sockets racing, and the loser's frames
    // arrive on a connection nothing is reading.
    const h = openHarness();
    const first = h.last();
    h.fire();
    await settle();
    assert.equal(h.timers.length, 1);
    first.handlers.closed();
    await settle();
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [250],
      "the late close ran the ladder a second time",
    );
  });

  void test("stopping stops the watching, so a closed tab does not resurrect itself", () => {
    const h = openHarness();
    h.connection.stop();
    assert.deepEqual(h.timers, [], "a stopped connection was still being timed");
  });

  void test("a socket the bound gave up on can no longer speak for the connection", () => {
    // `close()` only STARTS the closing handshake, so the browser goes on dispatching frames it had
    // already buffered for the abandoned socket. Its handlers are wired to this same Connection, and
    // a snapshot repaints unconditionally by design - so a 30-second-old screen would land on top of
    // the live one and rewind the tracked position, costing a resync and a second cold snapshot.
    const h = openHarness();
    const dead = h.last();
    h.connection.attach("a", 80, 24);
    dead.deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 100, data: "OLD" });
    h.fire();
    h.fire();
    h.last().handlers.opened();
    h.last().deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 500, data: "CURRENT" });

    const watched = watchdogs(h)[0];
    dead.deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 120, data: "STALE" });
    assert.deepEqual(
      h.rendered.map((entry) => entry.data),
      ["OLD", "CURRENT"],
      "a socket the watchdog abandoned repainted the live pane",
    );
    assert.deepEqual(h.connection.positionOf("a"), { epoch: "e1", seq: 500 });
    assert.equal(
      watchdogs(h)[0],
      watched,
      "the abandoned socket re-armed the deadline belonging to the live one",
    );

    // And its late `opened` is inert too, rather than reporting the connection open.
    dead.handlers.opened();
    assert.deepEqual(h.statuses, ["connecting", "open", "connecting", "open"]);
  });

  void test("a socket that never opens is watched too", async () => {
    // The network freezing between the TCP connect and the 101: no close, no error the client sees,
    // no open. Armed only on open, nothing times this at all, and `poke()` returns while a socket
    // exists - so the tab sits at "connecting" until the browser's own handshake timeout, which
    // Chrome and Safari leave to the TCP stack.
    const h = harness();
    h.connection.start();
    assert.equal(watchdogs(h).length, 1, "an un-opened socket was watched by nothing");
    h.fire();
    assert.equal(h.last().closed, true, "the stuck socket was left open");
    // The token probe runs first, because a socket that never opened may be a rejected token.
    await settle();
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [250],
      "the stuck socket was dropped without running the ladder",
    );
  });

  void test("sockets that open and then say nothing back off and become visible", async () => {
    // A path that completes the handshake and then forwards nothing server->client. Resetting the
    // ladder on the handshake alone makes this a permanent 250 ms loop - re-attaching every tab,
    // a cold capture-pane each - that the user is never shown, because the reconnecting banner
    // waits for a second failed attempt.
    const h = harness();
    h.connection.start();
    const delays: number[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      h.last().handlers.opened();
      h.fire(); // the silence bound
      await settle();
      const [retry] = h.timers;
      assert.ok(retry, "the ladder stopped");
      delays.push(retry.delayMs);
      h.fire(); // the reconnect
    }
    assert.deepEqual(
      delays,
      [250, 500, 1000, 2000, 4000],
      "an opened-but-silent socket never backed off",
    );
    assert.ok(h.statuses.includes("reconnecting"), "the loop was invisible to the user");
  });

  void test("a socket that carries a frame resets the ladder", async () => {
    // The other half of the rule: evidence of traffic, not merely a handshake, starts the ladder
    // from the bottom again - so an ordinary outage still reconnects fast.
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.fire();
    await settle();
    h.fire();
    h.last().handlers.opened();
    h.last().deliver({ t: "ping", intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS });
    h.last().handlers.closed();
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [250],
    );
  });

  void test("a reconnected socket is watched again", async () => {
    // The bound is per socket. Re-arming it on open is what keeps the second outage noticeable.
    const h = openHarness();
    h.fire();
    await settle();
    h.fire();
    h.last().handlers.opened();
    assert.equal(watchdogs(h).length, 1);
  });
});

// A backgrounded tab is not a special case in this file's model - it is the ordinary one, slowed
// down. A hidden tab's timers are throttled to roughly one a minute, so every delay here becomes a
// floor rather than a duration: the silence bound notices later, the ladder's step is longer than
// the ladder chose, and the cap being 4 s buys nothing while nobody is looking at the screen. What
// makes that acceptable is that the delays are only ever exceeded, never undercut - a throttled
// clock cannot make this connection reconnect sooner than it decided to - and that the moment the
// tab comes back, the wait is abandoned rather than served out. App.vue calls `poke()` on
// `visibilitychange` and on `online` for exactly that.
void describe("a tab that was in the background", () => {
  void test("does not serve out a delay that was scheduled while nobody was looking", async () => {
    const h = harness();
    h.connection.start();
    // Far enough up the ladder to be at the cap, which is what a tab that failed while hidden
    // comes back holding.
    for (let cycle = 0; cycle < 5; cycle++) {
      h.last().handlers.closed();
      await settle();
      h.fire();
    }
    h.last().handlers.closed();
    await settle();
    assert.equal(h.timers[0]?.delayMs, 4000, "the ladder was not at its cap");

    const before = h.sockets.length;
    h.connection.poke();
    assert.equal(h.sockets.length, before + 1, "the wake waited out the backoff instead");
    assert.deepEqual(
      h.timers.map((timer) => timer.delayMs),
      [DEFAULT_HEARTBEAT_INTERVAL_MS * HEARTBEAT_GRACE_INTERVALS],
    );
  });

  void test("keeps its place in the stream, so the wake repaints rather than starts over", async () => {
    const h = harness();
    h.connection.start();
    h.connection.attach("a", 80, 24);
    h.last().handlers.opened();
    h.last().deliver({ t: "snapshot", sessionId: "a", epoch: "e1", seq: 7, data: "hello" });
    h.last().handlers.closed();
    await settle();

    h.connection.poke();
    h.last().handlers.opened();
    const attach = sentMessages(h.last()).find((frame) => frame["t"] === "attach");
    assert.deepEqual(attach, {
      t: "attach",
      sessionId: "a",
      cols: 80,
      rows: 24,
      haveEpoch: "e1",
      haveSeq: 7,
    });
  });

  void test("a wake while a socket already exists does not open a second one", () => {
    // `visibilitychange` and `online` both fire on a phone coming out of a pocket, and a stuck
    // socket is still a socket. Two sockets for one connection is two ladders racing, and the
    // loser's frames arrive on a connection nothing is reading.
    const h = harness();
    h.connection.start();
    h.connection.poke();
    h.connection.poke();
    assert.equal(h.sockets.length, 1);
  });

  void test("a wake after the tab was closed does not resurrect it", () => {
    const h = harness();
    h.connection.start();
    h.connection.stop();
    h.connection.poke();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.statuses.at(-1), "closed");
  });

  void test("a wake after a rejected token does not re-present it", async () => {
    // The ladder is stopped, and `poke()` is called by an event the user cannot avoid firing -
    // switching back to the tab. Re-opening there would put the paste field behind a socket that
    // is being refused over and over.
    const h = harness();
    h.verdict = "rejected";
    h.connection.start();
    h.last().handlers.closed();
    await settle();
    assert.equal(h.unauthorized, 1);
    h.connection.poke();
    assert.equal(h.sockets.length, 1, "a rejected token was re-presented on the next wake");
  });
});
