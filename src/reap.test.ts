// The reaper, executed rather than asserted about: each case builds the real shape on the real
// process table - a double-forked orphan, a tmux server holding nothing, a tree with a listener in
// it - runs one pass of scripts/reap.mjs, and then looks at what is still alive.
//
// Nothing here asserts about the script's source. A reaper that reads correctly and signals the
// wrong pid is the whole failure mode, and only running it can tell the two apart.
//
// Every pass is scoped twice so a test run cannot reap the machine it runs on: AGENTDECK_ROOTS is a
// temp directory, which is what the process half is bounded by, and AGENTDECK_REAP_SOCKET_PREFIX is
// a per-case namespace, which is what the tmux half is bounded by. Both are per CASE rather than per
// file, so one case's `--kill` cannot destroy another's fixture and the order they run in is free.
//
// Fixtures are built once, before any case runs. `ps` reports elapsed time in whole seconds, so
// everything is zero seconds old for its first second and no age bound above zero can match it - the
// suite would pass by finding nothing. That wait is unavoidable but it is ONE second for the file,
// not one per case: this suite holds a worker for as long as it runs, and audit.md's
// `test-concurrency` entry records what holding workers does to the wall-clock-bound suites.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reaper = join(repoRoot, "scripts", "reap.mjs");

const base = `reaptest-${String(process.pid)}-`;
const temps: string[] = [];
const strays: number[] = [];
const sockets: string[] = [];

const temp = (name: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  temps.push(dir);
  return dir;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const isOrphan = (pid: number): boolean => {
  const ppid = spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  return Number((ppid.stdout || "0").trim()) === 1;
};

/**
 * A process with ppid 1 and no controlling terminal, which is the shape a leftover actually has.
 *
 * Double-forked on purpose: a child of this runner has a living parent, and every condition the
 * reaper checks would correctly refuse to touch it - so a case that spawned normally would pass
 * without exercising anything.
 */
const orphan = (cwd: string, command: string): number => {
  // Two things are load-bearing here, both found by the pid not matching what the reaper reported.
  // The redirection: a backgrounded child inherits this pipe, so without it `execFileSync` waits
  // for a `sleep 100000` to close stdout and never returns. And no brace group around the command,
  // so `exec` replaces the backgrounded subshell itself and `$!` is the pid that actually survives.
  const printed = execFileSync(
    "/bin/sh",
    ["-c", `cd ${cwd} && ${command} >/dev/null 2>&1 & echo $!`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const pid = Number(printed.trim());
  strays.push(pid);
  // The intermediate shell has to be gone before the child is an orphan, and it exits on its own.
  for (let i = 0; i < 100 && !isOrphan(pid); i += 1) spawnSync("/bin/sleep", ["0.05"]);
  return pid;
};

/** A tmux server on its own socket, with `exit-empty off` set the way the real server sets it. */
const tmuxServer = (socket: string, withSession: boolean): string => {
  sockets.push(socket);
  if (withSession) {
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", "work", "sleep", "100000"], {
      stdio: "ignore",
    });
    execFileSync("tmux", ["-L", socket, "set-option", "-g", "exit-empty", "off"], {
      stdio: "ignore",
    });
  } else {
    // Chained into ONE command, the way tmux.ts does it and for the same reason: `exit-empty` is on
    // by default, so a server started with no sessions exits before a second tmux invocation can
    // reach it. Two commands here failed outright, which is the race that comment describes.
    execFileSync(
      "tmux",
      ["-L", socket, "start-server", ";", "set-option", "-g", "exit-empty", "off"],
      { stdio: "ignore" },
    );
  }
  return socket;
};

/** Whether anything at all answers on that socket, session or no session. */
const socketAnswers = (socket: string): boolean => {
  const probe = spawnSync("tmux", ["-L", socket, "list-sessions"], { encoding: "utf8" });
  const text = `${probe.stdout}${probe.stderr}`;
  return probe.status === 0 || /no sessions/i.test(text);
};

/** Whether a pid holds a listening TCP socket right now. */
const listens = (pid: number): boolean =>
  spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-i", "-sTCP:LISTEN"], {
    encoding: "utf8",
  }).stdout.trim() !== "";

interface Pass {
  status: number | null;
  output: string;
}

interface Options {
  kill?: boolean;
  roots?: string;
  minAgeMs?: string;
  prefix?: string;
  liveSocket?: string;
}

