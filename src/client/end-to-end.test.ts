// m2/client-minimal's done-when, executed rather than asserted about: an agent driven from the
// browser end to end.
//
// Nothing serves the built SPA yet - that is m2/serve-client, a separate open item - so the page
// is not what is driven here. What is driven is every client module BELOW the page, unmodified and
// in the same wiring App.vue gives them: `browserSocket` opening a real WebSocket against a real
// server process, `Connection` multiplexing over it, `stream-position` deciding what each frame
// means, and the render callback App.vue passes in. The only pieces left out are the two that need
// a DOM - the Vue components and xterm's renderer - and the seam they sit behind, TerminalHandle,
// is five verbs wide, so a stand-in for it here writes what xterm would have painted.
//
// The server end is real all the way down: a spawned `src/server.ts`, the real tmux binary, a real
// pty, a real `/bin/sh` reading from it. Keystrokes go in as `input` frames and the shell's output
// comes back as `snapshot` and `chunk` frames. A test that stubbed either end would prove the two
// halves agree with the stub.
//
// The manual recipe for a human with a browser is in README.md, under "Driving it from a browser".

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { AgentSummary } from "../agent-profiles.ts";
import { hookCommand } from "../claude-hooks.ts";
import type { Session } from "../registry.ts";
import type { SessionState } from "../tmux.ts";
import { browserSocket } from "./browser-socket.ts";
import { Connection, type SocketLike } from "./connection.ts";
import { type KeyName, keyBytes, withCtrl } from "./key-row.ts";
import type { TerminalHandle } from "./terminal-handle.ts";
import { type Tab, toTabs } from "./tabs.ts";

const run = promisify(execFile);
const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const socket = `agentdeck-e2e-${String(process.pid)}`;

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-e2e-home-");
// One working tree per test rather than one for the file. A session id is a pure function of
// (absolute path, agent id) - plan 002 - so two tests naming the same directory and the same agent
// would be handed the SAME tmux session by `new-session -A`, and the second would inherit whatever
// the first left in the pane. That is a shared-state flake waiting for a slow machine, and it
// would fail as "the shell did not answer" rather than as what it is.
const work = temp("agentdeck-e2e-work-");
const pasteWork = temp("agentdeck-e2e-paste-");
const dropWork = temp("agentdeck-e2e-drop-");
const restartWork = temp("agentdeck-e2e-restart-");
// One working tree per key-row test, for the reason above: same path and same agent is the same
// tmux session, and a pane left mid-`cat` by one test is not a starting state for the next.
const keyWork = temp("agentdeck-e2e-keys-");
const ctrlWork = temp("agentdeck-e2e-ctrl-");
const tabWork = temp("agentdeck-e2e-tab-");
const arrowWork = temp("agentdeck-e2e-arrow-");
// Three, because the done-when for the strip is three sessions running at once: a status that is
// right for one tab and wrong for the other two is the failure it is written against.
const stripWork = [
  temp("agentdeck-e2e-strip-a-"),
  temp("agentdeck-e2e-strip-b-"),
  temp("agentdeck-e2e-strip-c-"),
];
const conf = temp("agentdeck-e2e-conf-");

const profiles = join(conf, "agents.json");
// A plain shell, which is the profile-less agent the status work is proven against too. The point
// of this test is the transport and the client, and a shell is the agent whose replies a test can
// state exactly.
// `hooked` is the same shell with a hook waiting mechanism declared, which is what makes
// `detectsWaiting` true for it and `waiting` a state the strip is allowed to show. The agent
// binary is deliberately still /bin/sh: what is being driven is the hook path - a POST to
// /api/hooks/:id carrying the session's own secret - and claude is not needed to send one. The
// POST itself is sent by the REAL hook command from src/claude-hooks.ts, run inside the session,
// the way claude runs it.
writeFileSync(
  profiles,
  JSON.stringify({
    sh: { command: "/bin/sh", args: [], name: "Shell" },
    hooked: {
      command: "/bin/sh",
      args: [],
      name: "Hooked shell",
      waiting: { via: "hook", settings: "hooked/settings.json" },
    },
  }),
);

let port = 0;
let token = "";
let child: ChildProcess | undefined;

const freePort = async (): Promise<number> =>
  await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(found);
      });
    });
  });

