// m4/launchd-watchdog, executed rather than asserted about: each test runs one pass of
// scripts/watchdog.mjs as launchd would, against a real server and a real tmux socket.
//
// launchd itself is NOT covered - the LaunchAgent is deliberately not installed on this machine,
// so the timer, RunAtLoad and reboot recovery are undemonstrated. Why each decision below is the
// decision it is, and what this cannot see, are in audit.md's m4/launchd-watchdog entry.

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
  statSync,
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
// Where the SERVER the watchdog starts writes its output - a different file from the watchdog's
// own lines, which under launchd go to StandardOutPath.
const serverLog = join(conf, "server.log");

// Each suite gets its OWN transcript: the give-up alert is detached on purpose, so it can land
// after the pass that sent it exited and a later suite would read it as its own.
let notifications = "";

writeFileSync(
  profiles,
  JSON.stringify({ shell: { command: "/bin/sh", args: ["-c", "exec sleep 100000"] } }),
);

const sleep = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** An executable on the stub PATH, which is ahead of the real one for every pass. */
const putStub = (name: string, script: string): void => {
  writeFileSync(join(stubs, name), script);
  chmodSync(join(stubs, name), 0o755);
};

// The notifier, captured. `osascript` is the only way the watchdog tells a person anything, so
// "a person is told" is an assertion about this file's contents.
const RECORDING_NOTIFIER = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$AGENTDECK_TEST_NOTIFY"\nexit 0\n`;
putStub("osascript", RECORDING_NOTIFIER);

interface State {
  failures: number;
  restarts: number;
  gaveUp: boolean;
  pid: number | null;
  serveConfigured: boolean;
  startRefused: boolean;
}

const state = (): State => JSON.parse(readFileSync(statePath, "utf8")) as State;

/** The state a pass starts from, so a test says only the fields it is actually about. */
const seedState = (overrides: Partial<State> = {}): void => {
  const seeded: State = {
    failures: 0,
    restarts: 0,
    gaveUp: false,
    pid: null,
    serveConfigured: false,
    startRefused: false,
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(seeded));
};

const notified = (): string =>
  existsSync(notifications) ? readFileSync(notifications, "utf8") : "";

/** What the SERVER the watchdog started printed, which is a different file from the above. */
const logged = (): string => (existsSync(serverLog) ? readFileSync(serverLog, "utf8") : "");

/** Signal 0: does this pid exist. Only ever called here with a pid this file spawned. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The transcript, once it matches. The critical alert is detached, so it lands asynchronously
 *  and has to be waited for rather than read once. */
const notifiedEventually = async (pattern: RegExp): Promise<string> => {
  for (let i = 0; i < 100; i++) {
    const seen = notified();
    if (pattern.test(seen)) return seen;
    await sleep(50);
  }
  return notified();
};

/** A suite's own transcript, empty and named. */
const freshTranscript = (name: string): void => {
  notifications = join(conf, `${name}-notify.txt`);
  rmSync(notifications, { force: true });
};

/** One launchd tick, run synchronously so a test can reason about passes in order. `undefined` in
 *  `overrides` REMOVES a variable, which is what the environment tests are about. */
