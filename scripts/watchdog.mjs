// m4/launchd-watchdog: ONE PASS of the watchdog, run on the host by launchd every 60s
// (scripts/com.agentdeck.watchdog.plist). Each pass is a fresh process, so the streak, the restart
// count and the give-up latch live in a JSON state file rather than in memory.
//
// The rules, the argument for each of them, the two blind spots this cannot see, and what
// installing the LaunchAgent does to scripts/ are in plan 006 and audit.md, not here.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Overridable so the tests drive milliseconds instead of waiting on the real values. Production
// uses the defaults; nothing in the plist sets these, and a non-positive value falls back rather
// than disabling a bound.
const ms = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const PROBE_TIMEOUT_MS = ms("AGENTDECK_WATCHDOG_PROBE_TIMEOUT_MS", 15_000);
const FAIL_THRESHOLD = 3;
const MAX_RESTARTS = 2;
const SLOW_MS = ms("AGENTDECK_WATCHDOG_SLOW_MS", 3_000);
const TOOL_TIMEOUT_MS = ms("AGENTDECK_WATCHDOG_TOOL_TIMEOUT_MS", 5_000);
const STOP_GRACE_MS = ms("AGENTDECK_WATCHDOG_STOP_GRACE_MS", 10_000);
const GIVE_UP_REALERT_MS = ms("AGENTDECK_WATCHDOG_REALERT_MS", 3_600_000);

// Absolute, and both in directories this user cannot write: PATH order does nothing for a command
// whose only copy lives in a user-writable directory (audit.md). `osascript` stays on PATH.
const LSOF = "/usr/sbin/lsof";
const TAILSCALE = process.env.AGENTDECK_TAILSCALE ?? "/usr/local/bin/tailscale";

// The checkout holding src/server.ts: the script's parent, or AGENTDECK_REPO once the script has
// been copied out of it, which is the supported install.
const repoRoot = process.env.AGENTDECK_REPO ?? fileURLToPath(new URL("..", import.meta.url));
const port = process.env.AGENTDECK_PORT ?? "7777";
const statePath =
  process.env.AGENTDECK_WATCHDOG_STATE ?? join(homedir(), ".agentdeck", "watchdog-state.json");
// Where the SERVER this pass starts writes its output; the watchdog's own lines go to launchd's
// StandardOutPath.
const serverLogPath =
  process.env.AGENTDECK_SERVER_LOG ?? join(homedir(), "Library", "Logs", "agentdeck-server.log");

const log = (message) => {
  console.log(`${new Date().toISOString()} agentdeck-watchdog: ${message}`);
};

// -----------------------------------------------------------------------------------------
// State across passes
// -----------------------------------------------------------------------------------------

// `failures` is the consecutive-unhealthy streak, `restarts` the recoveries since the last healthy
// pass, `startRefused` the once-only latch on the misconfiguration banner.
const emptyState = {
  failures: 0,
  restarts: 0,
  gaveUp: false,
  gaveUpAlertedAt: 0,
  pid: null,
  serveConfigured: false,
  startRefused: false,
};

/** A counter as read from the file, clamped into [0, limit]: a planted or hand-edited value may
 *  only make the watchdog act sooner, never later (a negative streak never reaches the threshold). */
const counter = (value, limit) =>
  Number.isInteger(value) ? Math.min(Math.max(value, 0), limit) : 0;

/** The state this pass starts from. A missing or truncated file is a first run, not an error:
 *  starting from zero beats refusing to supervise. */
const readState = () => {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    const raw = typeof parsed === "object" && parsed !== null ? parsed : {};
    return {
      ...emptyState,
      ...raw,
      failures: counter(raw.failures, FAIL_THRESHOLD),
      restarts: counter(raw.restarts, MAX_RESTARTS),
    };
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

/** A modal for giving up, detached so an undismissed dialog outlives this pass without holding
 *  it open. */
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

/** A pid's full command line, or "" if it is gone. Used to tell agentdeck from a namesake. */
const commandOf = async (pid) =>
  await new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "command=", "-p", String(pid)],
      { timeout: TOOL_TIMEOUT_MS },
      (error, stdout) => resolve(error ? "" : stdout.trim()),
    );
  });

/** A pid's working directory, or "" if it cannot be read. Needed because the server is routinely
 *  started with a RELATIVE script path, which the argv alone cannot resolve to a checkout. */
const cwdOf = async (pid) =>
  await new Promise((resolve) => {
    execFile(
      LSOF,
      ["-a", "-d", "cwd", "-Fn", "-p", String(pid)],
      { timeout: TOOL_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return resolve("");
        const line = stdout.split("\n").find((entry) => entry.startsWith("n"));
        resolve(line === undefined ? "" : line.slice(1));
      },
    );
  });

const SERVER_SCRIPT = join("src", "server.ts");