/** Start the server the way a person does, and resolve once it is listening. */
const startServer = async (): Promise<ChildProcess> => {
  const started = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      TERM: "xterm-256color",
      LC_ALL: "en_US.UTF-8",
      TMUX_SOCKET: socket,
      AGENTDECK_PORT: String(port),
      AGENTDECK_MOUNTS: [
        work,
        pasteWork,
        dropWork,
        restartWork,
        keyWork,
        ctrlWork,
        tabWork,
        arrowWork,
        ...stripWork,
      ].join(":"),
      AGENTDECK_PROFILES: profiles,
      AGENTDECK_AGENT_STATE_DIR: join(conf, "agent-state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = started;
  let stdout = "";
  let stderr = "";
  started.stdout.setEncoding("utf8");
  started.stderr.setEncoding("utf8");
  started.stderr.on("data", (chunk: string) => (stderr += chunk));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the server did not listen within 20s\n${stdout}\n${stderr}`));
    }, 20_000);
    timer.unref();
    started.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    started.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited ${String(code)} instead of listening\n${stderr}`));
    });
  });
  return started;
};

before(async () => {
  port = await freePort();
  await startServer();
  // The token is generated on first run and kept, so a restart below is the same token.
  token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();

  // `browserSocket` names two browser globals and nothing else: `WebSocket`, which node has, and
  // `window.location.href`, which is how it learns where to connect. Supplying the second is what
  // lets the real module be the one under test rather than a copy of it written for node.
  Reflect.set(globalThis, "window", { location: { href: `http://127.0.0.1:${String(port)}/` } });
});

