// m3/new-session-picker's done-when, executed rather than asserted about: a session created
// THROUGH the picker's own code path.
//
// src/client/end-to-end.test.ts creates its session over the API before driving the client, which
// is exactly why the missing picker survived every green milestone. Here nothing posts by hand:
// the directory comes from `fetchCwds`, the agent from `fetchAgents`, both are put through
// `directoryChoices`/`agentChoices`/`canStart`, and the create is `createSession` from
// src/client/api.ts - the same modules NewSession.vue and App.vue call. The server end is real all
// the way down: a spawned src/server.ts, the real tmux binary, a real pty, a real /bin/sh.
//
// What a person with a phone must still confirm by hand, because it is not scriptable from here:
// that the sheet's rows and the Start button are reachable one-handed, that the sheet clears the
// home indicator and the notch on a device with insets, and that the warning banner is legible
// over the terminal. The logic below is the same logic the component renders; the geometry is not.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSession, fetchAgents, fetchCwds } from "./api.ts";
import { browserSocket } from "./browser-socket.ts";
import { Connection } from "./connection.ts";
import { agentChoices, canStart, directoryChoices } from "./new-session.ts";
import type { TerminalHandle } from "./terminal-handle.ts";

const run = promisify(execFile);
const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const socket = `agentdeck-picker-${String(process.pid)}`;

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-picker-home-");
const conf = temp("agentdeck-picker-conf-");
// One tree per case: a session id is a pure function of (path, agent), so two cases naming the
// same pair are handed the same tmux session by `new-session -A`.
const pickWork = temp("agentdeck-picker-pick-");
const twoWork = temp("agentdeck-picker-two-");
const offList = temp("agentdeck-picker-off-");