/**
 * Whether a pid is OUR server: a node running THIS checkout's src/server.ts.
 *
 * Two shapes, because two things start it. The watchdog's own spawn is absolute on both counts.
 * `make start`, `make restart` and `pnpm start` are not - `ps` reports them as
 * `node --env-file-if-exists=.env src/server.ts` - so for those the checkout is decided by the
 * process's working directory. Matching only the absolute shape made every server an operator
 * ever started unrecognisable: the watchdog called it a squatter, alerted, and supervised nothing.
 */
const isOurServer = async (pid) => {
  const command = await commandOf(pid);
  if (command === "") return false;
  const target = join(repoRoot, SERVER_SCRIPT);
  if (command.includes(process.execPath) && command.includes(target)) return true;
  const tokens = command.split(" ").filter((token) => token !== "");
  if (basename(tokens[0] ?? "") !== "node") return false;
  const script = tokens.find(
    (token) => token === SERVER_SCRIPT || token.endsWith(`/${SERVER_SCRIPT}`),
  );
  if (script === undefined) return false;
  const cwd = await cwdOf(pid);
  return cwd !== "" && resolvePath(cwd, script) === target;
};

/** The pid holding the port, only if it is our server. Anything else is reported as a squatter:
 *  this pid is what gets SIGTERM then SIGKILL, and it is not ours to send. */