const pass = (
  port: string,
  overrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> => {
  const env: Record<string, string> = {
    // Stubs first so `osascript` is the recorder; the rest of PATH is real, because `tailscale`
    // and the node the watchdog spawns are real.
    PATH: `${stubs}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: home,
    AGENTDECK_PORT: port,
    TMUX_SOCKET: socket,
    AGENTDECK_MOUNTS: work,
    AGENTDECK_PROFILES: profiles,
    AGENTDECK_ORIGIN: "https://stub.example.ts.net",
    AGENTDECK_WATCHDOG_STATE: statePath,
    AGENTDECK_SERVER_LOG: serverLog,
    AGENTDECK_TEST_NOTIFY: notifications,
    // No LANG and no LC_*: the environment launchd actually hands the job (m0/create-500).
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return spawnSync(process.execPath, [watchdog], { encoding: "utf8", env });
};

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

// Every port this file hands out. The watchdog starts DETACHED servers, so a port used here can
// end a test with a server on it that is not a child of this process; the teardown sweeps all.
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
    await sleep(250);
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

/** A stand-in for the server, as a CHILD PROCESS: the watchdog stops what `lsof` reports on the
 *  port, so an in-process listener would have it SIGTERM the test runner. */
const startStub = async (
  what: string,
  port: string,
  source: string,
): Promise<ReturnType<typeof spawn>> => {
  const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  for (let i = 0; i < 80 && listenerPid(port) === null; i++) await sleep(50);
  assert.notEqual(listenerPid(port), null, `the ${what} never came up`);
  return child;
};

/** Answers /api/health healthily and at once, so the pass turns on whatever else is under test. */
const healthyStub = (port: string): string =>
  `require("node:http").createServer((req, res) => {` +
  `res.writeHead(200, {"content-type": "application/json"});` +
  `res.end(JSON.stringify({ ok: true, version: "stub" }));` +
  `}).listen(${port}, "127.0.0.1");`;

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
  // The clause a naive check gets wrong: 200 with `ok: true` after six seconds, which every
  // simpler check on this machine calls dead (audit.md). Requests go to a file because the stub
  // is a child process.
  const DELAY_MS = 6_000;
  let slow: ReturnType<typeof spawn>;
  let port = "";
  let requests = "";

  before(async () => {
    port = await freePort();
    freshTranscript("slow");
    requests = join(conf, "slow-requests.txt");
    slow = await startStub(
      "slow server",
      port,
      `const fs = require("node:fs");` +
        `require("node:http").createServer((req, res) => {` +
        `fs.appendFileSync(${JSON.stringify(requests)}, "r");` +
        `setTimeout(() => { res.writeHead(200, {"content-type": "application/json"});` +
        `res.end(JSON.stringify({ ok: true, version: "slow" })); }, ${String(DELAY_MS)});` +
        `}).listen(${port}, "127.0.0.1");`,
    );
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
  let wedged: ReturnType<typeof spawn>;
  let port = "";

  before(async () => {
    port = await freePort();
    freshTranscript("wedged");
    wedged = await startStub(
      "wedged listener",
      port,
      `const held = [];` +
        `require("node:net").createServer(s => held.push(s)).listen(${port}, "127.0.0.1");`,
    );
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
    seedState({ failures: 2, restarts: 2 });
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
  // "Never configured" is an unbuilt milestone, "was configured and is gone" is the reboot case
  // (plan 006); a stub `tailscale` drives both, because the real one can only produce the first.
  // The healthy stub keeps any pass here from having a reason to start a real server.
  let port = "";
  let healthy: ReturnType<typeof spawn>;

  const stubTailscale = (output: string, code: number): void => {
    putStub("tailscale", `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\nexit ${String(code)}\n`);
  };

  before(async () => {
    port = await freePort();
    freshTranscript("tailscale");
    healthy = await startStub("stub health server", port, healthyStub(port));
  });

  after(() => {
    healthy.kill("SIGKILL");
    rmSync(join(stubs, "tailscale"), { force: true });
  });

  void test("never configured: reported, not alarming, and not a failure of the pass", () => {
    stubTailscale("no serve config", 0);
    seedState();
    const outcome = pass(port);
    assert.match(outcome.stdout, /tailscale serve is not configured for the port/);
    assert.match(outcome.stdout, /m4\/tailscale-serve is not built yet/);
    assert.doesNotMatch(notified(), /tailscale/, "an unbuilt milestone woke somebody");
  });

  void test("was configured and is gone: that one is a notification", () => {
    stubTailscale("no serve config", 0);
    seedState({ serveConfigured: true });
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
    seedState();
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

  void test("no KeepAlive: launchd must not relaunch the passes that exit non-zero on purpose", () => {
    // Giving up and refusing to start a misconfigured server both `exit(1)`. Under KeepAlive
    // launchd relaunches each of them every ThrottleInterval, which reinstates the crash-loop the
    // give-up exists to prevent, one layer below where it can see it.
    assert.doesNotMatch(readFileSync(plist, "utf8"), /<key>KeepAlive<\/key>/);
  });

  void test("PATH puts the system directories ahead of every user-writable one", () => {
    // `osascript` and `tailscale` are resolved on this PATH. The mise node directory and
    // /opt/homebrew/bin are writable by this user, which is who an agent in a session runs as, so
    // ahead of /usr/bin either is a file an agent drops and a timer executes as the operator.
    const text = readFileSync(plist, "utf8");
    const path = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
    assert.ok(path, "the plist declares no PATH, so launchd gives the job its own minimal one");
    const dirs = path.split(":");
    assert.deepEqual(dirs.slice(0, 4), ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
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

void describe("an answer that is not a healthy one", () => {
  // The fourth outcome: answered, but the server saying itself that it cannot do its job. It
  // takes the same streak as a wedge (audit.md). Two passes only - a third would restart and
  // leave a real detached server on the stub's port.
  let stub: ReturnType<typeof spawn>;
  let port = "";
  let mode = "";

  before(async () => {
    port = await freePort();
    freshTranscript("unhealthy");
    mode = join(conf, "unhealthy-mode.txt");
    writeFileSync(mode, "503");
    stub = await startStub(
      "unhealthy stub",
      port,
      `const fs = require("node:fs");` +
        `require("node:http").createServer((req, res) => {` +
        `const mode = fs.readFileSync(${JSON.stringify(mode)}, "utf8").trim();` +
        `const status = mode === "503" ? 503 : 200;` +
        `res.writeHead(status, {"content-type": "application/json"});` +
        `res.end(JSON.stringify({ ok: mode === "healthy", version: "stub" }));` +
        `}).listen(${port}, "127.0.0.1");`,
    );
  });

  after(() => {
    stub.kill("SIGKILL");
    killListener(port);
  });

  void test("a 503 is a failure, takes the streak, and does not restart on its own", () => {
    writeFileSync(mode, "503");
    seedState();
    const held = listenerPid(port);
    for (const expected of [1, 2]) {
      const outcome = pass(port);
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.match(outcome.stdout, /answered 503 in \d+ms - unhealthy/);
      assert.match(outcome.stdout, /not restarting yet/);
      assert.equal(state().failures, expected, "a 503 did not count toward the streak");
      assert.equal(state().restarts, 0);
    }
    assert.equal(listenerPid(port), held, "the process holding the port changed");
    assert.equal(notified(), "", "an unhealthy answer notified before anything was done about it");
  });

  void test("200 with `ok: false` is unhealthy too: the status line alone is not the verdict", () => {
    // The one a check written as `curl -f` gets wrong. The server answers 200 and says in the body
    // that it is not well - which is what it does when the tmux round trip inside /api/health
    // fails - and a watchdog that reads only the status code calls that healthy forever.
    writeFileSync(mode, "notok");
    seedState();
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /answered 200 in \d+ms - unhealthy/);
    assert.equal(state().failures, 1, "a 200 saying `ok: false` was read as healthy");
  });

  void test("a healthy answer from the same server clears the streak", () => {
    writeFileSync(mode, "healthy");
    seedState({ failures: 2 });
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /answered 200 in \d+ms$/m);
    assert.equal(state().failures, 0, "two failures then a healthy pass did not reset the streak");
  });
});

void describe("the watchdog survives its own surroundings", () => {
  // Three ways this script can be handed a broken world, all of which have to end in it still
  // supervising. A watchdog that refuses to run because of its own bookkeeping is a watchdog that
  // is off exactly when nobody is looking.
  let stub: ReturnType<typeof spawn>;
  let port = "";

  before(async () => {
    port = await freePort();
    freshTranscript("robust");
    stub = await startStub("healthy stub", port, healthyStub(port));
  });

  after(() => {
    stub.kill("SIGKILL");
    killListener(port);
    rmSync(join(stubs, "tailscale"), { force: true });
    // Put the recording notifier back, whatever this suite did to it.
    putStub("osascript", RECORDING_NOTIFIER);
  });

  void test("a corrupt state file is a first run, not a refusal to supervise", () => {
    // Truncated by a crash mid-write, or edited by hand. Starting from zero is the honest
    // recovery; exiting non-zero and touching nothing leaves the machine unsupervised over a
    // scratch file.
    writeFileSync(statePath, "{ this is not json");
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /answered 200/);
    assert.deepEqual(state(), {
      failures: 0,
      restarts: 0,
      gaveUp: false,
      pid: listenerPid(port),
      serveConfigured: false,
      startRefused: false,
    });
  });

  void test("clearing the state file after a give-up resumes supervision, as the log says it does", () => {
    // The give-up branch tells the operator, in the only channel it has left, that clearing the
    // state file is how they resume. That sentence is an instruction to a person at 3am and is
    // worth being true.
    seedState({ failures: 3, restarts: 2, gaveUp: true });
    const stuck = pass(port);
    assert.equal(stuck.status, 1);
    const instruction = /Clear (\S+) to resume/.exec(stuck.stdout);
    assert.notEqual(
      instruction,
      null,
      `the give-up pass does not say how to resume\n${stuck.stdout}`,
    );
    assert.equal(instruction?.[1], statePath, "it names a state file other than the one it reads");

    rmSync(statePath, { force: true });
    const resumed = pass(port);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /answered 200/);
    assert.equal(state().gaveUp, false, "it stayed given-up after the state file was cleared");
  });

  void test("a notifier that fails does not stop the pass that was trying to tell somebody", () => {
    // `osascript` can fail for reasons that have nothing to do with the server - no GUI session,
    // a TCC prompt nobody answered. Supervision must not be conditional on being able to talk
    // about it, and the failure must be logged rather than swallowed.
    putStub("osascript", `#!/bin/sh\necho "notifier unavailable" >&2\nexit 3\n`);
    putStub("tailscale", `#!/bin/sh\necho "no serve config"\nexit 0\n`);
    // `serveConfigured: true` with a stub that now says there is none: the regression branch, the
    // cheapest pass that has something to say to a person.
    seedState({ serveConfigured: true });
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /WAS configured for the port and is not any more/);
    assert.match(outcome.stdout, /could not post the notification/);
    assert.equal(state().serveConfigured, false, "the pass did not finish its bookkeeping");
    assert.equal(notified(), "", "the failing notifier somehow recorded something");
  });
});

