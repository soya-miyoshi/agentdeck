// m4/launchd-watchdog: ONE PASS of the watchdog, run on the host.
//
// launchd runs this every 60s (scripts/com.agentdeck.watchdog.plist). Each run is a fresh
// process, so everything the watchdog remembers between passes - how many checks in a row have
// failed, how many times it has already restarted, whether it has given up - lives in a small
// JSON state file rather than in memory. That is the whole reason this script has state at all.
//
// It is the first thing on this Mac that supervises the node process. Nothing did before it:
// src/supervisor-crash.test.ts is the measurement of what an unattended crash looks like without
// it - tmux keeps every agent, the phone gets nothing, and a person has to open a terminal.
//
// WHAT A RESTART COSTS, because that is what decides how readily this is allowed to act.
// tmux is a daemon of its own, owned by the user, so restarting the node server does not touch a
// single agent: same sessions, same ids, same pane pids (plan 006). What it does cost is every
// phone's socket and every tab's snapshot - a reconnect, a new epoch, a repaint - and the hook
// secret of any session that outlives the process, which never reports `waiting` again until its
// agent is restarted. Cheap, not free. Cheap enough to act on a wedge; not so cheap that a load
// spike should trigger it.
//
// THE RULE, AND THE ARGUMENT FOR IT.
// /api/health does a hard-timed `tmux list-sessions` round trip from the same event loop that
// serves the app, so an answer - any answer - is proof the loop is turning. A busy machine, a
// large capture or a wedged tmux can make a HEALTHY server slow. So this script separates three
// outcomes that a naive `curl --max-time 3 || restart` collapses into one:
//
//   answered  - bytes came back, however late. The event loop turned. This is LIVENESS, which is
//               what the check tests; latency is not a health verdict. A slow 200 is logged as
//               slow and is NOT a failure and NEVER counts toward a restart.
//   silent    - the socket was accepted and nothing ever came back inside PROBE_TIMEOUT_MS. This
//               is the wedge: a blocked event loop does not refuse connections.
//   refused   - nothing is listening. The process is gone.
//
// PROBE_TIMEOUT_MS is 15s, five times the 3s the server gives its own tmux round trip and five
// times what scripts/healthcheck.mjs allows a person running it by hand. A server that has not
// produced one byte in five times its own internal budget is not slow, it is stopped.
//
// And a wedge needs FAIL_THRESHOLD consecutive silent-or-unhealthy passes - three, so three
// minutes at a 60s interval - before anything is restarted. A load spike that outlasts three
// minutes of 15s probes is not a spike. `refused` skips the streak entirely and starts the server
// at once, because there is no socket to drop and no snapshot to lose: nothing is running.
//
// GIVE UP RATHER THAN CRASH-LOOP. After MAX_RESTARTS recoveries that do not produce a healthy
// pass, the state file is marked `gaveUp` and every later pass does nothing but say so. A server
// that is down and loudly known to be down is better than one being killed every minute.
//
// TWO KNOWN BLIND SPOTS, both in audit.md, neither fixed here:
//   1. `/api/health` answers 200 for exactly the locale failure that broke every create in
//      m0/create-500, because the server's `probeTmux` does not go through `baseEnv` and so has
//      its own locale. This watchdog therefore cannot see that class of failure at all: a 200
//      here means the loop turns, not that the server works. Fixing it is a change to
//      src/server.ts and belongs to its own item.
//   2. There is no execFile timeout on the server's tmux path, so a wedged tmux accumulates
//      child processes nothing reaps. That state is precisely what this script sees as `silent`,
//      and restarting the server is what reaps them - which is the case the wedge branch exists
//      for. Every tmux and lsof call BELOW passes its own timeout, so the watchdog cannot join
//      the pile it is meant to notice.

import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_TIMEOUT_MS = 15_000;
const FAIL_THRESHOLD = 3;
const MAX_RESTARTS = 2;
const SLOW_MS = 3_000;
const TOOL_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 10_000;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = process.env.AGENTDECK_PORT ?? "7777";
const statePath =
  process.env.AGENTDECK_WATCHDOG_STATE ?? join(homedir(), ".agentdeck", "watchdog-state.json");

const stamp = () => new Date().toISOString();
const log = (message) => {
  console.log(`${stamp()} agentdeck-watchdog: ${message}`);
};

// -----------------------------------------------------------------------------------------
// State across passes
// -----------------------------------------------------------------------------------------

// `failures` is the consecutive-unhealthy streak, `restarts` the number of recoveries since the
// last healthy pass, `pid` the server this watchdog started, `serveConfigured` what the last
// pass saw of `tailscale serve`. A missing or unreadable file is a first run, not an error: the
// honest recovery is to start from zero rather than refuse to supervise.
const emptyState = { failures: 0, restarts: 0, gaveUp: false, pid: null, serveConfigured: false };

