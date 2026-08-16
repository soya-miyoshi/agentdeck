// Each case builds the real shape on the real process table, because a reaper that reads correctly and
// signals the wrong pid is the whole failure mode. Scoped twice per CASE, so no `--kill` escapes.

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

/**
 * Whether a pid is still running, counting a zombie as not: `kill(pid, 0)` succeeds against one, and
 * the pane cases create them on purpose - so a plain signal test called a reaped process a survivor.
 */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return !state.stdout.trim().startsWith("Z");
};

const isOrphan = (pid: number): boolean => {
  const ppid = spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  return Number((ppid.stdout || "0").trim()) === 1;
};

/**
 * A process with ppid 1 and no controlling terminal, which is the shape a leftover has. Double-forked
 * on purpose: a child of this runner has a living parent, so the reaper would rightly spare it.
 */
const orphan = (cwd: string, command: string): number => {
  // Two load-bearing details: the redirection, or `execFileSync` waits on an inherited pipe forever;
  // and no brace group, so `exec` replaces the subshell and `$!` is the surviving pid.
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
    // Chained into ONE command, as tmux.ts does and for the same reason: with `exit-empty` on, a
    // server holding no sessions exits before a second invocation reaches it.
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
  spareListeners?: boolean;
  paneChildren?: boolean;
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
        AGENTDECK_REAP_SPARE_LISTENERS: options.spareListeners === true ? "1" : "0",
        // Off unless a case asks for it: most cases have no live socket to look at, and leaving it
        // on would make each of them shell out to tmux for nothing.
        AGENTDECK_REAP_PANE_CHILDREN: options.paneChildren === true ? "1" : "0",
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
  listenReaped: "",
  young: "",
  parented: "",
};
const pids = { report: 0, kill: 0, outside: 0, listening: 0, listenReaped: 0, parented: 0 };
const socketNames = {
  empty: `${base}empty-sock`,
  busy: `${base}busy-sock`,
  live: `${base}live-sock`,
  pane: `${base}pane-sock`,
  keep: `${base}keep-sock`,
};
// The pane process and the one thing it started, on a socket this file treats as the live deck's.
const pane = { pid: 0, child: 0 };
// A second pane holding one ordinary leftover and one that LOOKS like an MCP server, so the timed
// pass can be shown to take the first and leave the second.
const keep = { pid: 0, plain: 0, mcp: 0 };

/**
 * A pane holding one ordinary leftover and one whose argv says "mcp" - a real argv entry, since that
 * is what the reaper matches. NOT a renamed `/bin/sleep`: macOS kills a copied system binary.
 */
const keepSession = (socket: string): void => {
  sockets.push(socket);
  const idle = `${process.execPath} -e "setInterval(()=>{},1e9)"`;
  execFileSync(
    "tmux",
    [
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      "work",
      "/bin/sh",
      "-c",
      `/bin/sleep 100000 & ${idle} playwright-mcp & exec /bin/sleep 200000`,
    ],
    { stdio: "ignore" },
  );
  keep.pid = Number(
    execFileSync("tmux", ["-L", socket, "list-panes", "-a", "-F", "#{pane_pid}"], {
      encoding: "utf8",
    }).trim(),
  );
  for (let i = 0; i < 100 && (keep.plain === 0 || keep.mcp === 0); i += 1) {
    const kids = spawnSync("/usr/bin/pgrep", ["-P", String(keep.pid)], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => pid > 1);
    for (const pid of kids) {
      const cmd = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout;
      if (cmd.includes("playwright-mcp")) keep.mcp = pid;
      else keep.plain = pid;
    }
    if (keep.plain === 0 || keep.mcp === 0) spawnSync("/bin/sleep", ["0.05"]);
  }
};

