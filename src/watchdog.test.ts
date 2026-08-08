// m4/launchd-watchdog, executed rather than asserted about.
//
// This is the first thing in the repository that supervises the node process, and it is the
// answer to m0/supervisor-crash-test - which measured, and still measures, what an unattended
// crash looks like with nothing watching: tmux keeps every agent, nothing answers the port, and
// a person has to open a terminal. The tests below run `scripts/watchdog.mjs` as launchd would,
// one pass at a time, against a REAL server and a REAL tmux socket, and assert that the person
// is no longer required.
//
// WHAT THESE TESTS DO NOT COVER, said plainly rather than implied by absence: launchd. The
// LaunchAgent in scripts/com.agentdeck.watchdog.plist is deliberately NOT installed on this
// machine, so the plist being loaded, the 60s timer firing, RunAtLoad, and recovery after a
// reboot are all UNDEMONSTRATED. What is demonstrated is every decision the script makes when
// something runs it. `plutil -lint` on the plist is the only claim made about the plist itself.
//
// The third case is the one a naive watchdog gets wrong. /api/health does a hard-timed
// `tmux list-sessions` round trip, so a busy machine, a big capture or a wedged tmux can make a
// perfectly healthy server slow. Restarting it destroys no work - tmux is a daemon of its own -
// but it drops every phone's socket and every tab's snapshot, and a watchdog that does that on
// load spikes is worse than no watchdog. So "answered slowly" and "did not answer" are separated
// here, and the slow server gets three passes to prove it is never touched.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createSocketServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const watchdog = join(repoRoot, "scripts", "watchdog.mjs");
const plist = join(repoRoot, "scripts", "com.agentdeck.watchdog.plist");

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const socket = `agentdeck-watchdog-${String(process.pid)}`;
const home = temp("agentdeck-watchdog-home-");
const work = temp("agentdeck-watchdog-work-");
const conf = temp("agentdeck-watchdog-conf-");
const stubs = temp("agentdeck-watchdog-stubs-");

const statePath = join(conf, "state.json");
const profiles = join(conf, "agents.json");

// Each suite gets its OWN transcript of what the watchdog told the user. One shared file was not
// enough: the give-up alert is spawned detached on purpose, so it can land after the pass that
// sent it has exited, and a later suite would then read somebody else's notification as its own.
let notifications = "";

writeFileSync(
  profiles,
  JSON.stringify({ shell: { command: "/bin/sh", args: ["-c", "exec sleep 100000"] } }),
);

// The notifier, captured. `osascript` is what the watchdog uses to tell a person what it did -
// there is no push (m5/push is unbuilt) and the dependency budget is spent - so the assertion
// that a person is told is an assertion about this file's contents.
writeFileSync(
  join(stubs, "osascript"),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> "$AGENTDECK_TEST_NOTIFY"\nexit 0\n`,
);
chmodSync(join(stubs, "osascript"), 0o755);

interface State {
  failures: number;
  restarts: number;
  gaveUp: boolean;
  pid: number | null;
  serveConfigured: boolean;
}

const state = (): State => JSON.parse(readFileSync(statePath, "utf8")) as State;

const notified = (): string =>
  existsSync(notifications) ? readFileSync(notifications, "utf8") : "";

/**
 * The transcript, once it matches. The critical alert is deliberately detached - a dialog nobody
 * dismisses must not hold a pass open - so it is written asynchronously and has to be waited for
 * rather than read once.
 */
const notifiedEventually = async (pattern: RegExp): Promise<string> => {
  for (let i = 0; i < 100; i++) {
    const seen = notified();
    if (pattern.test(seen)) return seen;
    await new Promise((r) => setTimeout(r, 50));
  }
  return notified();
};

/** A suite's own transcript, empty and named. */
const freshTranscript = (name: string): void => {
  notifications = join(conf, `${name}-notify.txt`);
  rmSync(notifications, { force: true });
};

/** One launchd tick, run synchronously so a test can reason about passes in order. */
const pass = (port: string): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [watchdog], {
    encoding: "utf8",
    env: {
      // Stubs first so `osascript` is the recorder; the rest of PATH is real, because `tailscale`
      // and the node the watchdog spawns are real.
      PATH: `${stubs}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: home,
      AGENTDECK_PORT: port,
      TMUX_SOCKET: socket,
      AGENTDECK_MOUNTS: work,
      AGENTDECK_PROFILES: profiles,
      AGENTDECK_WATCHDOG_STATE: statePath,
      AGENTDECK_TEST_NOTIFY: notifications,
      // No LANG and no LC_*: the environment launchd actually hands the job (m0/create-500).
    },
  });

