// What each live session is actually running. Here rather than a `ps` someone runs, because only
// the deck knows which pane belongs to which session, and `ps` shows one flat list.

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const PS = "/bin/ps";
const READ_TIMEOUT_MS = 5000;

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Seconds since it started, as `ps` reports it - whole seconds, so a new process reads 0. */
  ageSeconds: number;
  rssKb: number;
  cpuPercent: number;
  command: string;
  /** How far below the pane it sits; the pane process itself is 0. */
  depth: number;
}

export interface SessionProcesses {
  sessionId: string;
  panePid: number;
  /** The pane's own tree, pane first, then its descendants in discovery order. */
  processes: ProcessRow[];
  /** Everything below the pane, which is what a session has accumulated rather than what it is. */
  childCount: number;
  childRssKb: number;
}

/** `[[dd-]hh:]mm:ss` as seconds, or -1 when `ps` printed something this cannot read. */
export const parseEtime = (etime: string): number => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (match === null) return -1;
  const [, days, hours, minutes, seconds] = match;
  return (
    (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
};

type RawRow = Omit<ProcessRow, "depth">;

/** One `ps` for the whole machine. Per-pid calls do not scale and this runs on a phone's tap. */
export const readProcessTable = async (
  exec: (file: string, args: string[]) => Promise<{ stdout: string }> = (file, args) =>
    run(file, args, { timeout: READ_TIMEOUT_MS }),
): Promise<RawRow[]> => {
  let stdout = "";
  try {
    ({ stdout } = await exec(PS, ["-Ao", "pid=,ppid=,etime=,rss=,pcpu=,command="]));
  } catch {
    // A machine that cannot be asked reports nothing rather than failing the route.
    return [];
  }
  const rows: RawRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ageSeconds: parseEtime(match[3] ?? ""),
      rssKb: Number(match[4]),
      cpuPercent: Number(match[5]) || 0,
      command: match[6] ?? "",
    });
  }
  return rows;
};

/**
 * The pane's tree, breadth first so a child is listed under its parent. The `seen` set is kept even
 * though a process table has no cycles: this walks a subprocess's output, which could be malformed.
 */
export const treeOf = (rows: readonly RawRow[], panePid: number): ProcessRow[] => {
  const children = new Map<number, RawRow[]>();
  const byPid = new Map<number, RawRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const kin = children.get(row.ppid) ?? [];
    kin.push(row);
    children.set(row.ppid, kin);
  }
  const pane = byPid.get(panePid);
  if (pane === undefined) return [];
  const out: ProcessRow[] = [{ ...pane, depth: 0 }];
  const seen = new Set<number>([panePid]);
  const queue: { row: RawRow; depth: number }[] = [{ row: pane, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const child of children.get(next.row.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ ...child, depth: next.depth + 1 });
      queue.push({ row: child, depth: next.depth + 1 });
    }
  }
  return out;
};

/** A pid's process state as `ps` reports it, or "" when it cannot be read. `Z` is a zombie. */
const psState = (pid: number): string => {
  const probe = spawnSync(PS, ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return (probe.stdout || "").trim();
};

/** Whether a pid is finished, counting a zombie as finished: `kill(pid, 0)` succeeds against one. */
const finished = (pid: number, state: (pid: number) => string): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  return state(pid).startsWith("Z");
};

export interface EndTreeOptions {
  /** How long SIGTERM is given before SIGKILL. */
  graceMs?: number;
  /** Swapped in tests; the real one asks `ps`. */
  state?: (pid: number) => string;
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  wait?: (ms: number) => Promise<void>;
}

/**
 * SIGTERM then SIGKILL every pid, DEEPEST FIRST so a supervisor cannot restart a child before its
 * own turn. The caller collects the pids first: once the pane is gone, so is the tree naming them.
 */
export const endTree = async (
  pids: readonly number[],
  options: EndTreeOptions = {},
): Promise<number[]> => {
  const graceMs = options.graceMs ?? 3000;
  const state = options.state ?? psState;
  const signal = options.signal ?? ((pid, sig) => process.kill(pid, sig));
  const wait = options.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const targets = [...pids].reverse().filter((pid) => Number.isInteger(pid) && pid > 1);
  const pending: number[] = [];
  for (const pid of targets) {
    if (finished(pid, state)) continue;
    try {
      signal(pid, "SIGTERM");
      pending.push(pid);
    } catch {
      // Gone between the check and the signal is the outcome wanted.
    }
  }
  if (pending.length === 0) return [];
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pending.some((pid) => !finished(pid, state))) {
    await wait(100);
  }
  const survivors: number[] = [];
  for (const pid of pending) {
    if (finished(pid, state)) continue;
    try {
      signal(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    if (!finished(pid, state)) survivors.push(pid);
  }
  return survivors;
};

export interface PaneRef {
  sessionId: string;
  panePid: number;
}

/** Each live session's pane tree, in the order the panes were given. */
export const sessionProcesses = async (
  panes: readonly PaneRef[],
  read: () => Promise<RawRow[]> = readProcessTable,
): Promise<SessionProcesses[]> => {
  if (panes.length === 0) return [];
  const rows = await read();
  return panes.map(({ sessionId, panePid }) => {
    const processes = treeOf(rows, panePid);
    const kids = processes.filter((row) => row.depth > 0);
    return {
      sessionId,
      panePid,
      processes,
      childCount: kids.length,
      childRssKb: kids.reduce((sum, row) => sum + row.rssKb, 0),
    };
  });
};