/** A session whose pane process has a child, which is the shape an agent with an MCP server has. */
const paneSession = (socket: string): void => {
  sockets.push(socket);
  execFileSync(
    "tmux",
    // `exec` after backgrounding rather than `wait`: with `wait` the shell returns when its child is
    // killed and the pane exits itself, which reads as the reaper having killed the pane.
    [
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      "work",
      "/bin/sh",
      "-c",
      "/bin/sleep 100000 & exec /bin/sleep 200000",
    ],
    { stdio: "ignore" },
  );
  pane.pid = Number(
    execFileSync("tmux", ["-L", socket, "list-panes", "-a", "-F", "#{pane_pid}"], {
      encoding: "utf8",
    }).trim(),
  );
  for (let i = 0; i < 100 && pane.child === 0; i += 1) {
    const kid = spawnSync("/usr/bin/pgrep", ["-P", String(pane.pid)], { encoding: "utf8" });
    pane.child = Number(kid.stdout.trim().split("\n")[0] ?? 0);
    if (pane.child === 0) spawnSync("/bin/sleep", ["0.05"]);
  }
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

  pids.listenReaped = orphan(
    roots.listenReaped,
    `exec ${process.execPath} -e "require('node:net').createServer().listen(0,'127.0.0.1');setInterval(()=>{},1e9)"`,
  );

  tmuxServer(socketNames.empty, false);
  tmuxServer(socketNames.busy, true);
  tmuxServer(socketNames.live, false);
  paneSession(socketNames.pane);
  keepSession(socketNames.keep);
  // AFTER the fixture runs: pushed early these are still 0, and `process.kill(0, ...)` signals this
  // runner's whole process group - which killed the suite with every case passed and no summary.
  strays.push(keep.pid, keep.plain, keep.mcp);

  // The listeners have to exist before any pass, or neither listener case proves anything.
  for (let i = 0; i < 100 && !listens(pids.listening); i += 1) spawnSync("/bin/sleep", ["0.05"]);
  for (let i = 0; i < 100 && !listens(pids.listenReaped); i += 1) spawnSync("/bin/sleep", ["0.05"]);
  // The one age wait for the whole file. See the header.
  spawnSync("/bin/sleep", ["1.2"]);
});

after(() => {
  for (const pid of strays) {
    // `pid > 1` for the same reason scripts/reap.mjs checks it: 0 signals this process group and
    // -1 every process this user owns.
    if (!Number.isInteger(pid) || pid <= 1) continue;
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

  // The default the operator chose, and the reverse of the case below it. A dev server left running
  // is not something they want kept alive, so a listening tree is ordinary garbage now.
  void test("a listening tree, because sparing them is no longer the default", async () => {
    assert.ok(listens(pids.listenReaped), "the fixture never listened, so this proves nothing");
    const pass = reap({ kill: true, roots: roots.listenReaped });
    await settle();
    assert.ok(!alive(pids.listenReaped), `a listening tree was spared by default\n${pass.output}`);
  });

  // The class that takes processes nobody abandoned - what a LIVE agent started - with the agent
  // itself coming through alive. The timed pass spares MCP servers; closing a session does not.
  void test("an ordinary leftover in a live pane, but NOT the one that looks like an MCP server", async () => {
    assert.ok(keep.plain > 1 && keep.mcp > 1, "the keep fixture did not produce both children");
    const pass = reap({
      kill: true,
      roots: roots.kill,
      liveSocket: socketNames.keep,
      paneChildren: true,
    });
    await settle();
    assert.ok(!alive(keep.plain), `the ordinary leftover survived\n${pass.output}`);
    assert.ok(alive(keep.mcp), `the MCP server was reaped by the timed pass\n${pass.output}`);
    // Reported rather than silently skipped: a pass that says nothing about what it spared cannot
    // be told from one that never looked.
    assert.match(pass.output, /kept\s+\d+/, pass.output);
  });

  void test("what a live pane started, while leaving the pane itself alone", async () => {
    assert.ok(pane.pid > 1 && pane.child > 1, "the pane fixture did not start");
    const pass = reap({
      kill: true,
      roots: roots.kill,
      liveSocket: socketNames.pane,
      paneChildren: true,
    });
    await settle();
    assert.ok(!alive(pane.child), `the pane's child survived\n${pass.output}`);
    assert.ok(alive(pane.pid), `the PANE was reaped, which ends the session\n${pass.output}`);
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

  // Measured on a real machine: a 17-hour `pnpm dev`, ppid 1 because its terminal closed, listeners
  // two levels down. The exemption that spares it is off by default, so this asks for it.
  void test("an orphan whose tree holds a listening socket, when asked to spare them", async () => {
    assert.ok(listens(pids.listening), "the fixture never listened, so this case proves nothing");
    const pass = reap({ kill: true, roots: roots.listening, spareListeners: true });
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