after(async () => {
  if (child !== undefined) child.kill("SIGKILL");
  try {
    await run("tmux", ["-L", socket, "kill-server"]);
  } catch {
    // Already gone: the desired end state.
  }
  for (const dir of [
    home,
    work,
    pasteWork,
    dropWork,
    restartWork,
    keyWork,
    ctrlWork,
    tabWork,
    arrowWork,
    ...stripWork,
    conf,
  ]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** What xterm would have painted, in the order it would have painted it. */
const paintedTerminal = (): TerminalHandle & { text: () => string; clears: () => number } => {
  let painted = "";
  let clears = 0;
  return {
    write: (data) => (painted += data),
    clear: () => {
      clears += 1;
      painted = "";
    },
    clears: () => clears,
    size: () => ({ cols: 80, rows: 24 }),
    focus: () => undefined,
    // The real one reads xterm's DECCKM. Nothing here paints, so it is stated: the key row's
    // arrows are tested against both answers below rather than against whichever one is baked in.
    applicationCursorKeys: () => false,
    text: () => painted,
  };
};

const waitFor = async (
  what: string,
  predicate: () => boolean,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

interface Driven {
  connection: Connection;
  session: Session;
  screen: () => string;
  /** How many sockets have been opened. More than one means the transport dropped. */
  opens: () => number;
  /** How many times the tab was cleared and repainted from a snapshot. */
  repaints: () => number;
  /** Kill the transport under the client, the way a phone losing signal does. */
  drop: () => void;
  errors: string[];
}

/**
 * A session created over the real HTTP API, and a client attached to it over the real socket.
 *
 * The render callback is App.vue's, restated: a repaint clears and writes history first, because a
 * snapshot supersedes everything before it.
 */
const drive = async (cwd: string): Promise<Driven> => {
  const created = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd, agent: "sh" }),
  });
  const body = (await created.json()) as { session?: Session; error?: string };
  assert.equal(created.status, 201, body.error ?? "");
  const session = body.session;
  assert.ok(session, "the server created no session");

  const terminal = paintedTerminal();
  const errors: string[] = [];
  let opens = 0;
  let live: SocketLike | undefined;

  const connection = new Connection(
    {
      token,
      connect: (value, handlers) => {
        opens += 1;
        live = browserSocket(value, handlers);
        return live;
      },
      // api.ts's `verifyToken` restated against an absolute URL: node's fetch has no page to take
      // a base from. The four verdicts are the ones that module produces, including the 403 that
      // used to read as "not a 401, so the token is good, so it must be the network". The catch
      // matters as much as the statuses: the restart test below probes while the server is down,
      // and a probe that REJECTS rather than answering would abandon `#onClosed` half-way and
      // leave the ladder with no retry scheduled at all - a permanently blank tab, which is the
      // thing that test exists to catch.
      verifyToken: async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${String(port)}/api/probe`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
          if (response.status === 401) return "rejected";
          if (response.status === 403) return "forbidden";
          return response.ok ? "ok" : "unreachable";
        } catch {
          return "unreachable";
        }
      },
    },
    {
      render: (_sessionId, action) => {
        if (action.kind === "repaint") {
          terminal.clear();
          if (action.history !== undefined) terminal.write(action.history);
        }
        terminal.write(action.data);
      },
      state: () => undefined,
      sessions: () => undefined,
      error: (_sessionId, message) => errors.push(message),
      status: () => undefined,
      unauthorized: () => errors.push("the token was rejected"),
    },
  );
  connection.start();
  await waitFor("the socket to open", () => connection.status === "open");
  connection.attach(session.id, 80, 24);
  await waitFor("the first paint", () => terminal.text() !== "");
  return {
    connection,
    session,
    screen: () => terminal.text(),
    opens: () => opens,
    repaints: () => terminal.clears(),
    drop: () => live?.close(),
    errors,
  };
};

void describe("an agent driven from the browser, end to end", () => {
  void test("a keystroke reaches the agent and its output paints back", async () => {
    const driven = await drive(work);
    try {
      // Typed the way xterm delivers it: a carriage return, not a newline, because that is what
      // the Enter key produces and what the pty's line discipline turns into one.
      driven.connection.input(driven.session.id, "echo hello-from-the-browser\r");
      await waitFor(
        "the shell's output to paint",
        // Twice: once echoed by the tty as it is typed, once printed by `echo`. The second is the
        // one that proves the bytes reached a process rather than only a terminal.
        () => (driven.screen().match(/hello-from-the-browser/g) ?? []).length >= 2,
      );
      assert.deepEqual(driven.errors, []);
      assert.equal(driven.opens(), 1, "the transport dropped during an ordinary session");
    } finally {
      driven.connection.stop();
    }
  });

  void test("an ordinary large paste arrives whole and does not close the socket", async () => {
    // The defect this closes: `ws` enforces its 64 KiB maxPayload BEFORE the message event, so an
    // over-size `input` frame cannot be answered with an error frame - the socket closes with
    // 1009, the client cannot tell that from a phone in a lift, and it runs the ladder and
    // re-attaches every tab with a cold capture-pane each. The paste is gone with no explanation,
    // so the user pastes it again and it repeats.
    const driven = await drive(pasteWork);
    try {
      const out = join(pasteWork, "pasted.txt");
      // 300 KB of pasted log: five times the frame the receiver will accept, and lines short
      // enough that the tty's canonical-mode line buffer is never the thing being tested.
      const pasted = `${"2026-08-08T09:15:04Z resolved dependency graph".padEnd(59, " ")}\n`.repeat(
        5000,
      );
      // `stty -echo` so the pane is not asked to render 300 KB back at us: what is being measured
      // is what reached the process, and the file is where that is readable exactly.
      driven.connection.input(driven.session.id, `stty -echo; cat > ${out}\r`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      driven.connection.input(driven.session.id, pasted);
      // End of input for `cat`. Sent separately, as a keystroke is.
      driven.connection.input(driven.session.id, "\u0004");

      const read = (): string => {
        try {
          return readFileSync(out, "utf8");
        } catch {
          return "";
        }
      };
      await waitFor("the pasted bytes to reach the agent", () => read().length >= pasted.length);
      assert.equal(read(), pasted, "the paste arrived, but not intact");
      assert.equal(driven.opens(), 1, "the paste closed the transport and it reconnected");
      assert.equal(driven.connection.status, "open");
      assert.deepEqual(driven.errors, []);
    } finally {
      driven.connection.stop();
    }
  });
});

// ------------------------------------------------------------------------------------------
// m3/tab-strip: three sessions, a status per tab, and the status arriving as a PUSHED frame.
//
// The strip is the one part of this product whose whole argument is a timing claim, so it is
// driven rather than asserted about: three real tmux sessions, a real socket, the real `toTabs`
// the page renders from, and a real hook POST sent by the real command in src/claude-hooks.ts,
// running inside the session with the session's own secret - which is the only way a `waiting`
// exists at all (src/http.ts authenticates that route with the secret, never the user's token).
//
// The client below never attaches to any of the three. That is deliberate: plan 002 says the
// strip must be able to say "this one needs you" without attaching to every session at once, so
// a state frame that only reached attached clients would be a strip that is right only about the
// tab already being looked at.

interface Strip {
  connection: Connection;
  sessions: Session[];
  tabs: () => Tab[];
  /** State frames that arrived on the socket. Zero means nothing was pushed. */
  pushed: () => number;
  /** Every HTTP request this process made, so a poll cannot hide. */
  http: string[];
  /** Run the real hook command inside a session, the way the agent's own hook runs it. */
  hook: (session: Session, event: string) => void;
  stop: () => void;
}

let strip: Strip | undefined;

const buildStrip = async (): Promise<Strip> => {
  // Every fetch this process makes, recorded. This is what makes "nothing polls" checkable rather
  // than claimed: a strip that re-fetched GET /api/sessions on a timer would show up here as
  // requests nobody in the test asked for.
  const http: string[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    http.push(`${init?.method ?? "GET"} ${target}`);
    return await realFetch(input, init);
  };

  const base = `http://127.0.0.1:${String(port)}`;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const created: Session[] = [];
  for (const cwd of stripWork) {
    const response = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ cwd, agent: "hooked" }),
    });
    const body = (await response.json()) as { session?: Session; error?: string };
    assert.equal(response.status, 201, body.error ?? "");
    assert.ok(body.session, "the server created no session");
    created.push(body.session);
  }

  // The hook command as the agent gets it: the same string src/claude-hooks.ts writes into the
  // agent's settings file, run by a shell with the session's AGENTDECK_SESSION_ID and
  // AGENTDECK_SECRET in its environment, with the payload on stdin. Nothing about the transport
  // is simulated - if this file's node -e form stopped working, this test would stop passing.
  const hookScript = join(conf, "hook.sh");
  writeFileSync(hookScript, `${hookCommand(port)}\n`);

  const state = {
    sessions: [] as Session[],
    pushed: 0,
  };
  const errors: string[] = [];
  const connection = new Connection(
    // The token is known good here - it was read off disk - and every request this test makes is
    // absolute, so the ladder never needs a verdict it would have to fetch for.
    { token, connect: browserSocket, verifyToken: () => Promise.resolve("ok") },
    {
      render: () => undefined,
      // App.vue's, restated: a pushed state patches the session it names and nothing else. No
      // refetch, which is the point of the whole item.
      state: (sessionId, next, exitCode) => {
        state.pushed += 1;
        state.sessions = state.sessions.map((session) =>
          session.id === sessionId
            ? { ...session, state: next, ...(exitCode === undefined ? {} : { exitCode }) }
            : session,
        );
      },
      sessions: (list) => (state.sessions = list),
      error: (_sessionId, message) => errors.push(message),
      status: () => undefined,
      unauthorized: () => errors.push("the token was rejected"),
    },
  );
  connection.start();
  await waitFor("the strip's socket to open", () => connection.status === "open");

  // The one and only load. Everything after this arrives on the socket.
  const listed = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: Session[];
  };
  const agents = (await (await fetch(`${base}/api/agents`, { headers: auth })).json()) as {
    agents: AgentSummary[];
  };
  state.sessions = listed.sessions.filter((session) =>
    created.some((made) => made.id === session.id),
  );
  assert.equal(state.sessions.length, 3, "the three sessions are not all listed");

  return {
    connection,
    sessions: created,
    tabs: () => toTabs(state.sessions, agents.agents),
    pushed: () => state.pushed,
    http,
    hook: (session, event) => {
      connection.input(
        session.id,
        `printf '%s' '{"hook_event_name":"${event}"}' | sh ${hookScript}\r`,
      );
    },
    stop: () => {
      connection.stop();
      globalThis.fetch = realFetch;
    },
  };
};

