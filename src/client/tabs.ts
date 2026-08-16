import type { AgentSummary } from "../agent-profiles.ts";
import type { Session } from "../registry.ts";
import type { SessionState } from "../tmux.ts";

// The tab strip as data: one tab per session, and nothing the server did not say. The server's
// types are imported rather than restated - they erase at build time, and a copy would drift.

export interface Tab {
  id: string;
  name: string;
  agent: string;
  state: SessionState;
  /** What the status pill says. An exited tab shows its code, because that is the answer to
   * "did it finish, or did I lose it". */
  status: string;
  /** Whether to draw the needs-you indicator. Never true for an agent that cannot detect it. */
  needsYou: boolean;
  /**
   * This session's hooks are refused, so it can never report `waiting` (plan 002). The tab says so:
   * one that quietly stops is indistinguishable from an agent that is simply still working.
   */
  waitingDetectionLost: boolean;
  exitCode?: number;
}

/**
 * Whether this session's agent has a working waiting mechanism. An unknown agent counts as not
 * detecting: a session can outlive its profile, and a missing indicator beats a wrong one.
 */
const detectsWaiting = (agents: ReadonlyMap<string, AgentSummary>, agentId: string): boolean =>
  agents.get(agentId)?.detectsWaiting ?? false;

const statusOf = (state: SessionState, exitCode: number | undefined): string => {
  if (state !== "exited") return state;
  // A dead pane whose status tmux could not read. "exited" alone is still the true statement;
  // inventing a 0 would be a confidently wrong one.
  return exitCode === undefined ? "exited" : `exited ${String(exitCode)}`;
};

/**
 * Build the strip. `detectsWaiting: false` is supported rather than a defect: a `waiting` from such
 * an agent is a claim nobody can make, so it shows as `working`. Fewer states, never a wrong one.
 */
export const toTabs = (sessions: readonly Session[], agents: readonly AgentSummary[]): Tab[] => {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return sessions.map((session) => {
    const detects = detectsWaiting(byId, session.agent);
    const state: SessionState = session.state === "waiting" && !detects ? "working" : session.state;
    const tab: Tab = {
      id: session.id,
      name: session.name,
      agent: session.agent,
      state,
      status: statusOf(state, session.exitCode),
      needsYou: state === "waiting",
      // Only for an agent that would otherwise detect waiting, and only while it runs: otherwise
      // it is noise on every shell tab, or an answer about a process that has finished.
      waitingDetectionLost: session.waitingDetectionLost === true && detects && state !== "exited",
    };
    if (session.exitCode !== undefined) tab.exitCode = session.exitCode;
    return tab;
  });
};

/**
 * Which tab to show after the list changed: the current one whenever it still exists, because the
 * list is pushed and a session appearing elsewhere must not move the pane being read.
 */
export const selectTab = (
  tabs: readonly Tab[],
  current: string | undefined,
): string | undefined => {
  if (current !== undefined && tabs.some((tab) => tab.id === current)) return current;
  return tabs[0]?.id;
};
