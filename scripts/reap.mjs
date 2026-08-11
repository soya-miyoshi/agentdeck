// ONE PASS of the orphan reaper, run by hand (`node scripts/reap.mjs`) or from the watchdog.
//
// It reports by default and kills only with --kill, because this signals processes as the operator
// and an unattended timer that gets the predicate wrong is worse than the garbage it collects.
//
// Why each condition below is the condition it is - and the two things this deliberately cannot
// see - are in audit.md's reaper entry, not here.

import { execFile } from "node:child_process";
import { connect } from "node:net";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const KILL = process.argv.includes("--kill");
const JSON_OUT = process.argv.includes("--json");

const ms = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// An hour, not a minute: the class this collects is abandoned for good, so waiting costs nothing,
// and a short window is what turns a slow build into a reaping.
const MIN_AGE_MS = ms("AGENTDECK_REAP_MIN_AGE_MS", 3_600_000);
const TOOL_TIMEOUT_MS = ms("AGENTDECK_REAP_TOOL_TIMEOUT_MS", 5_000);
const STOP_GRACE_MS = ms("AGENTDECK_REAP_STOP_GRACE_MS", 5_000);

// Absolute, in directories this user cannot write: PATH order does nothing for a command whose only
// copy lives somewhere an agent can replace it.
const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";

const port = process.env["AGENTDECK_PORT"] ?? "7777";
const liveSocket = process.env["TMUX_SOCKET"] ?? "agentdeck";
// The namespace the tests and the tools use. The operator's own tmux, and the live deck's socket,
// are outside it and are never candidates. Overridable so this tool's own tests can claim a
// namespace of their own rather than reaping the machine's real sockets as a side effect.
const SOCKET_PREFIX = process.env["AGENTDECK_REAP_SOCKET_PREFIX"] ?? "agentdeck-";

const log = (message) => {
  if (!JSON_OUT) console.log(message);
};

const sh = async (file, args) =>
  await new Promise((done) => {
    execFile(file, args, { timeout: TOOL_TIMEOUT_MS }, (error, stdout, stderr) => {
      done({ failed: error !== null, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });

// -----------------------------------------------------------------------------------------
// The provenance boundary
// -----------------------------------------------------------------------------------------

/** The roots a reapable process must have been working under. Same two variables the server reads. */
const readRoots = () =>
  [
    ...(process.env["AGENTDECK_ROOTS"] ?? "").split(":"),
    ...(process.env["AGENTDECK_MOUNTS"] ?? "").split(":"),
  ]
    .filter((entry) => entry !== "")
    .map((entry) => resolve(entry));

/** Containment with a path boundary, so `/x/repo` never claims `/x/repo-secrets`. */
const under = (roots, path) =>
  path !== "" && roots.some((root) => path === root || path.startsWith(root + sep));

// -----------------------------------------------------------------------------------------
// Reading the process table
// -----------------------------------------------------------------------------------------

/** `[[dd-]hh:]mm:ss` as milliseconds, or -1 when ps printed something this cannot read. */
const parseEtime = (etime) => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (match === null) return -1;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 +
      Number(minutes) * 60 +
      Number(seconds)) *
    1000
  );
};

/** Every process, as pid/ppid/tty/age/rss/command. One `ps`, because per-pid calls do not scale. */
const processTable = async () => {
  const { failed, stdout } = await sh(PS, ["-Ao", "pid=,ppid=,tty=,etime=,rss=,command="]);
  if (failed) return [];
  const rows = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3],
      ageMs: parseEtime(match[4] ?? ""),
      rssKb: Number(match[5]),
      command: match[6] ?? "",
    });
  }
  return rows;
};

/**
 * The working directory of each pid, as one lsof call rather than one per pid.
 *
 * The batch is not a micro-optimisation. One call per candidate took 14 seconds a pass against this
 * machine's process table, which is long enough that the tool stops being run.
 * `-Fpn` emits `p<pid>` then `n<path>` per process, so the two are paired by order.
 */
const cwdsOf = async (pids) => {
  const found = new Map();
  if (pids.length === 0) return found;
  const { stdout } = await sh(LSOF, ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]);
  let current = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n") && current > 0) found.set(current, line.slice(1));
  }
  return found;
};

/**
 * The pids `lsof` reports for a listen query, or `null` when it could not be asked.
 *
 * The two are kept apart on purpose. "Nothing is listening" and "lsof timed out" produce the same
 * empty list, and one of them silently switches off the exemption that spares a running dev server
 * - on a loaded machine, which is exactly when lsof is slow and when there is most to lose.
 * `-nP` because the name and port lookups are the only slow part of the query.
 */
const pidsListening = async (args) => {
  const { failed, stdout } = await sh(LSOF, ["-nP", ...args]);
  const pids = stdout
    .trim()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((parsed) => Number.isInteger(parsed) && parsed > 1);
  // lsof exits non-zero for "found nothing", so a failure with parsed output is still an answer.
  if (failed && pids.length === 0) return null;
  return pids;
};