const stateOf = (tabs: readonly Tab[], id: string): SessionState | undefined =>
  tabs.find((tab) => tab.id === id)?.state;

void describe("the tab strip, against three real sessions", () => {
  before(async () => {
    strip = await buildStrip();
    const live = strip;
    // Quiet panes for the rest of this: no echo of what is typed, and an empty prompt. Output is
    // what a declared `waiting` is cleared by (src/stream.ts) - the agent writing means the agent
    // is doing something - so a shell that printed `$ ` after every command would be contradicting
    // the hook a millisecond after it landed, for reasons that have nothing to do with an agent.
    for (const session of live.sessions) live.connection.input(session.id, "stty -echo; PS1=''\r");
    await new Promise((resolve) => setTimeout(resolve, 750));
    // All three working, each said by its own hook POST. The transition measured below is out of
    // this state, not out of a blank one.
    for (const session of live.sessions) live.hook(session, "UserPromptSubmit");
    await waitFor("all three tabs to report working", () =>
      live.tabs().every((tab) => tab.state === "working"),
    );
  });

  after(() => strip?.stop());

  void test("distinguishes working from waiting within a second or two of the transition", async () => {
    const live = strip;
    assert.ok(live, "the strip was not built");
    const [first, second, third] = live.sessions;
    assert.ok(first && second && third);

    // `Stop` is what claude sends when a turn ends, and src/claude-hooks.ts maps it to `waiting`.
    const at = Date.now();
    live.hook(second, "Stop");
    // Nothing else is holding this session's pane quiet, so the state has to survive on its own.
    live.connection.input(second.id, "sleep 20\r");
    await waitFor(
      "the middle tab to report waiting",
      () => stateOf(live.tabs(), second.id) === "waiting",
      10_000,
    );
    const took = Date.now() - at;
    assert.ok(took < 2500, `the transition took ${String(took)}ms to reach the strip`);

    const tabs = live.tabs();
    // The needs-you indicator, and only on the tab that needs you. A strip that lit all three
    // would pass a test that only looked at one.
    assert.deepEqual(
      tabs.filter((tab) => tab.needsYou).map((tab) => tab.id),
      [second.id],
    );
    assert.equal(stateOf(tabs, first.id), "working");
    assert.equal(stateOf(tabs, third.id), "working");
    assert.ok(live.pushed() > 0, "no state frame arrived at all");
  });

  void test("the status is pushed: nothing in the strip asks over HTTP", async () => {
    const live = strip;
    assert.ok(live, "the strip was not built");
    const third = live.sessions[2];
    assert.ok(third);

    // The whole HTTP conversation so far, frozen. Everything after this line is the socket's.
    const before = live.http.length;
    const pushedBefore = live.pushed();

    live.hook(third, "Stop");
    live.connection.input(third.id, "sleep 20\r");
    await waitFor(
      "the third tab to report waiting",
      () => stateOf(live.tabs(), third.id) === "waiting",
      10_000,
    );
    // Three seconds of a client that has a live socket and a status that just changed. A poll on
    // any interval a person would tolerate - the 2s Firestore poll this project exists not to be,
    // or anything under it - lands inside this window and fails here.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    assert.ok(live.pushed() > pushedBefore, "the status changed without a frame arriving");
    assert.deepEqual(
      live.http.slice(before),
      [],
      "the strip made an HTTP request while the socket was open: it is polling",
    );
  });
});

