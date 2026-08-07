// m2/client-minimal's done-when, executed rather than asserted about: an agent driven from the
// browser end to end.
//
// Nothing serves the built SPA yet - that is m2/serve-client, a separate open item - so the page
// is not what is driven here. What is driven is every client module BELOW the page, unmodified and
// in the same wiring App.vue gives them: `browserSocket` opening a real WebSocket against a real
// server process, `Connection` multiplexing over it, `stream-position` deciding what each frame
// means, and the render callback App.vue passes in. The only pieces left out are the two that need
// a DOM - the Vue components and xterm's renderer - and the seam they sit behind, TerminalHandle,
// is four verbs wide, so a stand-in for it here writes what xterm would have painted.
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
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Session } from "../registry.ts";
import { browserSocket } from "./browser-socket.ts";
import { Connection, type SocketLike } from "./connection.ts";
import type { TerminalHandle } from "./terminal-handle.ts";

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
const conf = temp("agentdeck-e2e-conf-");

const profiles = join(conf, "agents.json");
// A plain shell, which is the profile-less agent the status work is proven against too. The point
// of this test is the transport and the client, and a shell is the agent whose replies a test can
// state exactly.
writeFileSync(profiles, JSON.stringify({ sh: { command: "/bin/sh", args: [], name: "Shell" } }));

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
      AGENTDECK_MOUNTS: `${work}:${pasteWork}:${dropWork}:${restartWork}`,
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
  for (const dir of [home, work, pasteWork, dropWork, restartWork, conf]) {
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
