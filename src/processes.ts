// What each live session is actually running, for GET /api/processes and the phone's view of it.
//
// The deck knows which tmux pane belongs to which session; nothing else on the Mac does. That map
// is the whole reason this lives here rather than being a `ps` a person runs: `ps` shows a flat
// list where a pane's tree looks like every other process, and the question being answered is
// "what has THIS agent left running".

import { execFile } from "node:child_process";
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
 * The pane's tree, breadth first so a child is always listed under the parent it belongs to.
 *
 * Cycles cannot happen in a process table, but a `seen` set is kept anyway: this walks data read
 * from a subprocess, and a malformed row must not be able to spin the event loop the deck serves on.
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