void describe("what the watchdog is forbidden to do", () => {
  const source = readFileSync(watchdog, "utf8");

  void test("it never reaches for `tmux kill-server`", () => {
    // Every session at once, the one thing plan 006 says stays expensive. The recovery test
    // proves the panes survive one restart; this proves the command is not in the script at all.
    const code = source
      .split("\n")
      .filter((line) => !/^(\/\/|\/\*|\*)/.test(line.trim()))
      .join("\n");
    assert.doesNotMatch(code, /kill-server/, "the watchdog can kill the tmux server");
    assert.doesNotMatch(code, /execFile\(\s*"tmux"/, "the watchdog drives tmux directly");
  });

  void test("every external command it runs carries a timeout, so it cannot join the pile", () => {
    // A wedged tmux piles up unreaped children (audit.md's second gap), and that pile is what
    // this script exists to notice - so it may not join it. Timed out, or detached and unref'd.
    const calls = source.match(/execFile\(/g) ?? [];
    assert.ok(calls.length >= 3, "no execFile calls found; this test is reading the wrong file");
    const timeouts = source.match(/\{ timeout: TOOL_TIMEOUT_MS \}|timeout: TOOL_TIMEOUT_MS/g) ?? [];
    assert.equal(
      timeouts.length,
      calls.length,
      `${String(calls.length)} execFile calls but ${String(timeouts.length)} timeouts`,
    );
    // The two that are not timed are the ones deliberately outliving the pass: the server it
    // starts, and the critical dialog nobody may be there to dismiss.
    for (const detached of source.match(/spawn\([\s\S]*?\);/g) ?? []) {
      assert.match(detached, /detached: true/, "a spawned child is neither timed nor detached");
    }
    assert.equal((source.match(/\.unref\(\)/g) ?? []).length, 2, "a detached child is not unref'd");
  });

  void test("the probe timeout is well above the server's own health budget", () => {
    // The slow-but-alive clause in numbers rather than in prose: 15s is five times the 3s the
    // server gives its own tmux round trip, so "silent" means silent, not busy.
    assert.match(source, /const PROBE_TIMEOUT_MS = 15_000;/);
    assert.match(source, /const FAIL_THRESHOLD = 3;/);
    assert.match(source, /const MAX_RESTARTS = 2;/);
    const health = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
    const budget = /3_?000/.test(health) || /3000/.test(health);
    assert.ok(
      budget,
      "the server's health round trip no longer has the 3s budget 15000ms is five times",
    );
  });
});

void describe("the environment the recovered server gets is the plist's, and it has to be enough", () => {
  // The server's environment IS the plist's, so what the plist omits the recovered server does
  // not have - an empty allowlist, no agents, or the Origin check off. Refusing is the only
  // honest answer and it has to be audible (audit.md).
  let port = "";

  before(async () => {
    port = await freePort();
    freshTranscript("environment");
    seedState();
  });

  after(() => {
    killListener(port);
  });

  void test("no AGENTDECK_MOUNTS: it starts nothing, exits non-zero, and says why", async () => {
    const outcome = pass(port, { AGENTDECK_MOUNTS: undefined });
    assert.equal(outcome.status, 1, "a refusal exited 0, so launchd would see success");
    assert.match(outcome.stdout, /refusing to start the server: AGENTDECK_MOUNTS not set/);
    assert.doesNotMatch(outcome.stdout, /started the server/);
    assert.equal(listenerPid(port), null, "it started a server with no allowlist");
    const seen = await notifiedEventually(/will NOT start one/);
    assert.match(seen, /AGENTDECK_MOUNTS/);
    assert.match(seen, /tmux sessions are untouched/);
    assert.equal(state().startRefused, true);
  });

  void test("it says it once: the next pass logs the refusal and does not notify again", () => {
    const before = notified();
    const outcome = pass(port, { AGENTDECK_MOUNTS: undefined, AGENTDECK_PROFILES: undefined });
    assert.equal(outcome.status, 1);
    assert.match(
      outcome.stdout,
      /refusing to start the server: AGENTDECK_MOUNTS, AGENTDECK_PROFILES/,
    );
    assert.equal(notified(), before, "a banner a minute is the crash-loop in another medium");
  });

  void test("no AGENTDECK_ORIGIN: it refuses too, rather than recover to a weaker server", async () => {
    // The protection the first round of this branch missed: mounts and profiles make the server
    // emptier, no AGENTDECK_ORIGIN makes it less PROTECTED - Origin off on /api and /ws.
    seedState();
    const outcome = pass(port, { AGENTDECK_ORIGIN: undefined });
    assert.equal(outcome.status, 1);
    assert.match(outcome.stdout, /refusing to start the server: AGENTDECK_ORIGIN not set/);
    assert.doesNotMatch(outcome.stdout, /started the server/);
    assert.equal(listenerPid(port), null, "it started a server with the Origin check off");
    assert.match(await notifiedEventually(/AGENTDECK_ORIGIN/), /less protected/);
  });

  void test("the plist declares the whole server environment, not only the port and socket", () => {
    // The file this is really about: whatever is not in this block is not set on the recovered
    // server, and the watchdog can only refuse for what it knows to look for.
    const text = readFileSync(plist, "utf8");
    for (const name of ["AGENTDECK_MOUNTS", "AGENTDECK_PROFILES", "AGENTDECK_ORIGIN"]) {
      assert.match(
        text,
        new RegExp(`<key>${name}</key>\\s*<string>[^<]+</string>`),
        `the plist does not declare ${name}, so the recovered server does not have it`,
      );
    }
  });

  void test("the README tells the operator to fill the environment in, AGENTDECK_ORIGIN by name", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const installing = readme.slice(readme.indexOf("### Installing it"));
    assert.match(installing, /AGENTDECK_ORIGIN/);
    assert.match(installing, /AGENTDECK_MOUNTS/);
    assert.match(installing, /AGENTDECK_PROFILES/);
  });
});

void describe("the server the watchdog starts logs somewhere", () => {
  // `stdio: "ignore"` sent the one line a refusal to boot prints to /dev/null, so the watchdog
  // reported "started" and the diagnosis went to a closed fd.
  let port = "";

  before(async () => {
    port = await freePort();
    freshTranscript("server-log");
    seedState();
    rmSync(serverLog, { force: true });
  });

  after(() => {
    killListener(port);
  });

  void test("what the started server printed is in the log file, not in /dev/null", async () => {
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /started the server/);
    assert.ok(await waitForHealth(port), "the server never became healthy");
    // The boot lines src/server.ts prints, which are the sentences audit.md recorded as having
    // no log destination at all.
    for (let i = 0; i < 40 && !/listening on/.test(logged()); i++) await sleep(50);
    assert.match(
      logged(),
      /agentdeck: listening on 127\.0\.0\.1/,
      "the server's output went nowhere",
    );
  });

  void test("the log is 0600: a first run's token and QR can go through it", () => {
    // stdout is not a TTY here, so src/qr.ts prints no QR - but it does print the token file's
    // path, and the mode is what stops the next thing to change that branch from being a leak.
    assert.equal(statSync(serverLog).mode & 0o777, 0o600);
  });
});

