import type { AgentSummary } from "../agent-profiles.ts";
import type { Cwd } from "../cwds.ts";

// The new-session picker, as data. Plan 002: the client cannot construct a valid `cwd` on its own,
// so a directory and an agent are both chosen from what the server reported and neither is typed.

export interface DirectoryChoice {
  path: string;
  name: string;
  /** Ids of live sessions already here, so the two-in-one-tree case is visible before creating. */
  sessions: string[];
  note?: string;
}

export interface AgentChoice {
  id: string;
  name: string;
  /** False means starting it is refused here rather than by a tab that dies instantly. */
  selectable: boolean;
  note?: string;
}

/** The allowlist as offerable directories, with the neighbours plan 002 wants shown before create. */
export const directoryChoices = (cwds: readonly Cwd[]): DirectoryChoice[] =>
  cwds.map((cwd) => {
    const choice: DirectoryChoice = { path: cwd.path, name: cwd.name, sessions: [...cwd.sessions] };
    if (cwd.sessions.length > 0) {
      choice.note = `${String(cwd.sessions.length)} already running here`;
    }
    return choice;
  });

/**
 * The profiles as offerable agents: one whose command does not resolve is offered disabled with the
 * reason rather than hidden, said in full because this is a list read once, with room.
 */
export const agentChoices = (agents: readonly AgentSummary[]): AgentChoice[] =>
  agents.map((agent) => {
    const choice: AgentChoice = { id: agent.id, name: agent.name, selectable: agent.available };
    if (!agent.available) choice.note = "not on PATH on the Mac; it cannot be started";
    else if (!agent.detectsWaiting) choice.note = "no waiting alerts";
    return choice;
  });

/** Whether Start may be pressed. An unselectable agent can never be the one a session starts with. */
export const canStart = (
  directories: readonly DirectoryChoice[],
  agents: readonly AgentChoice[],
  cwd: string | undefined,
  agentId: string | undefined,
): boolean =>
  directories.some((d) => d.path === cwd) && agents.some((a) => a.id === agentId && a.selectable);
