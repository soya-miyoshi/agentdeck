// An agent driven end to end: every client module below the page, in App.vue's own wiring, against
// a spawned server, the real tmux, a real pty and a real shell. Only the two DOM pieces are left out.

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
import { PANE_COLS } from "../protocol.ts";
import type { Session } from "../registry.ts";
import type { SessionState } from "../tmux.ts";
import { browserSocket } from "./browser-socket.ts";
import { submitBytes } from "./composer.ts";
import { Connection, type SocketLike } from "./connection.ts";
import { type KeyName, keyBytes, withCtrl } from "./key-row.ts";
import type { TerminalHandle } from "./terminal-handle.ts";
import { type Tab, toTabs } from "./tabs.ts";

const run = promisify(execFile);
const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const socket = `agentdeck-e2e-${String(process.pid)}`;

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-e2e-home-");
// One working tree per test: a session id is a pure function of (path, agent), so two tests naming
// the same pair share a tmux session and the second inherits the first's pane.
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
// The input box's own trees. Same rule: one per test, or the second inherits the first's pane.
const composerWork = temp("agentdeck-e2e-composer-");
const composerCtrlWork = temp("agentdeck-e2e-composer-ctrl-");
// Three, because the done-when for the strip is three sessions running at once: a status that is
// right for one tab and wrong for the other two is the failure it is written against.
const stripWork = [
  temp("agentdeck-e2e-strip-a-"),
  temp("agentdeck-e2e-strip-b-"),
  temp("agentdeck-e2e-strip-c-"),
];
const conf = temp("agentdeck-e2e-conf-");

const profiles = join(conf, "agents.json");
// A plain shell, whose replies a test can state exactly. `hooked` is the same shell with a waiting
// mechanism declared: what is driven is the hook path, and claude is not needed to send a POST.
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
        composerWork,
        composerCtrlWork,
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

  // `browserSocket` names two browser globals: `WebSocket`, which node has, and `location.href`.
  // Supplying the second is what makes the real module the one under test.
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
    composerWork,
    composerCtrlWork,
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
    copyText: () => painted,
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
  /** Every pane width the server has stated, in order: one per socket that opened. */
  statedCols: number[];
  errors: string[];
}

/**
 * A session created over the real HTTP API, and a client attached over the real socket. The render
 * callback is App.vue's, restated: a repaint clears and writes history first.
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
  /** Every width this connection has been told, in order: one per socket that opened. */
  const statedCols: number[] = [];
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
      // `verifyToken` restated against an absolute URL, since node's fetch has no page for a base.
      // The catch matters as much as the statuses: a probe that REJECTS strands `#onClosed`.
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
      paneCols: (cols) => statedCols.push(cols),
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
    statedCols,
    errors,
  };
};

