// m0/supervisor-crash-test: what actually happens when the node process dies on this Mac.
//
// NOTHING RESTARTS THE SERVER. There is no supervisor, no restart loop, no launchd agent and no
// watchdog on this machine, and this file does not add one - answering that is m4/launchd-watchdog
// (plan 006). Every restart below is this test process starting the server again by hand, in the
// same way a person would have to, and the assertions in between are what an unattended Mac looks
// like in the window before that person arrives: tmux still holding every agent, and nothing
// answering the port.
//
// What it pins down, because "the sessions survive" is only half the story:
//   - the tmux sessions survive with the same ids and the same pane pids, so the work is intact
//   - the registry's metadata does not survive, and `Registry.list()` is gated on it, so a
//     surviving session is not listed AT ALL rather than listed under its raw id
//   - therefore GET /api/sessions is empty and GET /api/cwds reports no sessions in the directory
//   - the per-session hook secret does not survive either, so the surviving agent's hook POSTs
//     are 401 - and recreating the session does NOT fix that, because `new-session -A` attaches
//     to the live session and never re-injects an environment, so the running process keeps a
//     secret the new registry has never heard of
//
// The server is spawned as a process rather than driven in-process, for the same reason
// src/host-boundary.test.ts does it: SIGKILL of a real pid is the event being tested.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("server.ts", import.meta.url));
const socket = `agentdeck-crash-${String(process.pid)}`;

// `realpathSync`, because on macOS `os.tmpdir()` is `/var/folders/...`, a symlink into
// `/private`. tmux reports `#{session_path}` resolved, and `Registry.list()` requires the
// allowlist entry and the remembered cwd to agree with it exactly.
const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-crash-home-");
const work = temp("agentdeck-crash-work-");
const conf = temp("agentdeck-crash-conf-");
const secretFile = join(conf, "secret-seen-by-the-agent");

// The pane writes its own AGENTDECK_SECRET where the test can read it, then stays alive. This is
// the only way to get at it: `createOrAttach` deliberately unsets the variable from the tmux
// session environment in the same invocation that creates the session, so `show-environment -t`
// has nothing. Reading it from inside the pane is exactly what a real hook does.
const profiles = join(conf, "agents.json");
writeFileSync(
  profiles,
  JSON.stringify({
    shell: {
      command: "/bin/sh",
      args: ["-c", `printenv AGENTDECK_SECRET > ${secretFile}; exec sleep 100000`],
    },
    // A second agent, so the two-agents-in-one-tree warning can be asked for by name. The
    // warning is computed from `list()`, and `list()` is what a survivor drops out of.
    neighbour: { command: "/bin/sh", args: ["-c", "exec sleep 100000"] },
  }),
);

let port = 0;
let token = "";
let child: ChildProcess | undefined;

// The session created before the crash, and the two facts about it that outlive the server: the
// pane pid tmux still holds, and the secret its own pane wrote out. Every test below the first
// one is about this session, so they are file-scoped rather than passed around.
let id = "";
let paneLine = "";
let secret = "";

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
const start = async (): Promise<ChildProcess> => {
  const started = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      TMUX_SOCKET: socket,
      HOME: home,
      AGENTDECK_PORT: String(port),
      AGENTDECK_MOUNTS: work,
      AGENTDECK_PROFILES: profiles,
      // No LANG and no LC_* here, deliberately. `Tmux.list()` separates its fields with U+001F,
      // and tmux renders that byte as `_` unless it believes the locale is UTF-8 - so with LANG
      // unset every field of every session parsed into one string and nothing was ever listed.
      // That was m0/create-500, and it is fixed at its cause in `baseEnv` - so LANG is NOT passed
      // any more, and this test now also crosses the locale-less environment launchd will hand
      // the job at m4.
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  child = started;
  return started;
};

/** SIGKILL it and wait for the pid to be gone. Returns the signal the kernel reports. */
const crash = async (target: ChildProcess): Promise<NodeJS.Signals | null> => {
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    target.on("exit", (_code, sig) => {
      resolve(sig);
    });
  });
  target.kill("SIGKILL");
  const signal = await exited;
  if (child === target) child = undefined;
  return signal;
};

