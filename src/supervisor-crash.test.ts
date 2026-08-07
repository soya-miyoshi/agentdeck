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
//   - the registry's metadata does not survive the process, but the half of it tmux still holds
//     does: the restarted server ADOPTS the survivor (m2/session-metadata-survives-restart), so
//     GET /api/sessions lists it with the right cwd and agent and GET /api/cwds counts it
//   - adoption is bounded by the cwd allowlist, matched on `#{session_path}`: a session created
//     on the same socket outside the allowlist is NOT adopted, however it is named
//   - the per-session hook secret does not survive and cannot be recovered, so the surviving
//     agent's hook POSTs are 401 - and recreating the session does NOT fix that, because
//     `new-session -A` attaches to the live session and never re-injects an environment. The
//     adopted session says so, as `waitingDetectionLost`, instead of going quietly deaf
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

import { sessionId } from "./session-id.ts";

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

interface ListedSession {
  id: string;
  cwd: string;
  agent: string;
  state: string;
  waitingDetectionLost?: true;
}

const listedSessions = async (): Promise<ListedSession[]> => {
  const body = (await (await api("/api/sessions")).json()) as { sessions: ListedSession[] };
  return body.sessions;
};

/** The ids `GET /api/sessions` admits to, which is what a survivor used to drop out of. */
const listedIds = async (): Promise<string[]> =>
  (await listedSessions()).map((session) => session.id);

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

  void test("started again by hand, the survivor is adopted: listed, with the right cwd and agent", async () => {
    // The fix for m2/session-metadata-survives-restart. `#meta` still dies with the process; what
    // brings the session back is tmux itself - `#{session_path}` is the cwd and the id is
    // `sessionId(cwd, agent)`, so the agent is the profile that reproduces the id. No file, no
    // database, nothing written down.
    await start();
    assert.deepEqual(await listedIds(), [id], "the surviving session was not adopted");
    assert.deepEqual(await sessionsIn(work), [id], "GET /api/cwds does not count the survivor");

    const [session] = await listedSessions();
    assert.equal(session?.cwd, work, "the adopted session has the wrong cwd");
    assert.equal(session?.agent, "shell", "the adopted session has the wrong agent");
    assert.notEqual(session?.state, "exited", "the survivor is running, not exited");

    // And it is the same process, not a restarted one: adoption attaches, it does not respawn.
    assert.ok(panes().includes(paneLine), "the restart disturbed the session it adopted");
  });

  void test("the adopted session says its waiting detection is dead, rather than going quiet", async () => {
    const [session] = await listedSessions();
    assert.equal(
      session?.waitingDetectionLost,
      true,
      "an adopted session claims a hook path it does not have",
    );
  });

  void test("a session outside the allowlist is NOT adopted, however it is named", async () => {
    // The hole m0/host-boundary closed, checked against the new door. `outside` is a real
    // directory that is not in AGENTDECK_MOUNTS, and the session is created with the exact name
    // the server would derive for it - `sessionId(outside, "shell")` - so the only thing standing
    // between it and a tab on the phone is the allowlist check on `#{session_path}`.
    const outside = temp("agentdeck-crash-outside-");
    const forged = sessionId(outside, "shell");
    execFileSync("tmux", [
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      forged,
      "-c",
      outside,
      "--",
      "/bin/sh",
      "-c",
      "exec sleep 100000",
    ]);
    try {
      assert.ok(
        panes().some((line) => line.startsWith(`${forged} `)),
        "the forged session was not created, so this test proves nothing",
      );
      assert.deepEqual(
        await listedIds(),
        [id],
        "a session outside the allowlist was adopted onto the phone",
      );
      assert.equal(await sessionsIn(outside), undefined, "the outside directory became a cwd");
      // Not adopted also means not touched: no kill, no reap.
      assert.ok(
        panes().some((line) => line.startsWith(`${forged} `)),
        "the server killed a session it refuses to list",
      );
    } finally {
      execFileSync("tmux", ["-L", socket, "kill-session", "-t", `=${forged}`], { stdio: "ignore" });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  void test("an attach the client had before the crash is answered with a snapshot, not `no session`", async () => {
    // The half of m2/reconnect this item unblocks, asserted at the wire rather than the list: the
    // client comes back with the id it held before the crash and must be given a screen.
    // The token is a subprotocol, not a query parameter: a URL lands in logs and history (ws.ts).
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, token);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          resolve();
        });
        ws.addEventListener("error", () => {
          reject(new Error("the socket refused the token"));
        });
      });
      const answered = new Promise<{ t: string; message?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("nothing answered the attach within 10s"));
        }, 10_000);
        timer.unref();
        ws.addEventListener("message", (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data)) as { t: string; message?: string };
          if (frame.t === "ping" || frame.t === "sessions") return;
          clearTimeout(timer);
          resolve(frame);
        });
      });
      ws.send(JSON.stringify({ t: "attach", sessionId: id, cols: 80, rows: 24 }));
      const frame = await answered;
      assert.equal(frame.t, "snapshot", `the re-attach was answered ${JSON.stringify(frame)}`);
    } finally {
      ws.close();
    }
  });

  void test("a second agent in the same tree IS warned about the survivor", async () => {
    // The failure mode that costs a working tree rather than a notification, and the reason the
    // survivor being merely invisible was not survivable: `Registry.create` reads its neighbours
    // from `list()`, so before adoption the phone was told nothing while the first agent was still
    // running in that directory and still editing those files.
    const body = await createSession("neighbour");
    assert.match(
      body.warning ?? "",
      /shell is\s+already running/,
      "the adopted survivor was not named in the two-agents-in-one-tree warning",
    );
    assert.ok(panes().includes(paneLine), "the second agent disturbed the surviving session");

    // And `GET /api/cwds` reports the directory as holding one session when it holds two.
    assert.deepEqual((await sessionsIn(work))?.slice().sort(), [body.session.id, id].sort());

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

    assert.deepEqual(await listedIds(), [id]);

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
    assert.match(m0, /m0\/supervisor-crash-test/);
    // The metadata half: what a restart now recovers, and the one thing it cannot.
    assert.match(m0, /adopts/i, "M0 does not say the survivor is adopted");
    assert.match(m0, /waitingDetectionLost/, "M0 does not name what the survivor loses");
  });

  void test("M1's done-when describes a restart that lists the survivor by itself", async () => {
    // It used to say a plain list after a restart showed nothing. Adoption changed the behaviour,
    // so the plan changed with it - and the loss it cannot undo is named in the same sentence.
    const plan = await readFile(new URL("../plans/003-milestones.md", import.meta.url), "utf8");
    const m1 = plan.slice(plan.indexOf("## M1"), plan.indexOf("## M2"));
    assert.match(m1, /adopts/i);
    assert.match(m1, /waitingDetectionLost/);
  });
});

void describe("plan 002 states what a restart costs, because the client has to show it", () => {
  void test("the wire contract carries waitingDetectionLost and says why it exists", async () => {
    const plan = await readFile(new URL("../plans/002-wire-protocol.md", import.meta.url), "utf8");
    assert.match(plan, /waitingDetectionLost\?: true/, "the Session shape does not carry the flag");
    // The consequence, not just the field: the secret is unrecoverable and the agent must restart.
    assert.match(plan, /The hook secret is not recovered, and cannot be/);
    assert.match(plan, /never again report\s+`waiting`/);
    // And that adoption did not widen the boundary m0/host-boundary drew.
    assert.match(plan, /Adoption is bounded by the same allowlist/);
  });
});
