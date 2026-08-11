// The deck collecting what its own sessions leave behind, on an interval, while it is running.
//
// The server is the gate on purpose: "reap while agentdeck is up" needs no launchd job, no install
// step and no second thing to remember to stop. When the deck is down nothing is collected, which is
// the behaviour asked for. Why it kills whole trees, and what it will not touch, are in
// scripts/reap.mjs and audit.md.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REAPER = fileURLToPath(new URL("../scripts/reap.mjs", import.meta.url));

/** Whether the pass ran, and the one line worth putting in the server's log. */
export interface ReapOutcome {
  ok: boolean;
  summary: string;
}

export type RunReaper = () => Promise<ReapOutcome>;

interface ReapReport {
  orphans?: { pid: number; treeKb: number; treeSize: number; command: string }[];
  emptyServers?: { pid: number }[];
  staleSockets?: number;
  reclaimedKb?: number;
  orphansChecked?: boolean;
}

/** One line from the reaper's JSON, or the raw output when it did not produce any. */
const summarise = (stdout: string, stderr: string, code: number | null): ReapOutcome => {
  if (code !== 0) {
    const detail = `${stderr}${stdout}`.trim().split("\n").slice(-2).join(" ");
    return { ok: false, summary: `the reaper exited ${String(code)}: ${detail}` };
  }
  let report: ReapReport;
  try {
    report = JSON.parse(stdout) as ReapReport;
  } catch {
    return { ok: false, summary: `the reaper printed no report: ${stdout.trim().slice(0, 200)}` };
  }
  const orphans = report.orphans ?? [];
  const trees = orphans.reduce((sum, entry) => sum + entry.treeSize, 0);
  const parts = [
    `${String(orphans.length)} orphan tree(s) (${String(trees)} process(es))`,
    `${String((report.emptyServers ?? []).length)} empty tmux server(s)`,
    `${String(report.staleSockets ?? 0)} dead socket file(s)`,
    `about ${String(Math.round((report.reclaimedKb ?? 0) / 1024))}MB`,
  ];
  // Silence when there was nothing to do; anything reaped is worth a line, because this kills
  // processes the operator did not personally decide about.
  if (orphans.length === 0 && (report.emptyServers ?? []).length === 0) {
    return { ok: true, summary: "" };
  }
  return { ok: true, summary: `reaped ${parts.join(", ")}` };
};

/** Spawns one real pass of the reaper, killing, reporting as JSON. */
export const runReaper =
  (env: NodeJS.ProcessEnv, script: string = REAPER): RunReaper =>
  async () =>
    await new Promise<ReapOutcome>((done) => {
      const child = spawn(process.execPath, [script, "--kill", "--json"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => {
        done({ ok: false, summary: `the reaper could not be started: ${error.message}` });
      });
      child.on("close", (code) => {
        done(summarise(stdout, stderr, code));
      });
    });

/**
 * Run the reaper every `intervalMs` until the returned function is called.
 *
 * Never two at once: a pass that outlives its own interval would otherwise stack up passes that
 * each signal the same pids, and the second one's "SURVIVED the kill" would be the first one's
 * grace period rather than a failure. Unref'd, so this timer alone never holds the process open.
 */
export const startReaping = (
  intervalMs: number,
  run: RunReaper,
  log: (line: string) => void,
): (() => void) => {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    run()
      .then((outcome) => {
        if (outcome.summary !== "") log(`agentdeck: ${outcome.summary}`);
      })
      .catch((error: unknown) => {
        log(`agentdeck: the reaper failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};