/** One pass of the reaper, scoped to the caller's own root and socket namespace. */
const reap = (options: Options = {}): Pass => {
  const result = spawnSync(
    process.execPath,
    [reaper, ...(options.kill === true ? ["--kill"] : [])],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "",
        AGENTDECK_ROOTS: options.roots ?? "",
        AGENTDECK_REAP_SOCKET_PREFIX: options.prefix ?? `${base}none-`,
        AGENTDECK_REAP_MIN_AGE_MS: options.minAgeMs ?? "1",
        AGENTDECK_REAP_STOP_GRACE_MS: "1000",
        TMUX_SOCKET: options.liveSocket ?? `${base}unused`,
        TMUX_TMPDIR: process.env["TMUX_TMPDIR"] ?? "/private/tmp",
      },
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

// One root and one namespace per case, so no case can see or destroy another's fixture.
const roots = {
  report: "",
  kill: "",
  outside: "",
  listening: "",
  young: "",
  parented: "",
};
const pids = { report: 0, kill: 0, outside: 0, listening: 0, parented: 0 };
const socketNames = {
  empty: `${base}empty-sock`,
  busy: `${base}busy-sock`,
  live: `${base}live-sock`,
};

before(() => {
  for (const key of Object.keys(roots) as (keyof typeof roots)[]) {
    roots[key] = temp(`agentdeck-reap-${key}-`);
  }
  pids.report = orphan(roots.report, "exec /bin/sleep 100000");
  pids.kill = orphan(roots.kill, "exec /bin/sleep 100000");
  pids.outside = orphan(roots.outside, "exec /bin/sleep 100000");
  pids.listening = orphan(
    roots.listening,
    `exec ${process.execPath} -e "require('node:net').createServer().listen(0,'127.0.0.1');setInterval(()=>{},1e9)"`,
  );
  // NOT double-forked, which is the point: this runner stays alive as its parent, so ppid is never
  // 1 and the reaper's first condition already excludes it.
  const child = spawn("/bin/sleep", ["100000"], { cwd: roots.parented, stdio: "ignore" });
  pids.parented = child.pid ?? 0;
  strays.push(pids.parented);

  tmuxServer(socketNames.empty, false);
  tmuxServer(socketNames.busy, true);
  tmuxServer(socketNames.live, false);

  // The listener has to exist before any pass, or the exemption case proves nothing.
  for (let i = 0; i < 100 && !listens(pids.listening); i += 1) spawnSync("/bin/sleep", ["0.05"]);
  // The one age wait for the whole file. See the header.
  spawnSync("/bin/sleep", ["1.2"]);
});

after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped, which is what half of these cases are about.
    }
  }
  for (const socket of sockets) {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

void describe("the reaper refuses to act without a provenance boundary", () => {
  void test("no roots means it reaps nothing and says why", () => {
    const pass = reap({ kill: true, roots: "" });
    assert.equal(pass.status, 2, pass.output);
    assert.match(pass.output, /AGENTDECK_ROOTS/);
    // The refusal has to say what the roots are FOR, or the obvious fix is to widen the rule.
    assert.match(pass.output, /launchd daemon/i);
    assert.ok(alive(pids.report), "a refusing pass still killed something");
  });
});

void describe("reporting is the default", () => {
  void test("an orphan under a root is named but left running", () => {
    const pass = reap({ roots: roots.report });
    assert.equal(pass.status, 0, pass.output);
    assert.match(pass.output, new RegExp(`pid ${String(pids.report)}\\b`), pass.output);
    assert.ok(alive(pids.report), "the default pass killed a process; it is meant to report only");
  });
});

void describe("what --kill reaps", () => {
  void test("an orphan working under a root", async () => {
    const pass = reap({ kill: true, roots: roots.kill });
    assert.equal(pass.status, 0, pass.output);
    await settle();
    assert.ok(!alive(pids.kill), `pid ${String(pids.kill)} survived --kill\n${pass.output}`);
  });

  void test("a tmux server in the namespace that holds no sessions", async () => {
    const pass = reap({ kill: true, roots: roots.kill, prefix: socketNames.empty });
    await settle();
    assert.ok(!socketAnswers(socketNames.empty), `it survived --kill\n${pass.output}`);
  });
});

void describe("what --kill must never touch", () => {
  // The safety property the whole tool rests on. Without the root test, ppid 1 and no terminal
  // describe every launchd daemon on the machine.
  void test("an orphan working outside every root", async () => {
    const pass = reap({ kill: true, roots: roots.report });
    await settle();
    assert.ok(
      alive(pids.outside),
      `pid ${String(pids.outside)} was outside the root given and was reaped\n${pass.output}`,
    );
  });

  // Measured on a real machine: `pnpm dev`, 17 hours old, ppid 1 because its terminal had closed,
  // with the listeners two levels below it. Every other condition called it garbage.
  void test("an orphan whose tree holds a listening socket", async () => {
    assert.ok(listens(pids.listening), "the fixture never listened, so this case proves nothing");
    const pass = reap({ kill: true, roots: roots.listening });
    await settle();
    assert.ok(alive(pids.listening), `a listening tree was reaped\n${pass.output}`);
  });

  void test("a tmux server that still holds a session", async () => {
    const pass = reap({ kill: true, roots: roots.kill, prefix: socketNames.busy });
    await settle();
    assert.ok(
      socketAnswers(socketNames.busy),
      `a server holding a session was reaped\n${pass.output}`,
    );
  });

  void test("the live deck's own socket, even holding nothing", async () => {
    const pass = reap({
      kill: true,
      roots: roots.kill,
      prefix: socketNames.live,
      liveSocket: socketNames.live,
    });
    await settle();
    assert.ok(
      socketAnswers(socketNames.live),
      `the configured TMUX_SOCKET was reaped\n${pass.output}`,
    );
  });

  void test("an orphan younger than the age bound", async () => {
    // Created here rather than in `before`: this one has to be YOUNG, which is the opposite of what
    // the shared setup arranges for.
    const pid = orphan(roots.young, "exec /bin/sleep 100000");
    const pass = reap({ kill: true, roots: roots.young, minAgeMs: "3600000" });
    await settle();
    assert.ok(
      alive(pid),
      `a process seconds old was reaped under a one-hour bound\n${pass.output}`,
    );
  });

  void test("a process with a living parent, however idle", () => {
    assert.ok(pids.parented > 1, "the fixture did not start");
    const pass = reap({ kill: true, roots: roots.parented });
    // It must not even be named: the report is what `--kill` acts on.
    assert.doesNotMatch(pass.output, new RegExp(`pid ${String(pids.parented)}\\b`), pass.output);
    assert.ok(alive(pids.parented), "a process with a living parent was reaped");
  });
});

/** SIGTERM then SIGKILL lands a moment after the pass returns, so every case reads state after it. */
const settle = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 300);
  });