void describe("a remembered pid is not a licence to kill", () => {
  // `stopServer` is SIGTERM and then SIGKILL, so the pid it is handed had better be the server.
  // The server crashing is this script's premise and macOS recycles pids, so a pid that is merely
  // alive is not evidence: the next thing to hold it is another process of this user.
  let port = "";
  let innocent: ReturnType<typeof spawn>;

  before(async () => {
    port = await freePort();
    freshTranscript("pid");
    innocent = spawn("/bin/sh", ["-c", "exec sleep 300"], { stdio: "ignore" });
    for (let i = 0; i < 40 && innocent.pid === undefined; i++) await sleep(25);
  });

  after(() => {
    innocent.kill("SIGKILL");
    killListener(port);
  });

  void test("a recycled pid that is not holding the port is not stopped", async () => {
    // The state file remembers 4242; 4242 is now a pane's agent, a build, or an editor. Nothing is
    // listening, so this pass recovers - and it must recover without signalling a stranger.
    seedState({ pid: innocent.pid ?? null });
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /no node process is holding the port/);
    assert.doesNotMatch(outcome.stdout, /stopping /, "it signalled a pid that held nothing");
    assert.ok(await waitForHealth(port), "the recovery itself did not happen");
    assert.equal(
      alive(innocent.pid ?? 0),
      true,
      "the watchdog killed an unrelated process of this user",
    );
  });

  void test("a pid of -1 in the state file is not believed, because kill(-1) is everything", () => {
    // A truncated or hand-edited state file: `kill(-1)` is every process this user owns. The port
    // has a healthy listener, so this asserts on what the pass believes rather than by letting an
    // unfixed script signal the runner's group.
    const held = listenerPid(port);
    assert.notEqual(held, null);
    seedState({ pid: -1 });
    const outcome = pass(port);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, new RegExp(`node process ${String(held)} holds it`));
    assert.doesNotMatch(outcome.stdout, /node process -1/, "-1 was taken for a live server");
    assert.equal(state().pid, held);
  });
});

