// m4/launchd-watchdog: ONE PASS of the watchdog, run on the host by launchd every 60s
// (scripts/com.agentdeck.watchdog.plist). Each pass is a fresh process, so the streak, the restart
// count and the give-up latch live in a JSON state file rather than in memory.
//
// The rules, the argument for each of them, the two blind spots this cannot see, and what
// installing the LaunchAgent does to scripts/ are in plan 006 and audit.md, not here.

import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_TIMEOUT_MS = 15_000;
const FAIL_THRESHOLD = 3;
const MAX_RESTARTS = 2;
const SLOW_MS = 3_000;
const TOOL_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 10_000;

// Absolute. `osascript` and `tailscale` stay on PATH, which is why the plist's PATH puts the
// system directories ahead of every user-writable one (audit.md).
const LSOF = "/usr/sbin/lsof";

// The checkout holding src/server.ts: the script's parent when run from the repository, and
// AGENTDECK_REPO when the script has been copied out of it, which is the supported install.
const repoRoot = process.env.AGENTDECK_REPO ?? fileURLToPath(new URL("..", import.meta.url));
const port = process.env.AGENTDECK_PORT ?? "7777";
const statePath =
  process.env.AGENTDECK_WATCHDOG_STATE ?? join(homedir(), ".agentdeck", "watchdog-state.json");
// Where the SERVER this pass starts writes its output. The watchdog's own lines go to launchd's
// StandardOutPath; this is the other half, and without it a refusal to boot is a closed fd.
const serverLogPath =
  process.env.AGENTDECK_SERVER_LOG ?? join(homedir(), "Library", "Logs", "agentdeck-server.log");

const stamp = () => new Date().toISOString();
const log = (message) => {
  console.log(`${stamp()} agentdeck-watchdog: ${message}`);
};

// -----------------------------------------------------------------------------------------
// State across passes
// -----------------------------------------------------------------------------------------

// `failures` is the consecutive-unhealthy streak, `restarts` the recoveries since the last healthy
// pass, `startRefused` the once-only latch on the misconfiguration banner. A missing or truncated
// file is a first run rather than an error: starting from zero beats refusing to supervise.
const emptyState = {
  failures: 0,
  restarts: 0,
  gaveUp: false,
  pid: null,
  serveConfigured: false,
  startRefused: false,
};

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

const NOTIFY_TITLE = "agentdeck";

/** A banner for a restart. Awaited, because this pass exits as soon as it has acted. */
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

/** A modal for giving up. Detached with `giving up after`, so an undismissed dialog outlives
 *  this pass without holding it open or surviving into the next tick. */
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

/** Does this pid exist. `pid > 1` because 0 and -1 make `process.kill` signal a whole group or
 *  every process this user owns, and the pid comes from a file a crash can truncate. */
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Every pid listening on the port, as lsof reports it, validated. Non-zero exit means nothing
 *  is listening, which is an answer rather than an error. */
const listeningPids = async () =>
  await new Promise((resolve) => {
    execFile(
      LSOF,
      ["-ti", `tcp:${port}`, "-sTCP:LISTEN"],
      { timeout: TOOL_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return resolve([]);
        const pids = stdout
          .trim()
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((parsed) => Number.isInteger(parsed) && parsed > 1);
        resolve(pids);
      },
    );
  });

/** The pid holding the port, asked every pass. `state.pid` is believed only while lsof still
 *  reports it as the listener, because what this pid is for is SIGTERM then SIGKILL. */
const listenerPid = async (state) => {
  const listening = await listeningPids();
  if (alive(state.pid) && listening.includes(state.pid)) return state.pid;
  return listening[0] ?? null;
};

/** `answered` (with status and latency), `silent`, or `refused`. A timeout is the wedge - a
 *  blocked event loop still accepts connections - and any other error is nothing being there. */
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
 * What the server may not be started without: no mounts is an empty allowlist, no profiles is
 * nothing startable, no origin is the Origin check off on every /api route and /ws upgrade. Each
 * would make the recovered server emptier or less protected than the one it replaced.
 */
const REQUIRED_ENV = ["AGENTDECK_MOUNTS", "AGENTDECK_PROFILES", "AGENTDECK_ORIGIN"];
const missingEnv = () => REQUIRED_ENV.filter((name) => (process.env[name] ?? "") === "");

/** Start the server detached so it outlives this pass, with its output in a 0600 file: it can
 *  carry a first run's token, and the one line a refusal to boot prints is the whole diagnosis. */
const startServer = () => {
  let out = "ignore";
  try {
    mkdirSync(dirname(serverLogPath), { recursive: true, mode: 0o700 });
    out = openSync(serverLogPath, "a", 0o600);
  } catch (error) {
    log(`could not open ${serverLogPath} (${String(error)}); the server's output is discarded`);
  }
  const child = spawn(process.execPath, [join(repoRoot, "src", "server.ts")], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", out, out],
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

/** Whether `tailscale serve` still points at the port. Detect and report only - re-applying is
 *  m4/tailscale-serve's command and that item is blocked (plan 006). */
const serveConfigured = async () =>
  await new Promise((resolve) => {
    execFile(
      "tailscale",
      ["serve", "status"],
      { timeout: TOOL_TIMEOUT_MS },
      (error, stdout, stderr) => {
        // tailscale missing, tailscaled down or not logged in: not configured.
        if (error) return resolve(false);
        const text = `${stdout}${stderr}`;
        if (/no serve config/i.test(text)) return resolve(false);
        resolve(text.includes(`127.0.0.1:${port}`) || text.includes(`localhost:${port}`));
      },
    );
  });

/** Reports it, and only notifies for "was configured last pass and is gone" - never configured is
 *  the expected state of an unbuilt milestone and must not train anyone to ignore the alerts. */
const checkServe = async (state) => {
  const configured = await serveConfigured();
  if (configured) {
    log("tailscale serve is configured for the port");
  } else if (state.serveConfigured) {
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
  // Deliberately quiet: it already said this loudly once, and an alert a minute is the crash-loop
  // in a different medium.
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
  state.startRefused = false;
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

const absent = missingEnv();
if (absent.length > 0) {
  // Nothing is stopped either: a server that is at least configured, however wedged, beats being
  // replaced by one that cannot list a session, start an agent, or check an Origin.
  const message =
    `The agentdeck server needs recovering and the watchdog will NOT start one: ` +
    `${absent.join(" and ")} ${absent.length > 1 ? "are" : "is"} not set in the watchdog's own ` +
    `environment, so the server it started would be emptier and less protected than the one it ` +
    `replaced. Put them in the LaunchAgent (scripts/com.agentdeck.watchdog.plist) and start the ` +
    `server yourself. Your tmux sessions are untouched.`;
  log(`refusing to start the server: ${absent.join(", ")} not set in this environment`);
  // Said once. Every pass logs it, but a banner a minute is the crash-loop in another medium.
  const first = !state.startRefused;
  state.startRefused = true;
  writeState(state);
  if (first) await notify(message);
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