/** Whatever is listening on the deck's port, so the running server is never a candidate. */
const listeningPids = async () =>
  (await pidsListening(["-ti", `tcp:${port}`, "-sTCP:LISTEN"])) ?? [];

/** Everything holding a listening TCP socket, or `null` when that could not be established. */
const serverPids = async () => {
  const pids = await pidsListening(["-ti", "-sTCP:LISTEN"]);
  return pids === null ? null : new Set(pids);
};

/** pid -> its children, built once from the table already read. */
const childMap = (rows) => {
  const children = new Map();
  for (const row of rows) {
    const kin = children.get(row.ppid) ?? [];
    kin.push(row.pid);
    children.set(row.ppid, kin);
  }
  return children;
};

/** Every descendant of a pid. Used to judge a whole tree, not a root: a dev server's listener is
 *  its grandchild, and the parent on its own looks idle. */
const descendants = (children, root) => {
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const next = queue.pop();
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
};

// -----------------------------------------------------------------------------------------
// Killing
// -----------------------------------------------------------------------------------------

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM, wait, SIGKILL. `pid > 1` is checked by `alive`: 0 and -1 signal whole groups. */
const stop = async (pid) => {
  if (!alive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone between the check and the signal is the outcome wanted.
  }
  return !alive(pid);
};

// -----------------------------------------------------------------------------------------
// Class 1: orphaned processes that started under a root
// -----------------------------------------------------------------------------------------

/**
 * Reparented (ppid 1), no controlling terminal, old enough, and working under an allowlisted root.
 *
 * All four, because the first two alone describe every launchd daemon on the machine - measured:
 * endpointsecurityd, automountd and the 1Password helper all match them. The root test is what
 * makes this agentdeck's garbage rather than the operating system's.
 *
 * `serving` of null means the listening set could not be read, and the whole class is abandoned:
 * without it the one exemption that spares a running dev server is off, and a pass that cannot tell
 * a server from a leftover must find nothing rather than guess.
 */
const orphans = async (rows, roots, spared, serving) => {
  if (serving === null) return null;
  const cheap = rows.filter(
    (row) =>
      row.pid > 1 &&
      row.pid !== process.pid &&
      row.ppid === 1 &&
      row.tty === "??" &&
      row.ageMs >= MIN_AGE_MS &&
      !spared.has(row.pid) &&
      // tmux is class 2: a tmux server holding live sessions is exactly what must not be signalled
      // for being parentless, and it always is.
      !/(?:^|\/)tmux(?:\s|$)/.test(row.command) &&
      // The deck itself. It runs detached with no terminal, and its cwd is a checkout under a root,
      // so every cheap test above says "orphan" about the one process that must survive this.
      !row.command.includes(join("src", "server.ts")),
  );
  // A tree with a listening socket in it is serving something, whatever its parent looks like.
  // Measured against a real machine: `pnpm dev`, 17 hours old, ppid 1 because the terminal that
  // started it had closed, with vite and wrangler listening two levels below - every other test
  // here called it garbage. It is the false positive this whole class is prone to.
  const children = childMap(rows);
  const idle = cheap.filter(
    (row) => ![...descendants(children, row.pid)].some((pid) => serving.has(pid)),
  );
  const cwds = await cwdsOf(idle.map((row) => row.pid));
  // A cwd that could not be read is not under a root, so it is left alone: the unreadable case and
  // the outside-every-root case must reach the same answer.
  return idle
    .map((row) => ({ ...row, cwd: cwds.get(row.pid) ?? "" }))
    .filter((row) => under(roots, row.cwd));
};

// -----------------------------------------------------------------------------------------
// Class 2: tmux servers in agentdeck's namespace holding no sessions
// -----------------------------------------------------------------------------------------

/** The `-L <name>` a tmux command line carries, or "" for the default socket. */
const socketOf = (command) => {
  const match = /\s-L\s+(\S+)/.exec(command);
  return match === null ? "" : (match[1] ?? "");
};

/**
 * Whether a socket's server definitively holds nothing.
 *
 * Definitive on purpose: only tmux's own "no sessions" counts as empty. A timeout, a wedge or any
 * other error is left alone, because "could not ask" and "holds nothing" must not be the same
 * answer when the action is a kill. Same predicate as server.ts's health check.
 */
const holdsNoSessions = async (socket) => {
  const { failed, stdout, stderr } = await sh("tmux", ["-L", socket, "list-sessions"]);
  if (!failed) return stdout.trim() === "";
  return /no sessions/i.test(`${stdout}${stderr}`);
};

const abandonedServers = async (rows) => {
  const found = [];
  for (const row of rows) {
    if (!/(?:^|\/)tmux(?:\s|$)/.test(row.command)) continue;
    if (row.ageMs < MIN_AGE_MS) continue;
    const socket = socketOf(row.command);
    // The live deck's socket is never a candidate, whatever it holds right now.
    if (!socket.startsWith(SOCKET_PREFIX) || socket === liveSocket) continue;
    if (!(await holdsNoSessions(socket))) continue;
    found.push({ ...row, socket });
  }
  return found;
};

