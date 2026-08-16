// What happens when the node process dies on this Mac: NOTHING RESTARTS IT. Every restart below is
// this test doing by hand what a person would - and SIGKILL of a real pid is the event tested.

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

// `realpathSync`, because macOS `tmpdir()` is a symlink and tmux reports `#{session_path}`
// resolved - and `list()` requires the allowlist entry and the remembered cwd to agree exactly.
const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-crash-home-");
const work = temp("agentdeck-crash-work-");
const conf = temp("agentdeck-crash-conf-");
const secretFile = join(conf, "secret-seen-by-the-agent");

// The pane writes its own AGENTDECK_SECRET where the test can read it: `show-environment -t` has
// nothing, by design, so reading it from inside the pane is what a real hook does.
const profiles = join(conf, "agents.json");
writeFileSync(
  profiles,
  JSON.stringify({
    shell: {
      command: "/bin/sh",
      args: ["-c", `printenv AGENTDECK_SECRET > ${secretFile}; exec sleep 100000`],
    },
    // A second agent, so a create alongside the survivor can be asked for by name. What it
    // proves is computed from `list()`, and `list()` is what a survivor drops out of.
    neighbour: { command: "/bin/sh", args: ["-c", "exec sleep 100000"] },
  }),
);

let port = 0;
let token = "";
let child: ChildProcess | undefined;

// The session created before the crash, and the two facts that outlive the server: the pane pid and
// the secret its pane wrote out. File-scoped, because every test below the first is about it.
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
      // No LANG and no LC_*, deliberately: tmux renders U+001F as `_` for a client it does not
      // believe is UTF-8, which is fixed in `baseEnv` - and is the environment launchd will give.
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
 * Unauthenticated on purpose - the secret in the header is the whole assertion.
 */
const hookPost = async (presented = secret): Promise<number> => {
  const response = await fetch(
    `http://127.0.0.1:${String(port)}/api/hooks/${encodeURIComponent(id)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentdeck-secret": presented },
      body: JSON.stringify({ hook_event_name: "Notification" }),
    },
  );
  return response.status;
};

/** `<session id> <pane pid>` for everything on our socket, so survival is pid-level, not name-level. */
const panes = (): string[] => {
  // An empty socket is a result rather than an error: `list-panes -a` exits non-zero once the last
  // session is gone, which these tests do on purpose.
  let out = "";
  try {
    out = execFileSync(
      "tmux",
      ["-L", socket, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return [];
  }
  return out
    .trim()
    .split("\n")
    .filter((line) => line !== "");
};

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
    // `#meta` still dies with the process; what brings the session back is tmux itself, since the
    // path is the cwd and the id is a pure function of it. Nothing written down.
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

  void test("the adopted session KEEPS its hook path, because the secret is derived", async () => {
    // What used to mute every tab after a restart: the secret is derived rather than minted, so the
    // new process recomputes what the surviving agent still holds.
    const [session] = await listedSessions();
    assert.equal(
      session?.waitingDetectionLost,
      undefined,
      "an adopted session is still reported as having lost its hook path",
    );
    assert.equal(await hookPost(), 200, "the survivor's own secret no longer authenticates");
  });

  void test("and a hook with the WRONG secret is still refused", async () => {
    // The half that must not have loosened. Derivation makes the right secret recomputable; it does
    // not make a wrong one acceptable.
    assert.equal(await hookPost("not-the-secret-at-all"), 401);
  });

  void test("a session outside the allowlist is NOT adopted, however it is named", async () => {
    // A real directory off the allowlist, with a session created under the exact name the server
    // would derive - so the check on `#{session_path}` is the only thing in the way.
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
    // Asserted at the wire rather than the list: the client comes back with the id it held before
    // the crash and must be given a screen. The token is a subprotocol, never a query parameter.
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
          // The heartbeat and the two open-time baseline frames are not answers to the attach.
          if (frame.t === "ping" || frame.t === "sessions" || frame.t === "hello") return;
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

  void test("a second agent in the same tree SEES the survivor in the lists", async () => {
    // Why an invisible survivor was not survivable: it drops out of `list()`, so everything built on
    // that reports a directory as free while an agent is still editing those files.
    const body = await createSession("neighbour");
    assert.equal(body.warning, undefined, "a neighbouring session warned");
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

  void test("recreating reattaches to the same process, hook path intact", async () => {
    const body = await createSession("shell");
    assert.equal(body.session.id, id, "the id is not stable across a restart");
    assert.match(body.warning ?? "", /already running/, "this was a new session, not a reattach");
    assert.ok(panes().includes(paneLine), "the reattach replaced the running process");

    assert.deepEqual(await listedIds(), [id]);

    // `-A` attaches to the live session and injects no environment, which used to be where the
    // secret was lost. Derived, the two are the same string and there is nothing to deliver.
    assert.equal(
      await hookPost(),
      200,
      "the surviving process's secret stopped working after a recreate",
    );
  });

  void test("a refused hook moves no state, and marks the tab muted", async () => {
    // A 401 that still moved the state would say `waiting` on the word of a caller the server could
    // not authenticate. Asserted as "did not CHANGE": an earlier case leaves it legitimately there.
    const before = (await listedSessions())[0]?.state;

    assert.equal(await hookPost("a-secret-from-the-old-scheme"), 401);

    const [session] = await listedSessions();
    assert.equal(session?.state, before, "an unauthenticated hook moved the session's state");
    assert.equal(
      session?.waitingDetectionLost,
      true,
      "a session whose hooks are refused still claims it can report waiting",
    );
  });

  void test("restarting the AGENT clears a detected loss - and does NOT rotate the secret", async () => {
    // Two properties, the second a cost: a restart ends a detected loss, but no longer ROTATES the
    // secret the way a minted one did - only the bearer token changes it now (audit.md).
    const stale = secret;
    const deleted = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.ok(
      !panes().some((line) => line.startsWith(`${id} `)),
      "DELETE left the session it had adopted",
    );

    const restarted = await createSession("shell");
    assert.equal(restarted.session.id, id, "the id is not a function of (cwd, agent) after all");
    assert.equal(restarted.warning, undefined, "this reattached instead of starting a new agent");

    // The new pane writes its own AGENTDECK_SECRET; it is the SAME string, so this waits for the
    // file to exist rather than for it to change.
    let fresh = "";
    for (let i = 0; i < 200 && fresh === ""; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        fresh = readFileSync(secretFile, "utf8").trim();
      } catch {
        fresh = "";
      }
    }
    assert.match(fresh, /^[A-Za-z0-9_-]{20,}$/, "the restarted pane never saw a secret");
    assert.equal(fresh, stale, "the derived secret changed across an agent restart");
    secret = fresh;

    assert.equal(await hookPost(fresh), 200, "restarting the agent did not restore the hook path");

    const [session] = await listedSessions();
    assert.equal(
      session?.waitingDetectionLost,
      undefined,
      "a session whose agent was restarted is still reported as deaf",
    );
    assert.equal(session?.state, "waiting", "the hook it accepted changed no state");
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
