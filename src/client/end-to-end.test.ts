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
import { Connection } from "./connection.ts";
import type { TerminalHandle } from "./terminal-handle.ts";

const run = promisify(execFile);
const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const socket = `agentdeck-e2e-${String(process.pid)}`;

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-e2e-home-");
const work = temp("agentdeck-e2e-work-");
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

before(async () => {
  port = await freePort();
  const started = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      TERM: "xterm-256color",
      LC_ALL: "en_US.UTF-8",
      TMUX_SOCKET: socket,
      AGENTDECK_PORT: String(port),
      AGENTDECK_MOUNTS: work,
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
  for (const dir of [home, work, conf]) rmSync(dir, { recursive: true, force: true });
});

/** What xterm would have painted, in the order it would have painted it. */
const paintedTerminal = (): TerminalHandle & { text: () => string } => {
  let painted = "";
  return {
    write: (data) => (painted += data),
    clear: () => (painted = ""),
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
  errors: string[];
}

/**
 * A session created over the real HTTP API, and a client attached to it over the real socket.
 *
 * The render callback is App.vue's, restated: a repaint clears and writes history first, because a
 * snapshot supersedes everything before it.
 */
const drive = async (): Promise<Driven> => {
  const created = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd: work, agent: "sh" }),
  });
  const body = (await created.json()) as { session?: Session; error?: string };
  assert.equal(created.status, 201, body.error ?? "");
  const session = body.session;
  assert.ok(session, "the server created no session");

  const terminal = paintedTerminal();
  const errors: string[] = [];
  let opens = 0;
  const { browserSocket } = await import("./browser-socket.ts");

  const connection = new Connection(
    {
      token,
      connect: (value, handlers) => {
        opens += 1;
        return browserSocket(value, handlers);
      },
      verifyToken: async () => {
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return response.status !== 401;
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
  return { connection, session, screen: () => terminal.text(), opens: () => opens, errors };
};

void describe("an agent driven from the browser, end to end", () => {
  void test("a keystroke reaches the agent and its output paints back", async () => {
    const driven = await drive();
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
    const driven = await drive();
    try {
      const out = join(work, "pasted.txt");
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
  void test("were really tmux sessions, not a fixture", async () => {
    // Guards the whole file against the failure mode that would make it pass while proving
    // nothing: a server that answered without tmux ever being involved.
    assert.ok(sessionNames().length >= 1, "no tmux session was created");
    await Promise.resolve();
  });
});