void describe("installing the LaunchAgent changes what `scripts/` is, and that is written down", () => {
  // Every place that calls `scripts/` host-executed states the trigger as something a PERSON
  // does, which is what makes the prescribed diff review a control. A loaded LaunchAgent makes it
  // a 60-second timer, and that has to be said where the claim is made.
  const mentionsTimer = (text: string): boolean =>
    /60 seconds|60-second/.test(text) && /unattended|no human action|timer/i.test(text);

  void test("the README's toolchain exception says the timer runs it with no human action", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const start = readme.indexOf("Every one of those lines is a review gate");
    assert.notEqual(start, -1, "the toolchain exception has been renamed or removed");
    const exception = readme.slice(start, readme.indexOf("\n## ", start));
    assert.ok(
      mentionsTimer(exception),
      "the toolchain exception does not say installing the LaunchAgent makes `scripts/` unattended",
    );
  });

  void test("plan 005's enumeration of host-executed files says it too", () => {
    const plan = readFileSync(join(repoRoot, "plans", "005-containment.md"), "utf8");
    assert.ok(mentionsTimer(plan), "plan 005 still describes `scripts/` as human-triggered only");
    assert.match(plan, /launchd-watchdog/);
  });

  void test("the install copies the script out of the checkout before pointing launchd at it", () => {
    // The fix rather than the warning: what launchd runs unattended should not be a file an agent
    // can rewrite between reviews.
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const installing = readme.slice(readme.indexOf("### Installing it"));
    assert.match(installing, /cp scripts\/watchdog\.mjs/);
    assert.match(installing, /AGENTDECK_REPO/);
    // And the script can actually be run from that copy, which is the half a document cannot do.
    assert.match(readFileSync(watchdog, "utf8"), /process\.env\.AGENTDECK_REPO/);
  });
});

// The spawned server is detached from this process on purpose - it has to outlive the pass that
// started it - so this file is the only thing that will clean it up. Belt and braces alongside
// `after`: a crashed test run must not leave a server or a tmux socket behind.
process.on("exit", () => {
  for (const port of usedPorts) killListener(port);
});