void describe("the reconnection ladder, against the real transport", () => {
  void test("the socket is killed mid-output and the reconnect repaints instead of leaving a hole", async () => {
    const driven = await drive(dropWork);
    try {
      // Forty markers over about four seconds, so the socket can be killed while the agent is
      // still writing and the bytes it produces while there is no client are real ones.
      driven.connection.input(
        driven.session.id,
        "i=0; while [ $i -lt 40 ]; do i=$((i+1)); echo mid-output-$i; sleep 0.1; done\r",
      );
      // The pty ends its lines with CR LF, and `mid-output-4` is a prefix of `mid-output-40`, so
      // the boundary is part of the match rather than assumed.
      const at = (n: number): number =>
        driven.screen().search(new RegExp(`mid-output-${String(n)}\\D`));
      const marker = (n: number): boolean => at(n) >= 0;
      await waitFor("the agent to start writing", () => marker(3));

      // Not `connection.stop()`, which would be the user leaving: this is the transport dying
      // under a client that still wants it, which is what a phone losing signal does.
      driven.drop();
      await waitFor("the ladder to open a second socket", () => driven.opens() >= 2);
      await waitFor("the socket to come back", () => driven.connection.status === "open");
      await waitFor("the rest of the output to arrive", () => marker(40), 30_000);

      // The whole run is on screen, in order, with nothing missing across the gap. A hole is the
      // failure this is written for: the bytes written while the socket was gone are exactly the
      // ones a client that resumed from the wrong place would skip.
      let previous = -1;
      for (let n = 1; n <= 40; n++) {
        const found = at(n);
        assert.ok(
          found > previous,
          `mid-output-${String(n)} is missing or out of order after the drop`,
        );
        previous = found;
      }
      assert.deepEqual(driven.errors, []);
    } finally {
      driven.connection.stop();
    }
  });

  void test("the server process is restarted under an open client", async () => {
    // THE EPOCH CASE, and the one this item exists for: not a dropped socket but a server that
    // went away and came back. The tmux session survives with the same id, the client still holds
    // a (epoch, seq) from a counter that no longer exists, and every signal except the pane looks
    // correct.
    //
    // This used to measure a gap rather than a behaviour: `#meta` was memory only and
    // `Registry.list()` was gated on it, so after a restart the surviving session was not listed at
    // all, the re-attach was answered "no session", and nothing the client could do repainted the
    // tab. `m2/session-metadata-survives-restart` closed that by adopting survivors from what tmux
    // reports, so the assertion is now the done-when itself: the tab repaints by itself.
    const driven = await drive(restartWork);
    try {
      driven.connection.input(driven.session.id, "echo before-the-restart\r");
      await waitFor(
        "the agent's output before the restart",
        () => (driven.screen().match(/before-the-restart/g) ?? []).length >= 2,
      );
      const opensBefore = driven.opens();
      const repaintsBefore = driven.repaints();

      const old = child;
      assert.ok(old, "no server process to restart");
      const exited = new Promise<void>((resolve) => {
        old.on("exit", () => {
          resolve();
        });
      });
      old.kill("SIGKILL");
      await exited;
      child = undefined;
      await startServer();

      // The ladder brings the socket back by itself and re-attaches every tab with the epoch and
      // seq it got to. That much works.
      await waitFor("the ladder to reconnect", () => driven.opens() > opensBefore, 30_000);
      await waitFor("the socket to come back", () => driven.connection.status === "open", 30_000);

      // The done-when: the tab repaints by itself. The client's stored seq is in the millions and
      // in a counter that no longer exists, so the server cannot answer it with chunks - it sends
      // an unconditional snapshot in a new epoch, and the pane comes back.
      await waitFor(
        "the tab to repaint by itself after the restart",
        () => driven.repaints() > repaintsBefore,
        30_000,
      );
      assert.equal(
        driven.errors.filter((message) => /no session/.test(message)).length,
        0,
        "the re-attach was refused: the survivor was not adopted",
      );
      // And the pane holds what it held before the server died - the agent never stopped.
      assert.match(driven.screen(), /before-the-restart/);

      // Recreating the session is what a person has to do today, and it is `new-session -A`, so it
      // reattaches to the SAME live process and hands the registry back its metadata. Once it has,
      // the epoch half of the protocol does its job: the client's stored seq is in the millions
      // and in a space that no longer exists, and the server answers with an unconditional
      // snapshot in a new epoch rather than chunks the client would discard as already seen.
      const recreated = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ cwd: restartWork, agent: "sh" }),
      });
      const body = (await recreated.json()) as { session?: Session };
      assert.equal(body.session?.id, driven.session.id, "the id is not stable across a restart");

      // Re-attached until it takes: the create returns as soon as tmux has the session, and the
      // hub picks the pane up on its next sync, so the first attach after a recreate can still be
      // answered "no session". A tab does this by itself - the ladder re-attaches on every open.
      const deadline = Date.now() + 30_000;
      while (driven.repaints() === repaintsBefore) {
        assert.ok(Date.now() < deadline, `the tab never repainted: ${driven.errors.join(" | ")}`);
        driven.connection.attach(driven.session.id, 80, 24);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const position = driven.connection.positionOf(driven.session.id);
      assert.ok(position, "the tab has no position after the repaint");
      assert.ok(
        driven.screen().includes("before-the-restart"),
        `the repaint painted nothing from the surviving pane: ${JSON.stringify(driven.screen().slice(-200))}`,
      );

      // Still the same agent: the shell that was running before the restart answers now.
      driven.connection.input(driven.session.id, "echo after-the-restart\r");
      await waitFor(
        "the surviving agent to answer",
        () => (driven.screen().match(/after-the-restart/g) ?? []).length >= 2,
        30_000,
      );
    } finally {
      driven.connection.stop();
    }
  });
});