// -----------------------------------------------------------------------------------------
// Class 3: socket files in agentdeck's namespace with nothing listening
// -----------------------------------------------------------------------------------------

/** Connect rather than infer: ECONNREFUSED is proof nothing is behind the file, which parsing a
 *  process table is not. Milliseconds each, so it scales to the thousands these accumulate in. */
const nothingListening = async (path) =>
  await new Promise((done) => {
    const probe = connect(path);
    const settle = (dead) => {
      probe.destroy();
      done(dead);
    };
    probe.on("connect", () => settle(false));
    probe.on("error", () => settle(true));
    setTimeout(() => settle(false), 250).unref();
  });

const staleSockets = async () => {
  const dir = join(
    process.env["TMUX_TMPDIR"] ?? "/private/tmp",
    `tmux-${String(process.getuid())}`,
  );
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { dir, dead: [] };
  }
  const dead = [];
  for (const name of names) {
    if (!name.startsWith(SOCKET_PREFIX) || name === liveSocket) continue;
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs < MIN_AGE_MS) continue;
    } catch {
      continue;
    }
    if (await nothingListening(path)) dead.push(path);
  }
  return { dir, dead };
};

// -----------------------------------------------------------------------------------------
// One pass
// -----------------------------------------------------------------------------------------

const roots = readRoots();
if (roots.length === 0) {
  // The root test is the only thing separating agentdeck's garbage from the operating system's, so
  // without it this refuses rather than falling back to a broader rule.
  console.error(
    "agentdeck-reap: neither AGENTDECK_ROOTS nor AGENTDECK_MOUNTS is set. Those roots are the " +
      "only thing that tells this tool's garbage apart from every launchd daemon on the machine, " +
      "which look identical without them. Refusing to reap anything. Run it the way `make` starts " +
      "the server: AGENTDECK_ROOTS=\"$(ghq root --all | tr '\\n' ':')\" node scripts/reap.mjs",
  );
  process.exit(2);
}

const rows = await processTable();
const spared = new Set(await listeningPids());
const serving = await serverPids();
const [dead, empty, sockets] = [
  await orphans(rows, roots, spared, serving),
  await abandonedServers(rows),
  await staleSockets(),
];

const minutes = (value) => `${String(Math.round(value / 60000))}m`;
const short = (command) => (command.length > 110 ? `${command.slice(0, 107)}...` : command);

log(`agentdeck-reap: ${KILL ? "REAPING" : "reporting only, pass --kill to act"}`);
log(`  roots: ${roots.join(", ")}`);
log(`  older than: ${minutes(MIN_AGE_MS)}   live socket (spared): ${liveSocket}`);

let reclaimedKb = 0;
const orphaned = dead ?? [];
if (dead === null) {
  log(
    `\norphaned processes under a root: NOT CHECKED - could not read what is listening on this ` +
      `machine, and without that a running dev server is indistinguishable from a leftover. The ` +
      `tmux halves below are unaffected.`,
  );
} else log(`\norphaned processes under a root: ${String(orphaned.length)}`);
for (const row of orphaned) {
  reclaimedKb += row.rssKb;
  log(`  pid ${String(row.pid)}  ${minutes(row.ageMs)}  ${String(row.rssKb)}KB  ${row.cwd}`);
  log(`    ${short(row.command)}`);
  if (KILL) log(`    -> ${(await stop(row.pid)) ? "reaped" : "SURVIVED the kill"}`);
}

log(`\ntmux servers in ${SOCKET_PREFIX}* holding no sessions: ${String(empty.length)}`);
for (const row of empty) {
  reclaimedKb += row.rssKb;
  log(`  pid ${String(row.pid)}  ${minutes(row.ageMs)}  ${String(row.rssKb)}KB  -L ${row.socket}`);
  if (KILL) log(`    -> ${(await stop(row.pid)) ? "reaped" : "SURVIVED the kill"}`);
}

log(`\nsocket files with nothing listening in ${sockets.dir}: ${String(sockets.dead.length)}`);
if (KILL) {
  let removed = 0;
  for (const path of sockets.dead) {
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      // Already gone, or not ours to remove.
    }
  }
  log(`  removed ${String(removed)}`);
}

log(
  `\n${KILL ? "reclaimed" : "would reclaim"} about ${String(Math.round(reclaimedKb / 1024))}MB ` +
    `across ${String(orphaned.length + empty.length)} processes`,
);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        killed: KILL,
        // null rather than [] when the class was abandoned: a consumer must not read "could not
        // check" as "nothing to collect".
        orphansChecked: dead !== null,
        orphans: orphaned.map(({ pid, ageMs, rssKb, cwd, command }) => ({
          pid,
          ageMs,
          rssKb,
          cwd,
          command,
        })),
        emptyServers: empty.map(({ pid, ageMs, rssKb, socket }) => ({ pid, ageMs, rssKb, socket })),
        staleSockets: sockets.dead.length,
        reclaimedKb,
      },
      null,
      2,
    ),
  );
}