/** `<session id> <pane pid>` for everything on our socket - survival at pid level, not by name. */
const panes = (): string[] => {
  try {
    return execFileSync(
      "tmux",
      ["-L", socket, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return [];
  }
};

// Every port this file ever hands out, because the watchdog's whole job is to start a detached
// server on a port nobody is answering - so any port used here can end a test with a server on
// it that is not a child of this process. The teardown sweeps all of them.
const usedPorts: string[] = [];

const freePort = async (): Promise<string> => {
  const found = await new Promise<string>((resolve) => {
    const probe = createSocketServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => {
        resolve(String(port));
      });
    });
  });
  usedPorts.push(found);
  return found;
};

const waitForHealth = async (port: string): Promise<boolean> => {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const listenerPid = (port: string): number | null => {
  const out = spawnSync("/usr/sbin/lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  const pid = Number(out.stdout.trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const api = async (port: string, path: string, init: RequestInit = {}): Promise<Response> => {
  const token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
};

let serverPort = "";
let sessionId = "";
let paneLine = "";

before(async () => {
  serverPort = await freePort();
  freshTranscript("recovery");
});

/** SIGKILL whatever is listening on a port, if anything is. */
const killListener = (port: string): void => {
  const pid = listenerPid(port);
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

// Nothing is left running or installed. Every server these tests started is one the WATCHDOG
// started and detached, so it is not a child of this process and has to be found by port.
after(() => {
  for (const port of usedPorts) killListener(port);
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Already gone is the desired end state.
  }
  for (const dir of [home, work, conf, stubs]) rmSync(dir, { recursive: true, force: true });
});

void describe("a killed node process is recovered, and the tmux sessions are not", () => {
  void test("nothing listening: the watchdog starts the server on the first pass", async () => {
    // `refused` skips the consecutive-failure streak entirely. There is no socket to drop and no
    // snapshot to lose when nothing is running, so patience buys nothing and costs a minute of
    // being unreachable.
    const first = pass(serverPort);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /nothing is listening/);
    assert.match(first.stdout, /started the server/);
    assert.ok(await waitForHealth(serverPort), `the server never became healthy\n${first.stdout}`);
    assert.equal(state().restarts, 1);
    assert.match(notified(), /Started the agentdeck server/);
    assert.match(notified(), /KEPT/, "the notification does not say the sessions were kept");
  });

  void test("a healthy pass resets the counters and says nothing to anybody", () => {
    const before = notified();
    const healthy = pass(serverPort);
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.match(healthy.stdout, /answered 200/);
    assert.equal(state().restarts, 0, "a healthy pass did not reset the recovery counter");
    assert.equal(notified(), before, "a healthy pass notified somebody");
  });

  void test("SIGKILL of the server: the watchdog restarts it and the sessions are untouched", async () => {
    const created = await api(serverPort, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: work, agent: "shell" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    sessionId = ((await created.json()) as { session: { id: string } }).session.id;
    paneLine = panes().find((line) => line.startsWith(`${sessionId} `)) ?? "";
    assert.notEqual(paneLine, "", "tmux has no pane for the session it just created");

    const victim = listenerPid(serverPort);
    assert.notEqual(victim, null);
    process.kill(victim as number, "SIGKILL");
    await assert.rejects(async () => await fetch(`http://127.0.0.1:${serverPort}/api/health`));

    const recovery = pass(serverPort);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.match(recovery.stdout, /nothing is listening/);
    assert.match(recovery.stdout, /started the server/);
    assert.ok(await waitForHealth(serverPort), "the watchdog did not bring the server back");

    // The property src/supervisor-crash.test.ts measures, now measured after an AUTOMATIC
    // recovery: same session id and same pane pid, so it is the original process still running.
    assert.ok(
      panes().includes(paneLine),
      `the recovery disturbed the session; tmux holds ${panes().join(", ")}`,
    );

    // And the restarted server adopted it, so the phone gets the session back rather than a
    // machine that looks empty.
    const body = (await (await api(serverPort, "/api/sessions")).json()) as {
      sessions: { id: string }[];
    };
    assert.deepEqual(
      body.sessions.map((s) => s.id),
      [sessionId],
    );

    // The wording is "Started", not "Restarted", and that is the honest sentence: after a
    // SIGKILL nothing is listening, so there was nothing to stop. It still has to say the
    // sessions were kept, because that is the fact the person reading it needs.
    const seen = await notifiedEventually(/Started the agentdeck server/);
    assert.match(seen, /nothing was listening/);
    assert.match(seen, /KEPT and have been adopted/);
  });
});

void describe("a slow-but-alive server is not restarted", () => {
  // The clause a naive check gets wrong. This server answers 200 with `ok: true` after six
  // seconds - twice what /api/health gives its own tmux round trip and twice what
  // scripts/healthcheck.mjs allows, so every simpler check on this machine calls it dead.
  //
  // A CHILD PROCESS, like the wedged one below and for a second reason as well as the lsof one:
  // each pass is run with `spawnSync`, which blocks this process's event loop, so a slow server
  // living in the test runner could never answer at all and would be indistinguishable from the
  // wedge it is here to be told apart from. It records each request in a file, because that is
  // the only channel left.
  const DELAY_MS = 6_000;
  let slow: ReturnType<typeof spawn>;
  let port = "";
  let requests = "";

  before(async () => {
    port = await freePort();
    freshTranscript("slow");
    requests = join(conf, "slow-requests.txt");
    slow = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");` +
          `require("node:http").createServer((req, res) => {` +
          `fs.appendFileSync(${JSON.stringify(requests)}, "r");` +
          `setTimeout(() => { res.writeHead(200, {"content-type": "application/json"});` +
          `res.end(JSON.stringify({ ok: true, version: "slow" })); }, ${String(DELAY_MS)});` +
          `}).listen(${port}, "127.0.0.1");`,
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 80 && listenerPid(port) === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual(listenerPid(port), null, "the slow server never came up");
    rmSync(statePath, { force: true });
  });

  after(() => {
    slow.kill("SIGKILL");
  });

  void test("three consecutive slow passes restart nothing and notify nobody", () => {
    const held = listenerPid(port);
    for (let i = 0; i < 3; i++) {
      const outcome = pass(port);
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.match(outcome.stdout, /answered 200 SLOWLY/, "a slow 200 was not read as alive");
      assert.doesNotMatch(outcome.stdout, /started the server/);
      assert.equal(state().failures, 0, "a slow answer counted as a failure");
      assert.equal(state().restarts, 0, "a slow-but-alive server was restarted");
    }
    assert.equal(
      readFileSync(requests, "utf8").length,
      3,
      "the watchdog did not probe on every pass",
    );
    assert.equal(listenerPid(port), held, "the process holding the port changed");
    assert.equal(notified(), "", "a slow-but-alive server produced a notification");
  });
});

void describe("a wedged server needs three consecutive failures, then is restarted", () => {
  // Accepted and never answered: the failure the timeout exists for, and the state a wedged tmux
  // with no execFile timeout on it (audit.md) puts the server into. A single miss is not enough,
  // because a single miss is what a load spike looks like from outside.
  //
  // It runs as a CHILD PROCESS rather than a server in this process, and that is not a detail:
  // the watchdog finds what to stop with `lsof` on the port, so an in-process listener would
  // have it SIGTERM the test runner.
  let wedged: ReturnType<typeof spawn>;
  let port = "";

  before(async () => {
    port = await freePort();
    freshTranscript("wedged");
    wedged = spawn(
      process.execPath,
      [
        "-e",
        `const held = [];` +
          `require("node:net").createServer(s => held.push(s)).listen(${port}, "127.0.0.1");`,
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 80 && listenerPid(port) === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual(listenerPid(port), null, "the wedged listener never came up");
    rmSync(statePath, { force: true });
  });

  after(() => {
    wedged.kill("SIGKILL");
    killListener(port);
  });

  void test("the first two passes see the wedge, say so, and do nothing", () => {
    for (const expected of [1, 2]) {
      const outcome = pass(port);
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.match(outcome.stdout, /did not answer within 15000ms - wedged/);
      assert.match(outcome.stdout, /not restarting yet/);
      assert.equal(state().failures, expected);
      assert.equal(state().restarts, 0);
    }
    assert.equal(notified(), "", "the watchdog notified before it acted");
  });

  void test("the third consecutive failure restarts it", () => {
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /stopping \d+/, "the wedged process was not stopped");
    assert.match(outcome.stdout, /started the server/);
    assert.equal(state().restarts, 1);
    assert.equal(state().failures, 0, "the streak was not reset by acting on it");
    assert.match(notified(), /Restarted the agentdeck server/);
  });
});

void describe("it stops and notifies rather than crash-looping", () => {
  let port = "";

  before(async () => {
    // A port with nothing on it and nothing that can be started on it usefully: the state file
    // is seeded with two recoveries already spent, which is where a genuine crash-loop arrives
    // after two failed restarts.
    port = await freePort();
    freshTranscript("gave-up");
    writeFileSync(
      statePath,
      JSON.stringify({
        failures: 2,
        restarts: 2,
        gaveUp: false,
        pid: null,
        serveConfigured: false,
      }),
    );
  });

  void test("after two restarts that did not help it gives up, loudly and once", async () => {
    const giving = pass(port);
    assert.equal(giving.status, 1, "giving up exited 0, so launchd would see success");
    assert.match(giving.stdout, /giving up after 2 restarts/);
    assert.doesNotMatch(giving.stdout, /started the server/, "it restarted after giving up");
    assert.equal(state().gaveUp, true);

    // `display alert` rather than `display notification`: the server is down and nothing
    // automatic will bring it back, so a banner that scrolls away is not enough.
    const seen = await notifiedEventually(/display alert/);
    assert.match(seen, /display alert/);
    assert.match(seen, /STOPPED restarting/);
    assert.match(seen, /untouched and still running/, "it does not say the sessions are safe");

    // And the next pass is quiet. Re-alerting every 60s is the crash-loop in another medium.
    const after = pass(port);
    assert.equal(after.status, 1);
    assert.match(after.stdout, /gave up after 2 restarts; not acting/);
    assert.doesNotMatch(after.stdout, /started the server/);
    assert.equal(notified(), seen, "it alerted again on the next pass");
  });
});

void describe("tailscale serve: not configured is not an outage", () => {
  // The watchdog is specified to check it (plan 006) and does. It cannot pass today -
  // m4/tailscale-serve is blocked on two admin-console switches - so the check has to tell
  // "never configured" apart from "was configured and is gone", and only the second is worth
  // waking anyone for. Both branches are driven with a stub `tailscale` on PATH, because the
  // real one on this Mac can only produce the first.
  //
  // The passes run against a stub that answers /api/health healthily and at once, so that the
  // serve check is the only thing being read - and so that no pass here has a reason to start a
  // server, which would leave one running on the machine after the file finished.
  let port = "";
  let healthy: ReturnType<typeof spawn>;

  const stubTailscale = (output: string, code: number): void => {
    writeFileSync(
      join(stubs, "tailscale"),
      `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\nexit ${String(code)}\n`,
    );
    chmodSync(join(stubs, "tailscale"), 0o755);
  };

  before(async () => {
    port = await freePort();
    freshTranscript("tailscale");
    healthy = spawn(
      process.execPath,
      [
        "-e",
        `require("node:http").createServer((req, res) => {` +
          `res.writeHead(200, {"content-type": "application/json"});` +
          `res.end(JSON.stringify({ ok: true, version: "stub" }));` +
          `}).listen(${port}, "127.0.0.1");`,
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 80 && listenerPid(port) === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual(listenerPid(port), null, "the stub health server never came up");
  });

  after(() => {
    healthy.kill("SIGKILL");
    rmSync(join(stubs, "tailscale"), { force: true });
  });

  void test("never configured: reported, not alarming, and not a failure of the pass", () => {
    stubTailscale("no serve config", 0);
    writeFileSync(
      statePath,
      JSON.stringify({
        failures: 0,
        restarts: 0,
        gaveUp: false,
        pid: null,
        serveConfigured: false,
      }),
    );
    const outcome = pass(port);
    assert.match(outcome.stdout, /tailscale serve is not configured for the port/);
    assert.match(outcome.stdout, /m4\/tailscale-serve is not built yet/);
    assert.doesNotMatch(notified(), /tailscale/, "an unbuilt milestone woke somebody");
  });

  void test("was configured and is gone: that one is a notification", () => {
    stubTailscale("no serve config", 0);
    writeFileSync(
      statePath,
      JSON.stringify({ failures: 0, restarts: 0, gaveUp: false, pid: null, serveConfigured: true }),
    );
    const outcome = pass(port);
    assert.match(outcome.stdout, /WAS configured for the port and is not any more/);
    assert.match(notified(), /tailscale serve is no longer configured/);
    assert.match(notified(), /Sessions are untouched/);
    assert.equal(state().serveConfigured, false);
  });

  void test("configured for this port is recognised in the output tailscale actually prints", () => {
    stubTailscale(
      `https://mac.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:${port}`,
      0,
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        failures: 0,
        restarts: 0,
        gaveUp: false,
        pid: null,
        serveConfigured: false,
      }),
    );
    const outcome = pass(port);
    assert.match(outcome.stdout, /tailscale serve is configured for the port/);
    assert.equal(state().serveConfigured, true);
  });
});

void describe("the LaunchAgent exists, is valid, and is NOT installed", () => {
  void test("plutil accepts the plist and it declares RunAtLoad and a 60s interval", () => {
    const lint = spawnSync("plutil", ["-lint", plist], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const text = readFileSync(plist, "utf8");
    assert.match(text, /<key>Label<\/key>\s*<string>com\.agentdeck\.watchdog<\/string>/);
    assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(text, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    // launchd expands nothing, so a relative path or a `~` here is a job that silently never
    // runs. Both script paths and the node binary are absolute.
    assert.match(text, /<string>\/Users\/[^<]*\/scripts\/watchdog\.mjs<\/string>/);
    assert.doesNotMatch(text, /<string>~/);
  });

  void test("nothing loaded it: this repository installs no LaunchAgent", () => {
    // The hard constraint on this item. The operator installs it; an agent does not. If this
    // fails, something has been left behind that survives a reboot.
    const installed = join(process.env["HOME"] ?? "", "Library", "LaunchAgents");
    assert.equal(
      existsSync(join(installed, "com.agentdeck.watchdog.plist")),
      false,
      "a LaunchAgent was installed into ~/Library/LaunchAgents",
    );
    const listed = spawnSync("launchctl", ["list", "com.agentdeck.watchdog"], { encoding: "utf8" });
    assert.notEqual(listed.status, 0, "com.agentdeck.watchdog is loaded in launchd");
  });

  void test("the README writes down the exact launchctl commands the operator runs", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    assert.match(readme, /launchctl bootstrap gui\//);
    assert.match(readme, /launchctl bootout gui\//);
    assert.match(readme, /com\.agentdeck\.watchdog/);
  });
});

// The spawned server is detached from this process on purpose - it has to outlive the pass that
// started it - so this file is the only thing that will clean it up. Belt and braces alongside
// `after`: a crashed test run must not leave a server or a tmux socket behind.
process.on("exit", () => {
  for (const port of usedPorts) killListener(port);
});