void describe("a session whose waiting detection died, for real", () => {
  void test("is marked in the strip instead of rendering as a healthy tab", async () => {
    // Not a fixture and not a flag set by hand: the three sessions above outlived the SIGKILL in
    // the restart test, and the server that came back adopted them from tmux without the hook
    // secret they were started with. Their hook POSTs are unsigned from here on, so they will
    // never report `waiting` again until their agent is restarted (plan 002) - and that is
    // precisely the tab that would otherwise look healthy and quietly never ask for anybody.
    const base = `http://127.0.0.1:${String(port)}`;
    const headers = { authorization: `Bearer ${token}` };
    // A session of the SAME agent started by the server that is running now, so the comparison is
    // between two tabs that differ in one thing: whether the hook secret still exists.
    const fresh = (await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ cwd: work, agent: "hooked" }),
      })
    ).json()) as { session?: Session };
    assert.ok(fresh.session, "no fresh session to compare against");
    const listed = (await (await fetch(`${base}/api/sessions`, { headers })).json()) as {
      sessions: Session[];
    };
    const agents = (await (await fetch(`${base}/api/agents`, { headers })).json()) as {
      agents: AgentSummary[];
    };
    const tabs = toTabs(listed.sessions, agents.agents);
    const stripIds = new Set((strip?.sessions ?? []).map((session) => session.id));
    const survivors = tabs.filter((tab) => stripIds.has(tab.id));
    assert.equal(survivors.length, 3, "the three sessions did not survive the restart");
    for (const tab of survivors) {
      assert.equal(
        tab.waitingDetectionLost,
        true,
        `${tab.name} survived the restart and its tab still claims a working waiting mechanism`,
      );
    }
    // The same agent, started fresh, does NOT carry it. Without this the assertion above would
    // pass just as well if every tab were marked, which says nothing to a person at all.
    const healthy = tabs.find((tab) => tab.id === fresh.session?.id);
    assert.ok(healthy, "the fresh session is not listed");
    assert.equal(healthy.waitingDetectionLost, false);
  });
});

