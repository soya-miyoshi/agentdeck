import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ServerMessage } from "../protocol.ts";
import { MAX_FRAME_BYTES, MAX_FRAMES_PER_WINDOW } from "../ws.ts";
import type { TokenVerdict } from "./api.ts";
import {
  Connection,
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
  /** Pending reconnects, newest last. Each is [delayMs, run]. */
  timers: { delayMs: number; run: () => void }[];
  fire: () => void;
  statuses: ConnectionStatus[];
  rendered: { sessionId: string; data: string; cleared: boolean }[];
  errors: string[];
  unauthorized: number;
  /** What the HTTP probe says when a socket closes before it opened. */
  verdict: TokenVerdict;
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
    verdict: "ok",
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
      verifyToken: () => Promise.resolve(state.verdict),
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
    while (h.timers.length > 0) {
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
    while (h.timers.length > 0) {
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
    while (h.timers.length > 0 && !joined(released()).endsWith("\u0003")) {
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
    h.verdict = "rejected";
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
    for (let i = 0; i < 2000 && h.timers.length > 0; i++) h.fire();
    flood();
    const second = h.errors.filter((m) => /dropped/.test(m)).length;
    assert.ok(second > first, "a later overflow dropped input silently");
  });
});
