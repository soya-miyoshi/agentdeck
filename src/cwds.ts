import { basename, resolve } from "node:path";

// One list with two jobs: the `cwd` allowlist that POST /api/sessions validates against, and what
// GET /api/cwds serves to the phone's new-session picker. It comes from AGENTDECK_MOUNTS, whose
// name is older than the decision to run on the Mac directly.
//
// GET /api/cwds exists because the client cannot construct a valid `cwd` on its own. The
// allowlist is knowable only to the server, and a phone user typing an absolute path into a soft
// keyboard is not a design.

export interface Cwd {
  path: string;
  name: string;
  /** Ids of live sessions already in this directory, so the picker can warn before creating. */
  sessions: string[];
}

export class CwdAllowlist {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    // Normalised once here so every comparison downstream is between canonical absolute paths.
    // Comparing raw strings would let `/workspace/repo/` and `/workspace/repo` disagree.
    this.paths = paths.map((p) => resolve(p));
  }

  /**
   * Exact membership, never prefix membership.
   *
   * A prefix test would accept `/workspace/agentdeck/../../etc`, and resolving first is not
   * enough on its own: `/workspace/agentdeck-secrets` also starts with an allowed path. The list
   * names the repositories chosen, and only those are startable.
   */
  allows(cwd: string): boolean {
    return this.paths.includes(resolve(cwd));
  }

  /**
   * The refusal a person meets most often, so it says what would have to change rather than 403.
   *
   * A repository cloned since the server started is not on the list and cannot be until it is
   * restarted - so the sentence names the variable to edit and says what the restart actually
   * costs. tmux keeps the sessions, but the registry keeps their cwd, agent and per-session hook
   * secret in memory only (src/registry.ts), so a surviving session comes back nameless and its
   * hook POSTs 401 for the rest of its life: it stops reporting `waiting`. Understating that is
   * how someone restarts casually and loses the one thing the phone is for.
   */
  refusal(cwd: string): string {
    return (
      `${resolve(cwd)} is not on the allowlist, so no session can start there. ` +
      `Add it to AGENTDECK_MOUNTS and restart agentdeck - tmux keeps the running sessions across ` +
      `that restart, but their directory, agent and waiting detection do not survive it: ` +
      `sessions that were already running come back unnamed and stop reporting when they need ` +
      `you, until they are recreated. Currently allowed: ` +
      `${this.paths.join(", ")}`
    );
  }

  /** What GET /api/cwds serves: the list, with the live sessions in each. */
  list(sessionsByCwd: ReadonlyMap<string, string[]>): Cwd[] {
    return this.paths.map((path) => ({
      path,
      name: basename(path),
      sessions: [...(sessionsByCwd.get(path) ?? [])],
    }));
  }
}