/** Every session name tmux holds on our socket, read outside the code under test. */
const sessionNames = (): string[] => {
  try {
    return execFileSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "en_US.UTF-8" },
    })
      .trim()
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return [];
  }
};

void describe("the sessions this test started", () => {
  void test("were really tmux sessions, not a fixture", () => {
    // Guards the whole file against the failure mode that would make it pass while proving
    // nothing: a server that answered without tmux ever being involved.
    assert.ok(sessionNames().length >= 1, "no tmux session was created");
  });
});

// ------------------------------------------------------------------------------------------
// m4/key-row: the keys a soft keyboard does not have, answering a prompt that BLOCKS on them.
//
// The bytes below come from src/client/key-row.ts - the module the caps call - and go out through
// the same `Connection.input` xterm's keystrokes use, so nothing here is a second path to the pty.
// What App.vue adds on top is the latch, and it is restated in `keyboard` rather than imitated:
// press Ctrl, and the next thing sent is transformed and the latch spent.
//
// NOT DEMONSTRATED HERE, and not claimed: a thumb on a phone. The only other tailnet device has
// been offline for days, so "answered from the phone" is unproven; the steps for a person holding
// one are in README.md under "Answering a prompt from the phone". What IS proven is everything
// between the cap and the process: a real server, real tmux, a real pty, a real shell, and a
// prompt that cannot proceed until the right byte arrives.

interface Keyboard {
  press: (key: KeyName) => void;
  /** What the soft keyboard types, through App.vue's latch. */
  type: (text: string) => void;
  latched: () => boolean;
}

/** App.vue's key handling, restated over a driven session. */
const keyboard = (driven: Driven, applicationCursorKeys = false): Keyboard => {
  let latch = false;
  const send = (data: string): void => {
    if (data === "") return;
    driven.connection.input(driven.session.id, latch ? withCtrl(data) : data);
    latch = false;
  };
  return {
    press: (key) => {
      if (key === "ctrl") {
        latch = !latch;
        return;
      }
      send(keyBytes(key, applicationCursorKeys));
    },
    type: (text) => send(text),
    latched: () => latch,
  };
};