const profiles = join(conf, "agents.json");
// `missing` is the point of the file: a profile whose command does not resolve on PATH, which is
// what `available: false` means and what the picker must refuse to start.
writeFileSync(
  profiles,
  JSON.stringify({
    sh: { command: "/bin/sh", args: [], name: "Shell" },
    other: { command: "/bin/sh", args: [], name: "Other shell" },
    missing: { command: "definitely-not-installed-agentdeck", args: [], name: "Absent agent" },
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
const startServer = async (): Promise<void> => {
  const started = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      TERM: "xterm-256color",
      LC_ALL: "en_US.UTF-8",
      TMUX_SOCKET: socket,
      AGENTDECK_PORT: String(port),
      AGENTDECK_MOUNTS: [pickWork, twoWork].join(":"),
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
};

const realFetch = globalThis.fetch;

before(async () => {
  port = await freePort();
  await startServer();
  token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();
  const base = `http://127.0.0.1:${String(port)}`;
  // api.ts asks for "/api/cwds" because a browser resolves that against the page it was served
  // from. Node has no page, so the base is supplied here and the request itself is still the real
  // one, over the real network, to the real server.
  globalThis.fetch = async (input: Parameters<typeof realFetch>[0], init?: RequestInit) =>
    await realFetch(typeof input === "string" ? new URL(input, base) : input, init);
  Reflect.set(globalThis, "window", { location: { href: `${base}/` } });
});

after(async () => {
  globalThis.fetch = realFetch;
  if (child !== undefined) child.kill("SIGKILL");
  try {
    await run("tmux", ["-L", socket, "kill-server"]);
  } catch {
    // Already gone: the desired end state.
  }
  for (const dir of [home, conf, pickWork, twoWork, offList]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

/** What xterm would have painted, in the order it would have painted it. */
const paintedTerminal = (): TerminalHandle & { text: () => string } => {
  let painted = "";
  return {
    write: (data) => (painted += data),
    clear: () => (painted = ""),
    size: () => ({ cols: 80, rows: 24 }),
    focus: () => undefined,
    applicationCursorKeys: () => false,
    text: () => painted,
  };
};

void describe("the new-session picker, against a real server", () => {
  void test("starts a session with a directory and an agent chosen from what the server reported", async () => {
    // Everything the picker offers, fetched the way it fetches it. Nothing below types a path.
    const directories = directoryChoices(await fetchCwds(token));
    const agents = agentChoices(await fetchAgents(token));
    assert.deepEqual(
      directories.map((d) => d.path).sort(),
      [pickWork, twoWork].sort(),
      "the picker was offered directories the server did not name",
    );

    const chosenDir = directories.find((d) => d.path === pickWork);
    const chosenAgent = agents.find((a) => a.id === "sh");
    assert.ok(chosenDir && chosenAgent);
    assert.ok(canStart(directories, agents, chosenDir.path, chosenAgent.id));

    const { session, warning } = await createSession(token, chosenDir.path, chosenAgent.id);
    assert.equal(warning, undefined, "a first session in an empty directory warned about nothing");
    assert.equal(session.cwd, pickWork);
    assert.equal(session.agent, "sh");

    // tmux really has it, and a real shell in it answers a real keystroke sent over the real
    // socket - so what the picker created is a usable session, not a record of one.
    const { stdout } = await run("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"]);
    assert.ok(stdout.includes(session.id), `tmux does not list ${session.id}:\n${stdout}`);

    const terminal = paintedTerminal();
    const connection = new Connection(
      {
        token,
        connect: browserSocket,
        verifyToken: async () => await Promise.resolve("ok"),
      },
      {
        render: (_id, action) => {
          if (action.kind === "repaint") terminal.clear();
          terminal.write(action.data);
        },
        state: () => undefined,
        sessions: () => undefined,
        error: () => undefined,
        status: () => undefined,
        unauthorized: () => undefined,
      },
    );
    connection.start();
    try {
      await waitFor("the socket to open", () => connection.status === "open");
      connection.attach(session.id, 80, 24);
      await waitFor("the first paint", () => terminal.text() !== "");
      connection.input(session.id, "echo started-from-the-picker\r");
      await waitFor(
        "the shell's output to paint",
        // Twice: echoed by the tty, then printed by `echo`. The second is the one that proves the
        // bytes reached a process the picker started.
        () => (terminal.text().match(/started-from-the-picker/g) ?? []).length >= 2,
      );
    } finally {
      connection.stop();
    }
  });

  void test("cannot start an agent whose command does not resolve on PATH", async () => {
    const directories = directoryChoices(await fetchCwds(token));
    const agents = agentChoices(await fetchAgents(token));
    const absent = agents.find((a) => a.id === "missing");
    assert.ok(absent);
    assert.equal(absent.selectable, false);
    assert.match(absent.note ?? "", /not on PATH/);
    assert.equal(
      canStart(directories, agents, pickWork, "missing"),
      false,
      "the picker would have started an agent that is not installed",
    );
  });

  void test("shows the warning the server returns rather than swallowing it", async () => {
    // Two agents in one working tree: allowed, and worth saying out loud.
    const first = await createSession(token, twoWork, "sh");
    assert.equal(first.warning, undefined);
    const second = await createSession(token, twoWork, "other");
    assert.ok(second.warning, "a second agent in one working tree returned no warning");
    assert.match(second.warning, /already running in/);
    assert.ok(second.warning.includes(twoWork));

    // The same agent again: the running session is handed back, and the response says so.
    const again = await createSession(token, twoWork, "sh");
    assert.equal(again.session.id, first.session.id);
    assert.ok(again.warning, "attaching to a running session returned no warning");
    assert.match(again.warning, /attached to it rather than to a new one/);
  });

  void test("renders the server's own sentence when a create is refused", async () => {
    // Not reachable from the picker - `offList` is not among the directories it was given - so
    // this is what a refusal looks like if one is ever provoked, worded by the server.
    await assert.rejects(
      async () => await createSession(token, offList, "sh"),
      (error: Error) => {
        assert.ok(error.message.startsWith(`${offList} is not on the allowlist`));
        assert.match(error.message, /AGENTDECK_MOUNTS/);
        return true;
      },
    );
    await assert.rejects(
      async () => await createSession(token, pickWork, "nosuchagent"),
      (error: Error) => {
        assert.equal(error.message, "no agent profile named nosuchagent");
        return true;
      },
    );
  });
});

void describe("what the picker offers", () => {
  void test("says how many sessions a directory already has, before creating another", () => {
    const [empty, busy] = directoryChoices([
      { path: "/a/repo", name: "repo", sessions: [] },
      { path: "/a/web", name: "web", sessions: ["id_1", "id_2"] },
    ]);
    assert.ok(empty && busy);
    assert.equal(empty.note, undefined);
    assert.equal(busy.note, "2 already running here");
  });

  void test("marks an agent that will never report waiting, in the strip's words", () => {
    const [deaf] = agentChoices([
      { id: "shell", name: "Shell", available: true, detectsWaiting: false },
    ]);
    assert.equal(deaf?.note, "no waiting alerts");
    const [detects] = agentChoices([
      { id: "claude", name: "Claude Code", available: true, detectsWaiting: true },
    ]);
    assert.equal(detects?.note, undefined);
    assert.equal(detects?.selectable, true);
  });

  void test("refuses Start until both halves are chosen from the offered lists", () => {
    const directories = directoryChoices([{ path: "/a/repo", name: "repo", sessions: [] }]);
    const agents = agentChoices([
      { id: "sh", name: "Shell", available: true, detectsWaiting: false },
    ]);
    assert.equal(canStart(directories, agents, undefined, "sh"), false);
    assert.equal(canStart(directories, agents, "/a/repo", undefined), false);
    assert.equal(canStart(directories, agents, "/typed/by/hand", "sh"), false);
    assert.equal(canStart(directories, agents, "/a/repo", "sh"), true);
  });
});