const readState = () => {
  try {
    return { ...emptyState, ...JSON.parse(readFileSync(statePath, "utf8")) };
  } catch {
    return { ...emptyState };
  }
};

const writeState = (state) => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

// -----------------------------------------------------------------------------------------
// Notification: something a person actually sees, with nothing installed to see it
// -----------------------------------------------------------------------------------------
//
// There is no push (m5/push is unbuilt and optional) and the budget for runtime dependencies is
// spent, so the notifier is `osascript`, which ships with macOS. Two different weights, because
// the two events deserve different ones:
//
//   a restart  - `display notification`. Banner, Notification Centre, transient. It says the
//                sessions were kept, because a restart notification that does not say so is one
//                you learn to fear.
//   giving up  - `display alert ... as critical`, which is a window in the middle of the screen
//                that stays until it is dismissed. The server is DOWN and will not be brought
//                back by anything automatic; a banner that scrolls away is not enough. It is
//                spawned detached with `giving up after` so a dismissed-by-nobody dialog cannot
//                hold this pass open or leave a process behind after launchd's next tick.
const NOTIFY_TITLE = "agentdeck";

// Awaited, not fired and forgotten: this pass exits as soon as it has acted, and a notification
// still in flight when the process exits is one nobody ever sees. It is also the only way to
// report that the notifier itself failed.
const notify = async (message) => {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(
    NOTIFY_TITLE,
  )} sound name "Submarine"`;
  await new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: TOOL_TIMEOUT_MS }, (error) => {
      if (error) log(`could not post the notification (${error.message.trim()})`);
      resolve(null);
    });
  });
};

const alert = (message) => {
  const script =
    `display alert ${JSON.stringify(NOTIFY_TITLE)} message ${JSON.stringify(message)} ` +
    `as critical giving up after 600`;
  const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
  child.unref();
};

// -----------------------------------------------------------------------------------------
// Is the node process running, and does the port answer
// -----------------------------------------------------------------------------------------

const alive = (pid) => {
  if (typeof pid !== "number") return false;
  try {
    // Signal 0 is the check with no signal delivered.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The pid holding the port: the one this watchdog started if it is still alive, otherwise
 * whatever is listening. The second half matters because a server started by hand at login is
 * the normal case on this Mac, and a watchdog that will only restart its own children would
 * watch a wedged one forever.
 */
const listenerPid = async (state) => {
  if (alive(state.pid)) return state.pid;
  const found = await new Promise((resolve) => {
    execFile(
      "/usr/sbin/lsof",
      ["-ti", `tcp:${port}`, "-sTCP:LISTEN"],
      { timeout: TOOL_TIMEOUT_MS },
      (error, stdout) => {
        // Non-zero simply means nothing is listening, which is an answer.
        if (error) return resolve(null);
        const first = stdout.trim().split("\n")[0];
        const parsed = Number(first);
        resolve(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
      },
    );
  });
  return found;
};

/** `answered` (with status and latency), `silent`, or `refused`. */
const probe = async () => {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      // `globalThis.` on purpose: the lint configuration for scripts/ knows `fetch` but not
      // `AbortSignal`, and a lint-config change is not this item's to make.
      signal: globalThis.AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const ms = Date.now() - started;
    // A timeout is the wedge - accepted and never answered. Anything else is the connection
    // itself failing, which is the process not being there.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { kind: timedOut ? "silent" : "refused", ms, detail: String(error) };
  }
  const body = await response.json().catch(() => null);
  return {
    kind: "answered",
    ms: Date.now() - started,
    status: response.status,
    ok: response.status === 200 && body?.ok === true,
  };
};

// -----------------------------------------------------------------------------------------
// Starting and restarting
// -----------------------------------------------------------------------------------------

/**
 * Start the server detached, so it outlives this pass and launchd's next tick. Its environment
 * is this process's, which under launchd is exactly what the plist declares - the same path by
 * which the server gets its port, socket and mounts.
 */
const startServer = () => {
  const child = spawn(process.execPath, [join(repoRoot, "src", "server.ts")], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
};

/** SIGTERM, wait, SIGKILL. Never `tmux kill-server`: that is every session at once (plan 006). */
const stopServer = async (pid) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone between the check and the signal is the outcome wanted.
  }
};

// -----------------------------------------------------------------------------------------
// tailscale serve
// -----------------------------------------------------------------------------------------
//
// The watchdog is specified to check that `tailscale serve` is still configured for the port
// (plan 006), and it does. It cannot pass today: m4/tailscale-serve is blocked on two admin
// console switches that are not enabled, so nothing has ever run `tailscale serve` on this Mac.
//
// So "not configured" and "was configured and is gone" are kept apart, and only the second is
// worth waking anyone for. Never configured is the expected state of an unfinished milestone and
// must not fail the pass or count toward a restart - a watchdog that reports a milestone as an
// outage is one whose alerts are ignored by the time the outage is real.
//
// It does NOT re-apply. Plan 006 says re-apply, idempotently, and that is right - but the
// command that would do it is m4/tailscale-serve, which is a separate, blocked item, and running
// it here would be implementing it in the wrong place with the switches still off.
const serveConfigured = async () =>
  await new Promise((resolve) => {
    execFile(
      "tailscale",
      ["serve", "status"],
      { timeout: TOOL_TIMEOUT_MS },
      (error, stdout, stderr) => {
        // tailscale missing, tailscaled down, or not logged in: not configured, and not this
        // script's business to say more.
        if (error) return resolve(false);
        const text = `${stdout}${stderr}`;
        if (/no serve config/i.test(text)) return resolve(false);
        resolve(text.includes(`127.0.0.1:${port}`) || text.includes(`localhost:${port}`));
      },
    );
  });

const checkServe = async (state) => {
  const configured = await serveConfigured();
  if (configured) {
    log("tailscale serve is configured for the port");
  } else if (state.serveConfigured) {
    // The one that is a regression rather than a milestone: it was there last pass and is not
    // there now, which is the reboot case plan 006 names as failure (3).
    log("tailscale serve WAS configured for the port and is not any more");
    await notify(
      `tailscale serve is no longer configured for port ${port}. The phone cannot reach this ` +
        `Mac. Sessions are untouched. Re-apply it by hand.`,
    );
  } else {
    log("tailscale serve is not configured for the port (m4/tailscale-serve is not built yet)");
  }
  state.serveConfigured = configured;
};

// -----------------------------------------------------------------------------------------
// One pass
// -----------------------------------------------------------------------------------------

const state = readState();

if (state.gaveUp) {
  // Deliberately quiet: it already said this loudly once. Repeating the alert every 60s is the
  // crash-loop in a different medium.
  log(`gave up after ${String(state.restarts)} restarts; not acting. Clear ${statePath} to resume`);
  process.exit(1);
}

const pid = await listenerPid(state);
log(pid === null ? "no node process is holding the port" : `node process ${String(pid)} holds it`);

const result = await probe();
let healthy = false;

if (result.kind === "answered" && result.ok) {
  healthy = true;
  log(
    result.ms > SLOW_MS
      ? `/api/health answered 200 SLOWLY in ${String(result.ms)}ms - alive, so not restarting`
      : `/api/health answered 200 in ${String(result.ms)}ms`,
  );
} else if (result.kind === "answered") {
  log(`/api/health answered ${String(result.status)} in ${String(result.ms)}ms - unhealthy`);
} else if (result.kind === "silent") {
  log(`/api/health did not answer within ${String(PROBE_TIMEOUT_MS)}ms - wedged`);
} else {
  log(`nothing is listening on 127.0.0.1:${port} (${result.detail})`);
}

if (healthy) {
  if (state.restarts > 0 || state.failures > 0) log("recovered; failure counters reset");
  state.failures = 0;
  state.restarts = 0;
  state.pid = pid;
  await checkServe(state);
  writeState(state);
  process.exit(0);
}

// `refused` is not a streak: there is no server to be patient with, and starting one costs
// nothing that is not already lost.
state.failures = result.kind === "refused" ? FAIL_THRESHOLD : state.failures + 1;

if (state.failures < FAIL_THRESHOLD) {
  log(
    `${String(state.failures)} consecutive failure(s), acting at ${String(FAIL_THRESHOLD)} - ` +
      `not restarting yet`,
  );
  await checkServe(state);
  writeState(state);
  process.exit(0);
}

if (state.restarts >= MAX_RESTARTS) {
  state.gaveUp = true;
  writeState(state);
  const message =
    `The server is still unhealthy after ${String(MAX_RESTARTS)} restarts. The watchdog has ` +
    `STOPPED restarting it rather than loop. Your tmux sessions and every agent in them are ` +
    `untouched and still running. Nothing is reaching the phone until you look at this.`;
  log(`giving up after ${String(MAX_RESTARTS)} restarts`);
  alert(message);
  process.exit(1);
}

const restarting = pid !== null;
if (restarting) {
  log(`stopping ${String(pid)}`);
  await stopServer(pid);
}
const started = startServer();
state.pid = started;
state.restarts += 1;
state.failures = 0;
log(`started the server as ${String(started ?? 0)} (recovery ${String(state.restarts)})`);
await notify(
  restarting
    ? `Restarted the agentdeck server (it stopped answering). Your tmux sessions were KEPT - ` +
        `every agent is still running. Phones will reconnect and repaint.`
    : `Started the agentdeck server (nothing was listening). Any tmux sessions that were ` +
        `already running were KEPT and have been adopted.`,
);
await checkServe(state);
writeState(state);
process.exit(0);