const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
  await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });

/** The ids `GET /api/sessions` admits to, which is the thing a survivor drops out of. */
const listedIds = async (): Promise<string[]> => {
  const body = (await (await api("/api/sessions")).json()) as { sessions: { id: string }[] };
  return body.sessions.map((session) => session.id);
};

/** The ids `GET /api/cwds` reports for one directory, `undefined` if it names no such directory. */
const sessionsIn = async (path: string): Promise<string[] | undefined> => {
  const body = (await (await api("/api/cwds")).json()) as {
    cwds: { path: string; sessions: string[] }[];
  };
  return body.cwds.find((cwd) => cwd.path === path)?.sessions;
};

const createSession = async (
  agent: string,
): Promise<{ session: { id: string }; warning?: string }> => {
  const created = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: work, agent }),
  });
  assert.equal(created.status, 201, `create failed: ${await created.clone().text()}`);
  return (await created.json()) as { session: { id: string }; warning?: string };
};

/**
 * A hook POST as the surviving agent makes it: its own id, and the secret its pane was given.
 *
 * Unauthenticated on purpose - the bearer token is not what this route checks. The secret in the
 * header is the whole assertion, so it is never routed through `api`.
 */
const hookPost = async (): Promise<number> => {
  const response = await fetch(
    `http://127.0.0.1:${String(port)}/api/hooks/${encodeURIComponent(id)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentdeck-secret": secret },
      body: JSON.stringify({ hook_event_name: "Notification" }),
    },
  );
  return response.status;
};

/** `<session id> <pane pid>` for everything on our socket, so survival is pid-level, not name-level. */
const panes = (): string[] =>
  execFileSync("tmux", ["-L", socket, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((line) => line !== "");

before(async () => {
  port = await freePort();
});

after(() => {
  if (child !== undefined) child.kill("SIGKILL");
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Already gone: the desired end state.
  }
  for (const dir of [home, work, conf]) rmSync(dir, { recursive: true, force: true });
});

void describe("the node process is killed and nothing brings it back", () => {
  void test("a session created beforehand is listed, in /api/cwds, and its hooks are accepted", async () => {
    const first = await start();
    token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();

    id = (await createSession("shell")).session.id;

    paneLine = panes().find((line) => line.startsWith(`${id} `)) ?? "";
    assert.notEqual(paneLine, "", "tmux has no pane for the session it just created");

    assert.deepEqual(await listedIds(), [id]);
    assert.deepEqual(await sessionsIn(work), [id]);

    // The pane wrote its own AGENTDECK_SECRET out; give it the moment that takes.
    for (let i = 0; i < 100 && secret === ""; i++) {
      try {
        secret = readFileSync(secretFile, "utf8").trim();
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.match(secret, /^[A-Za-z0-9_-]{20,}$/, "the pane never saw a secret");

    assert.equal(
      await hookPost(),
      200,
      "the hook route rejected the secret its own session was given",
    );

    // SIGKILL, which is the crash: no shutdown handler runs, nothing is detached, nothing is
    // saved. NOTHING RESTARTS IT. What follows is the unattended Mac.
    assert.equal(await crash(first), "SIGKILL");
  });

  void test("nothing is listening afterwards, because nothing supervises the node process", async () => {
    await assert.rejects(
      async () => await fetch(`http://127.0.0.1:${String(port)}/api/health`),
      "something answered the port after the server was killed - this repo has no supervisor",
    );
  });

  void test("the tmux session and its process survive the crash unchanged", () => {
    // tmux is a daemon of its own, owned by the user: the server dying is not an event it sees.
    // Same id AND same pane pid, so this is the original process still running, not a new one.
    assert.ok(
      panes().includes(paneLine),
      `the session did not survive; tmux holds ${panes().join(", ")}`,
    );
  });

  void test("started again by hand, the survivor is not listed at all - the metadata is gone", async () => {
    // Not "listed under its raw id": m0/host-boundary gated `Registry.list()` on BOTH the cwd
    // allowlist and `#meta`, and `#meta` is memory only, so a session that outlived the process
    // that created it drops out of every route. The work is running and the server cannot see it.
    await start();
    assert.deepEqual(await listedIds(), [], "the surviving session was listed after a restart");
    assert.deepEqual(
      await sessionsIn(work),
      [],
      "GET /api/cwds still reports the session it can no longer see",
    );

    // And it is not reaped or killed either - `reap()` goes through the same `list()`. Left alone.
    assert.ok(panes().includes(paneLine), "the restart disturbed a session it cannot see");
  });

  void test("the surviving agent's hooks are rejected as unsigned, so it never reports waiting", async () => {
    assert.equal(await hookPost(), 401, "a secret the new process never generated was accepted");
  });

  void test("a second agent in the same tree gets NO warning, because the survivor is invisible", async () => {
    // The named failure mode, and the one that costs a working tree rather than a notification.
    // Before the crash, starting a second agent in `work` would have been answered with "shell is
    // already running in <cwd>. Two processes editing one working tree produce conflicts neither
    // understands." After it, `Registry.create` reads its neighbours from `list()`, the survivor
    // is not in `list()`, and the phone is told nothing at all - while the first agent is still
    // running in that directory and still editing those files.
    const body = await createSession("neighbour");
    assert.equal(body.warning, undefined, "the survivor was named in a warning it cannot be in");
    assert.ok(panes().includes(paneLine), "the second agent disturbed the surviving session");

    // And `GET /api/cwds` reports the directory as holding one session when it holds two.
    assert.deepEqual(await sessionsIn(work), [body.session.id]);

    // Cleared away so the assertions below are about the survivor alone. This one the server does
    // own - it has `#meta` for it - so DELETE reaches it, which is itself the contrast.
    const deleted = await api(`/api/sessions/${encodeURIComponent(body.session.id)}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    assert.ok(
      !panes().some((line) => line.startsWith(`${body.session.id} `)),
      "DELETE left the session it does own",
    );
  });

  void test("recreating reattaches to the same process - and does not restore the hook path", async () => {
    const body = await createSession("shell");
    assert.equal(body.session.id, id, "the id is not stable across a restart");
    assert.match(body.warning ?? "", /already running/, "this was a new session, not a reattach");
    assert.ok(panes().includes(paneLine), "the reattach replaced the running process");

    assert.deepEqual(
      await listedIds(),
      [id],
      "the session is still invisible after being recreated",
    );

    // The unsolved half, sharper than the TODO text has it. `new-session -A` attaches to the live
    // session and injects no environment, so the process that survived still holds the OLD secret
    // while the registry has minted a NEW one it has no way to deliver. Recreating the session
    // does not bring that tab's `waiting` back; only killing and restarting the agent does.
    assert.equal(
      await hookPost(),
      401,
      "the surviving process's secret works again after a recreate",
    );
  });
});

void describe("plan 003 says so in the plan, not only here", () => {
  void test("M0 states plainly that nothing restarts the server", async () => {
    const plan = await readFile(new URL("../plans/003-milestones.md", import.meta.url), "utf8");
    const m0 = plan.slice(plan.indexOf("## M0"), plan.indexOf("## M1"));
    assert.match(m0, /Nothing supervises Node/);
    assert.match(m0, /nothing restart(s|ed) the (node |Node )?(server|process)/i);
    // The metadata half, which is the part a reader would otherwise assume M1's "same session
    // still running with the same id" covers.
    assert.match(m0, /m0\/supervisor-crash-test/);
    assert.match(m0, /not listed/i);
  });

  void test("M1's done-when no longer claims a restarted server lists the survivor", async () => {
    // It said "creating a session, restarting the server, and listing again shows the same session
    // still running with the same id". The test above shows that listing is empty.
    const plan = await readFile(new URL("../plans/003-milestones.md", import.meta.url), "utf8");
    const m1 = plan.slice(plan.indexOf("## M1"), plan.indexOf("## M2"));
    assert.match(m1, /recreat/i, "M1 still describes a restart that lists the session by itself");
  });
});