void describe("an agent driven from the browser, end to end", () => {
  void test("the real server states the width its pty holds the pane at", async () => {
    // The client may not render at its own compiled constant: that belongs to a bundle built
    // separately from the process owning the pty, and the skew reads as a CSS padding bug.
    const driven = await drive(work);
    try {
      assert.deepEqual(driven.statedCols, [PANE_COLS]);
    } finally {
      driven.connection.stop();
    }
  });

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
    // `ws` enforces maxPayload BEFORE the message event, so an over-size frame closes the socket
    // with 1009 - indistinguishable from a phone in a lift, and the paste is gone unexplained.
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

// Three sessions, a status per tab, and the status arriving as a PUSHED frame. The client below
// never attaches to any of them: the strip must say "this one needs you" without attaching.

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
  // Every fetch this process makes, recorded: what makes "nothing polls" checkable rather than
  // claimed, since a timer would show up here as requests nobody asked for.
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

  // The hook command as the agent gets it - the same string written into the settings file, run
  // with the session's own environment. Nothing about the transport is simulated.
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
      paneCols: () => undefined,
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
    // Quiet panes: output is what clears a declared `waiting`, so a shell echoing a prompt would
    // contradict the hook a millisecond after it landed.
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
    // Three seconds of a live socket and a status that just changed: a poll on any interval a
    // person would tolerate lands inside this window and fails here.
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

      // The whole run on screen, in order, with nothing missing across the gap: the bytes written
      // while the socket was gone are exactly the ones a wrong resume would skip.
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
    // THE EPOCH CASE: a server that went away and came back. The session survives with the same id
    // while the client holds a seq from a counter that no longer exists, and every signal looks fine.
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

      // The done-when: the tab repaints by itself. The stored seq is in a counter that no longer
      // exists, so the server answers with an unconditional snapshot in a new epoch.
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

      // Recreating is `new-session -A`, so it reattaches to the SAME live process and hands the
      // registry its metadata back. The epoch half then does its job.
      const recreated = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ cwd: restartWork, agent: "sh" }),
      });
      const body = (await recreated.json()) as { session?: Session };
      assert.equal(body.session?.id, driven.session.id, "the id is not stable across a restart");

      // Re-attached until it takes: the create returns as soon as tmux has the session, so the
      // first attach after a recreate can still be answered "no session".
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
  void test("survives a restart unmarked, and is marked only once its hooks are actually refused", async () => {
    // The three sessions above outlived the SIGKILL and used to come back MUTED. The secret is
    // derived now, so adoption recomputes it - and a genuinely deaf one is produced below, not assumed.
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
        false,
        `${tab.name} survived the restart and its tab is still marked as having lost waiting`,
      );
    }
    const healthy = tabs.find((tab) => tab.id === fresh.session?.id);
    assert.ok(healthy, "the fresh session is not listed");
    assert.equal(healthy.waitingDetectionLost, false);

    // One genuinely deaf, the only way derivation cannot help: a hook with a secret that does not
    // match. Without this the loop above passes with the mark deleted entirely.
    const victim = survivors[0];
    assert.ok(victim, "no survivor to refuse a hook for");
    const refused = await fetch(`${base}/api/hooks/${encodeURIComponent(victim.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentdeck-secret": "not-the-secret" },
      body: JSON.stringify({ hook_event_name: "Notification" }),
    });
    assert.equal(refused.status, 401, "a wrong secret was accepted");

    const after = (await (await fetch(`${base}/api/sessions`, { headers })).json()) as {
      sessions: Session[];
    };
    const marked = toTabs(after.sessions, agents.agents);
    assert.equal(
      marked.find((tab) => tab.id === victim.id)?.waitingDetectionLost,
      true,
      "a session whose hook was refused still renders as a healthy tab",
    );
    // And only that one: the mark is per session, not a mode the strip falls into.
    assert.equal(marked.find((tab) => tab.id === fresh.session?.id)?.waitingDetectionLost, false);
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

// The keys a soft keyboard does not have, answering a prompt that BLOCKS on them, through the same
// `Connection.input` as everything else. NOT demonstrated: a thumb on a phone.

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
      // A prompt that BLOCKS: `read` returns only when the line discipline sees CR. The answer is
      // typed, then committed by a key the phone does not otherwise have.
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
      // `&&`, not `;`: an interrupted `sleep` exits non-zero, so the second half is what does NOT
      // happen. With `;` the shell runs it anyway and the check below checks nothing.
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
    // readable on the pane - which is how "sequences, not key names" is checkable at all.
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

      // The same caps with DECCKM set. MEASURED: tmux re-encodes its client's keys, so this proves a
      // real arrow in either mode rather than the byte reaching the pane. A different ORDER, too.
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

// The input box: what a submit actually does to a shell. NOT demonstrated - a thumb, an iOS paste,
// an IME composing - which are the three reasons the box exists and have no headless equivalent.

void describe("the input box, against a real shell", () => {
  void test("Send runs the line; Insert leaves it for the person to commit", async () => {
    const driven = await drive(composerWork);
    const keys = keyboard(driven);
    try {
      const sent = join(composerWork, "sent.txt");
      driven.connection.input(driven.session.id, submitBytes(`touch ${sent}`, "send", false));
      await waitFor("the sent line to run", () => existsSync(sent));

      // Insert is the other half of the promise: the text arrives, and NOTHING runs until Enter.
      const inserted = join(composerWork, "inserted.txt");
      driven.connection.input(driven.session.id, submitBytes(`touch ${inserted}`, "insert", false));
      await waitFor("the inserted line to echo", () => driven.screen().includes("inserted.txt"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(existsSync(inserted), false, "Insert committed the line by itself");

      // The key row's Enter is what commits it, which is the shape the image path relies on too.
      keys.press("enter");
      await waitFor("the inserted line to run once committed", () => existsSync(inserted));
      assert.deepEqual(driven.errors, []);
    } finally {
      driven.connection.stop();
    }
  });

  void test("Ctrl then c in the box interrupts, and sends no newline behind it", async () => {
    const driven = await drive(composerCtrlWork);
    try {
      // The phone's ONLY route to an interrupt now: nothing sends single characters as they are
      // typed any more, so Ctrl+C is the latch plus a one-character submit.
      const finished = join(composerCtrlWork, "the-sleep-finished");
      driven.connection.input(driven.session.id, `sleep 300 && touch ${finished}\r`);
      await new Promise((resolve) => setTimeout(resolve, 750));

      driven.connection.input(driven.session.id, submitBytes("c", "send", true));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      driven.connection.input(driven.session.id, "echo interrupted-from-the-box\r");
      await waitFor(
        "the interrupted shell to answer again",
        () => (driven.screen().match(/interrupted-from-the-box/g) ?? []).length >= 2,
      );
      assert.equal(existsSync(finished), false, "the sleep ran to completion instead of dying");
      assert.deepEqual(driven.errors, []);
    } finally {
      driven.connection.stop();
    }
  });
});
