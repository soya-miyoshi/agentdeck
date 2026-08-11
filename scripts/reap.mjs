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

// Whether a process whose subtree holds a listening socket is spared. OFF by the operator's
// decision: a dev server left running is exactly what they want collected, and the exemption was
// keeping the largest thing on the list alive. Set to 1 to put it back. The deck's own listener is
// spared separately and unconditionally, so this never reaches it.
const SPARE_LISTENERS = process.env["AGENTDECK_REAP_SPARE_LISTENERS"] === "1";

// Whether what an agent started inside a LIVE pane is collected too - the one class here that takes
// processes nobody abandoned. On by the operator's decision. What it does NOT take is anything
// matching KEEP below. Set to 0 to collect only what has actually lost its parent.
const REAP_PANE_CHILDREN = (process.env["AGENTDECK_REAP_PANE_CHILDREN"] ?? "1") !== "0";

/**
 * Commands the TIMED pass leaves alone inside a live pane, as a case-insensitive pattern.
 *
 * MCP servers by default. Claude Code does not reconnect a stdio MCP server that dies - its
 * documentation says so, and `@playwright/mcp` is stdio - so collecting one does not interrupt a
 * running agent's tools, it removes them until a person opens `/mcp` and retries. Closing a session
 * still takes them: that path is a person saying they are done, and it does not consult this.
 *
 * A name match, with the weakness that implies: an MCP server whose command says neither "mcp" nor
 * "modelcontextprotocol" is not recognised, and a process that merely has one of those strings in
 * its path is spared for the wrong reason. Set AGENTDECK_REAP_KEEP to another pattern, or to
 * something that matches nothing, to change it.
 */
const keepPattern = process.env["AGENTDECK_REAP_KEEP"] ?? "mcp|modelcontextprotocol";
const KEEP = (() => {
  try {
    return new RegExp(keepPattern, "i");
  } catch {
    // An unusable pattern must not mean "keep nothing" - that would silently widen what is killed.
    console.error(
      `agentdeck-reap: AGENTDECK_REAP_KEEP is not a valid regular expression ` +
        `(${JSON.stringify(keepPattern)}); falling back to the default rather than sparing nothing.`,
    );
    return /mcp|modelcontextprotocol/i;
  }
})();

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

/** Everything holding a listening TCP socket, or `null` when that could not be established. An
 *  empty set when the exemption is off, which is also the query not being run at all. */
