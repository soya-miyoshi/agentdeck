import type { AgentSummary } from "../agent-profiles.ts";
import type { Session } from "../registry.ts";
import type { SessionState } from "../tmux.ts";

// The tab strip, as data. One tab per session, status per tab, and nothing the server did not
// say.
//
// The server's types are imported rather than restated. They are erased at build time, so this
// costs the bundle nothing, and the alternative - a second copy of the wire shapes maintained by
// hand - turns a protocol change into a silent disagreement instead of a typecheck error.

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
  exitCode?: number;
}

/**
 * Whether this session's agent has a working waiting mechanism.
 *
 * An agent the server has no summary for is treated as not detecting - a session can outlive the
 * profile that started it (the profiles file is editable and the server rereads it at start), and
 * the failure this direction is a missing indicator rather than a wrong one.
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
 * Build the strip.
 *
 * `detectsWaiting: false` is a supported configuration, not a defect. Such an agent reports only
 * working/idle/exited, so a `waiting` on one of its sessions is a claim nothing on the server is
 * in a position to make - it is displayed as `working`, which is what the process is in fact
 * doing, and never as a needs-you. Fewer states, never a wrong one.
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
    };
    if (session.exitCode !== undefined) tab.exitCode = session.exitCode;
    return tab;
  });
};

/**
 * Which tab to show after the list changed.
 *
 * Keeps the current one whenever it still exists, because the list is pushed and a session
 * appearing or exiting elsewhere must not move the pane the user is reading.
 */
export const selectTab = (
  tabs: readonly Tab[],
  current: string | undefined,
): string | undefined => {
  if (current !== undefined && tabs.some((tab) => tab.id === current)) return current;
  return tabs[0]?.id;
};