const listenerPid = async (state) => {
  const listening = await listeningPids();
  const candidate =
    alive(state.pid) && listening.includes(state.pid) ? state.pid : (listening[0] ?? null);
  if (candidate === null) return null;
  if (await isOurServer(candidate)) return candidate;
  return { squatter: candidate, command: await commandOf(candidate) };
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

// What the server may not be started without: no directories is an empty allowlist, no profiles is
// nothing startable, no origin is the Origin check off on every /api route and /ws upgrade. The
// first is a pair rather than a name - either variable is a source of startable directories.
const REQUIRED_ENV = [
  ["AGENTDECK_MOUNTS", "AGENTDECK_ROOTS"],
  ["AGENTDECK_PROFILES"],
  ["AGENTDECK_ORIGIN"],
];
// Unset OR still the plist's sentinel. A placeholder is worse than an absence: a wrong
// AGENTDECK_ORIGIN 403s every browser request while /api/health keeps answering 200, so the
// watchdog would log a green pass forever against a server the phone cannot use.
const isSet = (name) => {
  const value = process.env[name] ?? "";
  return value !== "" && !value.includes("REPLACE_ME");
};
const missingEnv = () =>
  REQUIRED_ENV.filter((group) => !group.some(isSet)).map((group) => group.join(" or "));

/** Start the server detached so it outlives this pass. The log is 0600 because it can carry a
 *  first run's token. */
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

// SIGTERM, wait, SIGKILL. Never `tmux kill-server`: that is every session at once (plan 006).
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

/** Whether the text is `serve status` OUTPUT at all. The GUI build's `tailscale` is a wrapper that
 *  EXITS 0 and prints `Tailscale.CLIError` when it cannot reach the app, which is not "no config". */
const isServeAnswer = (text) =>
  /no serve config/i.test(text) ||
  /https?:\/\//i.test(text) ||
  /\bproxy\b/i.test(text) ||
  /funnel\s+on/i.test(text);

/** Whether `tailscale serve` still points at the port, or `null` for "could not ask". Detect and
 *  report only - re-applying is m4/tailscale-serve's, and that item is blocked (plan 006). */
const serveState = async () => {
  if (!existsSync(TAILSCALE)) return null;
  return await new Promise((resolve) => {
    execFile(
      TAILSCALE,
      ["serve", "status"],
      // TERM or the macsys build tries to start the GUI and answers CLIError with exit 0; launchd
      // sets no TERM, which is what made this check report "could not ask" on every pass.
      { timeout: TOOL_TIMEOUT_MS, env: { ...process.env, TERM: process.env.TERM || "dumb" } },
      (error, stdout, stderr) => {
        const text = `${stdout}${stderr}`;
        // Could not ask, NOT "not configured": a serve that is working must never be reported as
        // gone because the CLI could not answer - that path notifies, and the alarm would be false.
        if (error || !isServeAnswer(text)) return resolve(null);
        // Same predicate as scripts/tailscale-serve.mjs, deliberately: Funnel is the public
        // internet rather than the tailnet, and the two must not disagree about what it looks like.
        const funnel = /funnel\s+on/i.test(text) || /^\s*Funnel on\b/im.test(text);
        if (/no serve config/i.test(text)) return resolve({ configured: false, funnel });
        const configured = text.includes(`127.0.0.1:${port}`) || text.includes(`localhost:${port}`);
        resolve({ configured, funnel });
      },
    );
  });
};

/** Reports it, and only notifies for "was configured last pass and is gone" - never configured is
 *  the expected state of an unbuilt milestone (plan 006). */
const checkServe = async (state) => {
  const serve = await serveState();
  if (serve === null) {
    // No fall back to PATH: the writable copy is exactly what must not be executed here. The
    // second case leaves state.serveConfigured alone, so one mute pass cannot forget what is true.
    log(
      existsSync(TAILSCALE)
        ? `${TAILSCALE} did not answer with a serve status; the serve check is skipped this pass`
        : `no tailscale at ${TAILSCALE}; the serve check is skipped this pass`,
    );
    return;
  }
  const { configured, funnel } = serve;

  // Funnel is the public internet. The install script refuses to run under it, but that check
  // happens once and this is the only thing that looks again - so exposure widening after the
  // fact was invisible. Alerted at the same weight as giving up, every pass it is true, because
  // a terminal server on the public internet is not a thing to mention once.
  if (funnel) {
    log("TAILSCALE FUNNEL IS ON: this port is exposed to the public internet, not the tailnet");
    await notify(
      `agentdeck: tailscale FUNNEL is on for this machine. The deck is reachable from the public ` +
        `internet, not just your tailnet. Turn it off with \`tailscale funnel ${port} off\`.`,
    );
  }

  if (configured) {
    log("tailscale serve is configured for the port");
    // Exposure APPEARING is a security event and was silent; only its disappearance was reported.
    if (!state.serveConfigured) {
      await notify(`tailscale serve now publishes port ${port} on the tailnet.`);
    }
  } else if (state.serveConfigured) {
    log("tailscale serve WAS configured for the port and is not any more");
    await notify(
      `tailscale serve is no longer configured for port ${port}. The phone cannot reach this ` +
        `Mac. Sessions are untouched. Re-apply it by hand.`,
    );
  } else {
    log("tailscale serve is not configured for the port");
  }
  state.serveConfigured = configured;
};

// -----------------------------------------------------------------------------------------
// One pass
// -----------------------------------------------------------------------------------------

const GAVE_UP_MESSAGE =
  `The server is still unhealthy after ${String(MAX_RESTARTS)} restarts. The watchdog has ` +
  `STOPPED restarting it rather than loop. Your tmux sessions and every agent in them are ` +
  `untouched and still running. Nothing is reaching the phone until you look at this.`;

const state = readState();

if (state.gaveUp) {
  // Still probes and re-alerts hourly: the latch is a file anyone with this uid can plant, so it
  // may never be silent, and hourly is not the crash-loop a per-pass alert would be.
  log(`gave up after ${String(state.restarts)} restarts; not acting. Clear ${statePath} to resume`);
  const latched = await probe();
  if (latched.kind === "answered" && latched.ok) {
    log("the server is answering, but the give-up latch is set - clear the state file to resume");
  } else {
    // Unusable or in the future means "never alerted": a planted stamp may not buy silence.
    const last = Number(state.gaveUpAlertedAt);
    const usable = Number.isFinite(last) && last > 0 && last <= Date.now();
    const since = usable ? Date.now() - last : Number.POSITIVE_INFINITY;
    if (since >= GIVE_UP_REALERT_MS) {
      state.gaveUpAlertedAt = Date.now();
      writeState(state);
      alert(GAVE_UP_MESSAGE);
    }
  }
  process.exit(1);
}

const holder = await listenerPid(state);

// Something else owns the port. Not ours to kill and not evidence we are healthy: killing it would
// be an unattended timer SIGKILLing an unrelated process of the operator's, and blessing it would
// let a same-uid stub answering /api/health buy permanent silence from the only thing watching.
if (holder !== null && typeof holder === "object") {
  log(`port ${String(port)} is held by pid ${String(holder.squatter)}, which is not agentdeck`);
  log(`  it is running: ${holder.command}`);
  // `tailscale serve` outlives the server it was verified against: it is tailscaled state, kept
  // across a logout and a reboot, and its one identity check ran when it was applied. So a
  // squatter on this port does not merely conflict locally - it is PUBLISHED, with a real
  // certificate, to every device on the tailnet. Saying "port conflict" and stopping would let
  // the operator read this as a local annoyance.
  const exposure = await serveState();
  const published = exposure !== null && exposure.configured;
  if (published) {
    log(`  and tailscale serve is publishing that port on the tailnet`);
  }
  alert(
    `agentdeck watchdog: port ${String(port)} is held by something that is not agentdeck ` +
      `(pid ${String(holder.squatter)}).` +
      (published
        ? ` tailscale serve is PUBLISHING that port to your tailnet, so whatever that process is, ` +
          `it is reachable from your other devices. Run \`tailscale serve reset\` if that is not ` +
          `what you want.`
        : "") +
      ` Not restarting and not killing it - that is your call.`,
  );
  process.exit(1);
}

const pid = holder;
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
  state.gaveUpAlertedAt = Date.now();
  writeState(state);
  log(`giving up after ${String(MAX_RESTARTS)} restarts`);
  alert(GAVE_UP_MESSAGE);
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