const serverPids = async () => {
  if (!SPARE_LISTENERS) return new Set();
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

/**
 * Whether a pid is done, counting a zombie as done.
 *
 * A killed child whose parent never calls `wait` stays in the table as a zombie, and `kill(pid, 0)`
 * succeeds against one - so the plain check called it a survivor. That is exactly the shape this
 * tool creates: the pane children it collects are killed under a parent it deliberately leaves
 * running. A zombie holds no memory and runs nothing; reporting it as SURVIVED is a false alarm
 * about the one thing an operator is watching this output for.
 */
const gone = async (pid) => {
  if (!alive(pid)) return true;
  const { failed, stdout } = await sh(PS, ["-o", "state=", "-p", String(pid)]);
  return !failed && stdout.trim().startsWith("Z");
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
    if (await gone(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone between the check and the signal is the outcome wanted.
  }
  return await gone(pid);
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
  // With the listener exemption on, a tree holding a listening socket is serving something whatever
  // its parent looks like, and is spared. Off, `serving` is empty and this filter passes everything.
  const children = childMap(rows);
  const idle = cheap.filter(
    (row) => ![...descendants(children, row.pid)].some((pid) => serving.has(pid)),
  );
  const cwds = await cwdsOf(idle.map((row) => row.pid));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  // A cwd that could not be read is not under a root, so it is left alone: the unreadable case and
  // the outside-every-root case must reach the same answer.
  return idle
    .map((row) => ({ ...row, cwd: cwds.get(row.pid) ?? "" }))
    .filter((row) => under(roots, row.cwd))
    .map((row) => {
      // The WHOLE tree, not the root of it. `pnpm dev` is four processes deep - turbo, then vite and
      // wrangler, then an esbuild service - and signalling only the top reparents the rest to launchd,
      // where they look like fresh orphans and survive until some later pass happens to catch them.
      // The descendants are what the operator actually asked to be rid of.
      const tree = [...descendants(children, row.pid)].filter((pid) => !spared.has(pid));
      return {
        ...row,
        tree,
        treeKb: tree.reduce((sum, pid) => sum + (byPid.get(pid)?.rssKb ?? 0), 0),
      };
    });
};

// -----------------------------------------------------------------------------------------
// Class 1b: what the agents started inside LIVE panes
// -----------------------------------------------------------------------------------------

/**
 * Every pane on the DECK'S OWN socket, by pid.
 *
 * `-L ${liveSocket}` and nothing else, which is the whole safety boundary of this class. The
 * operator's own tmux runs on the default socket and had five sessions of their own shells on it
 * when this was written; "everything attached to tmux" would have swept all of them.
 */
const livePanePids = async () => {
  const { failed, stdout } = await sh("tmux", [
    "-L",
    liveSocket,
    "list-panes",
    "-a",
    "-F",
    "#{pane_pid}",
  ]);
  if (failed) return [];
  return stdout
    .trim()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
};

/**
 * What the agents have started and not cleaned up, inside sessions that are still running.
 *
 * The pane process itself is never included - on this deck that IS the agent, and killing it ends
 * the session. Nor is anything matching KEEP, which is MCP servers by default: an agent cannot
 * restart a stdio one, so taking it does not interrupt a tool, it removes it. Everything else below
 * the pane is collected, which makes this the one class that takes processes with a living parent.
 *
 * Closing a session is a different path (`Tmux.kill`) and does not consult KEEP: a person pressing
 * Close has said they are done with the session, MCP servers included.
 */
const paneChildren = async (rows, spared) => {
  if (!REAP_PANE_CHILDREN) return [];
  const panes = await livePanePids();
  if (panes.length === 0) return [];
  const children = childMap(rows);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const found = [];
  for (const pane of panes) {
    const kept = [];
    const tree = [...descendants(children, pane)].filter((pid) => {
      if (pid === pane || pid === process.pid || spared.has(pid)) return false;
      const row = byPid.get(pid);
      if ((row?.ageMs ?? 0) < MIN_AGE_MS) return false;
      if (KEEP.test(row?.command ?? "")) {
        kept.push(pid);
        return false;
      }
      return true;
    });
    if (tree.length === 0 && kept.length === 0) continue;
    found.push({
      pane,
      paneCommand: byPid.get(pane)?.command ?? "",
      tree,
      kept,
      keptRows: kept.map((pid) => byPid.get(pid)).filter((row) => row !== undefined),
      treeKb: tree.reduce((sum, pid) => sum + (byPid.get(pid)?.rssKb ?? 0), 0),
      rows: tree.map((pid) => byPid.get(pid)).filter((row) => row !== undefined),
    });
  }
  return found;
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
const [dead, panes, empty, sockets] = [
  await orphans(rows, roots, spared, serving),
  await paneChildren(rows, spared),
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
  reclaimedKb += row.treeKb;
  const extra = row.tree.length - 1;
  log(
    `  pid ${String(row.pid)}  ${minutes(row.ageMs)}  ${String(row.treeKb)}KB  ${row.cwd}` +
      (extra > 0 ? `  (+${String(extra)} in its tree)` : ""),
  );
  log(`    ${short(row.command)}`);
  if (KILL) {
    // Deepest first, so a supervisor cannot notice a child dying and restart it before its own turn.
    const survivors = [];
    for (const pid of [...row.tree].reverse()) if (!(await stop(pid))) survivors.push(pid);
    log(
      `    -> ${survivors.length === 0 ? `reaped ${String(row.tree.length)} process(es)` : `SURVIVED the kill: ${survivors.join(", ")}`}`,
    );
  }
}

log(
  `\nstarted inside live ${liveSocket} panes: ${REAP_PANE_CHILDREN ? `${String(panes.length)} pane(s) with something under them (keeping /${KEEP.source}/i)` : "NOT CHECKED (AGENTDECK_REAP_PANE_CHILDREN=0)"}`,
);
for (const entry of panes) {
  reclaimedKb += entry.treeKb;
  log(
    `  pane ${String(entry.pane)}  ${String(entry.tree.length)} process(es)  ` +
      `${String(entry.treeKb)}KB  under: ${short(entry.paneCommand)}`,
  );
  for (const row of entry.rows) {
    log(
      `    pid ${String(row.pid)}  ${minutes(row.ageMs)}  ${String(row.rssKb)}KB  ${short(row.command)}`,
    );
  }
  // What is SPARED is printed too. A pass that silently skipped an agent's MCP server would be
  // indistinguishable from one that never saw it, and that difference is the whole point of KEEP.
  for (const row of entry.keptRows) {
    log(`    kept  ${String(row.pid)}  ${minutes(row.ageMs)}  ${short(row.command)}`);
  }
  if (KILL && entry.tree.length > 0) {
    const survivors = [];
    for (const pid of [...entry.tree].reverse()) if (!(await stop(pid))) survivors.push(pid);
    log(
      `    -> ${survivors.length === 0 ? `reaped ${String(entry.tree.length)} process(es)` : `SURVIVED the kill: ${survivors.join(", ")}`}`,
    );
  }
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

const paneProcesses = panes.reduce((sum, entry) => sum + entry.tree.length, 0);
const orphanProcesses = orphaned.reduce((sum, row) => sum + row.tree.length, 0);
log(
  `\n${KILL ? "reclaimed" : "would reclaim"} about ${String(Math.round(reclaimedKb / 1024))}MB ` +
    `across ${String(orphanProcesses + paneProcesses + empty.length)} processes`,
);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        killed: KILL,
        // null rather than [] when the class was abandoned: a consumer must not read "could not
        // check" as "nothing to collect".
        orphansChecked: dead !== null,
        orphans: orphaned.map(({ pid, ageMs, treeKb, cwd, command, tree }) => ({
          pid,
          ageMs,
          treeKb,
          treeSize: tree.length,
          cwd,
          command,
        })),
        paneChildrenChecked: REAP_PANE_CHILDREN,
        paneChildren: panes.map(({ pane, paneCommand, treeKb, tree, rows: kids, keptRows }) => ({
          pane,
          paneCommand,
          treeKb,
          treeSize: tree.length,
          commands: kids.map((row) => row.command),
          keptCommands: keptRows.map((row) => row.command),
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