void describe("the key row, against a real shell that is blocked on a keypress", () => {
  void test("a permission prompt is ANSWERED: Enter is what unblocks a waiting `read`", async () => {
    const driven = await drive(keyWork);
    const keys = keyboard(driven);
    try {
      const marker = join(keyWork, "answered.txt");
      // A prompt that BLOCKS. `read` does not return until a line arrives, and a line arrives only
      // when the pty's line discipline sees CR - which is the byte Enter sends and the byte an iOS
      // soft keyboard's own return key would send too. The point is the rest of the row: the answer
      // is typed, then committed by a key the phone does not have to produce.
      driven.connection.input(
        driven.session.id,
        `printf 'Allow edit to src/tmux.ts? [y/n] '; read reply; printf '%s' "$reply" > ${marker}\r`,
      );
      await waitFor("the prompt to paint", () => driven.screen().includes("Allow edit to"));

      keys.type("y");
      // Blocked: nothing has committed the line yet, so the redirection has not run and the marker
      // does not exist. This is what makes the prompt a real one rather than a printed string.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(
        existsSync(marker),
        false,
        "the prompt answered itself before Enter was pressed",
      );

      keys.press("enter");
      await waitFor(
        "the prompt to be answered",
        () => existsSync(marker) && readFileSync(marker, "utf8") === "y",
      );
      assert.deepEqual(driven.errors, []);
    } finally {
      driven.connection.stop();
    }
  });

  void test("Ctrl latches, and Ctrl then c interrupts a running process", async () => {
    const driven = await drive(ctrlWork);
    const keys = keyboard(driven);
    try {
      // `&&`, not `;`: an interrupted `sleep` exits non-zero, so the second half is the thing that
      // does NOT happen. With `;` the shell would run it anyway and the check below would be a
      // check on nothing.
      const finished = join(ctrlWork, "the-sleep-finished");
      driven.connection.input(driven.session.id, `sleep 300 && touch ${finished}\r`);
      await new Promise((resolve) => setTimeout(resolve, 750));

      keys.press("ctrl");
      assert.equal(keys.latched(), true, "Ctrl did not latch");
      keys.type("c");
      assert.equal(keys.latched(), false, "the latch outlived the key it modified");

      // The shell got its prompt back, which only happens if SIGINT reached the foreground group.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      driven.connection.input(driven.session.id, "echo still-here\r");
      await waitFor(
        "the interrupted shell to answer again",
        () => (driven.screen().match(/still-here/g) ?? []).length >= 2,
      );
      // And `sleep 300` did not finish: it was killed, so its `&&` never ran. On disk rather than
      // on the pane, because the pane also holds the echo of the command that names it.
      assert.equal(existsSync(finished), false, "the sleep ran to completion instead of dying");
    } finally {
      driven.connection.stop();
    }
  });

  void test("Tab completes a filename the caller only half typed", async () => {
    const driven = await drive(tabWork);
    const keys = keyboard(driven);
    try {
      writeFileSync(join(tabWork, "completion-target-file.txt"), "");
      keys.type("ls completion-tar");
      await waitFor("the half-typed line to echo", () =>
        driven.screen().includes("completion-tar"),
      );
      keys.press("tab");
      await waitFor("the shell to complete the name", () =>
        driven.screen().includes("completion-target-file.txt"),
      );
      keys.press("enter");
    } finally {
      driven.connection.stop();
    }
  });

  void test("Esc and the arrows arrive as the bytes they claim to be", async () => {
    // `cat -v` prints control bytes rather than acting on them, so what the pty received is
    // readable on the pane. This is the assertion that the row is sending sequences and not key
    // names: an arrow that arrived as anything else shows up here as anything else.
    const driven = await drive(arrowWork);
    const normal = keyboard(driven, false);
    const application = keyboard(driven, true);
    try {
      // `stty -echo` so the only thing on the pane is what `cat` received, not the tty's echo
      // of it as well.
      driven.connection.input(driven.session.id, "stty -echo; cat -v\r");
      await new Promise((resolve) => setTimeout(resolve, 750));

      normal.press("esc");
      normal.press("up");
      normal.press("down");
      normal.press("right");
      normal.press("left");
      normal.press("enter");
      await waitFor("the normal-mode sequences to come back", () =>
        /\^\[\^\[\[A\^\[\[B\^\[\[C\^\[\[D/.test(driven.screen()),
      );

      // The same four caps with DECCKM set, which is what a full-screen TUI leaves the terminal in.
      // The form is the terminal's answer rather than the row's opinion: in the browser it comes
      // from xterm's `modes.applicationCursorKeysMode`, and here it is the flag passed to
      // `keyboard`.
      //
      // MEASURED, and worth writing down because it decides how much this test can claim: tmux
      // PARSES its client's input as keys and re-encodes them for the pane, so `ESC O A` arrives at
      // a pane that has not set DECCKM as `ESC [ A`. Both forms are therefore recognised as Up here
      // and neither reaches `cat` verbatim - so what this proves is that the row sends a real arrow
      // key in either mode, not that the byte on the wire is the byte in the pane. The mode still
      // has to be read rather than assumed: an application form invented for a terminal that never
      // set DECCKM is a guess that happens to survive tmux, and the client also talks to xterm's
      // own parser, which does not normalise anything.
      // A different ORDER from the batch above, so the pattern below cannot be matched by a repaint
      // of the first line - which a reconnect or a tmux redraw will happily put on the pane twice.
      application.press("down");
      application.press("up");
      application.press("left");
      application.press("right");
      application.press("enter");
      await waitFor("the application-mode presses to arrive as arrow keys", () =>
        /\^\[\[B\^\[\[A\^\[\[D\^\[\[C/.test(driven.screen()),
      );

      // Out of `cat`, with the latch: Ctrl then d is EOF, and 0x04 is what ends it.
      normal.press("ctrl");
      normal.type("d");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      driven.connection.input(driven.session.id, "echo cat-is-done\r");
      await waitFor(
        "the shell to come back after Ctrl-D",
        () => (driven.screen().match(/cat-is-done/g) ?? []).length >= 2,
      );
      assert.deepEqual(driven.errors, []);
    } finally {
      driven.connection.stop();
    }
  });
});
