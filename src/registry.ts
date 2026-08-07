import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { AgentProfile } from "./agent-profiles.ts";
import { spawnEnv } from "./agent-profiles.ts";
import type { CwdAllowlist } from "./cwds.ts";
import { sessionId, sessionName } from "./session-id.ts";
import type { SessionState, Tmux } from "./tmux.ts";

// The session registry: what the HTTP routes talk to.
//
// It holds no list of its own. Everything it reports is derived from what tmux currently has,
// because a registry that remembered sessions separately would be a second source of truth that
// has to keep agreeing with the first - and the whole reason session ids are a pure function of
// (path, agent) is so a restarted server can recognise what it finds rather than needing notes.

export interface Session {
  id: string;
  name: string;
  cwd: string;
  agent: string;
  state: SessionState;
  startedAt: number;
  exitCode?: number;
}

export interface CreateResult {
  session: Session;
  warning?: string;
}

export class CwdNotAllowedError extends Error {}
export class UnknownAgentError extends Error {}

/** Per-session secret for the hook route. Never the user's token - see plan 002. */
const newSecret = (): string => randomBytes(24).toString("base64url");

export class Registry {
  #tmux: Tmux;
  #profiles: ReadonlyMap<string, AgentProfile>;
  #allowlist: CwdAllowlist;

  // The only things the registry keeps in memory, and both are per-process by nature: a session's
  // cwd and agent cannot be read back out of tmux, and the secret must not be.
  #meta = new Map<string, { cwd: string; agent: string; secret: string }>();
  #states = new Map<string, SessionState>();

  constructor(tmux: Tmux, profiles: ReadonlyMap<string, AgentProfile>, allowlist: CwdAllowlist) {
    this.#tmux = tmux;
    this.#profiles = profiles;
    this.#allowlist = allowlist;
  }

  async create(rawCwd: string, agentId: string): Promise<CreateResult> {
    const cwd = resolve(rawCwd);
    if (!this.#allowlist.allows(cwd)) throw new CwdNotAllowedError(this.#allowlist.refusal(cwd));

    const profile = this.#profiles.get(agentId);
    if (profile === undefined) throw new UnknownAgentError(`no agent profile named ${agentId}`);

    const id = sessionId(cwd, agentId);

    // Read the neighbours BEFORE creating, so the warning can name what was already there. After
    // the call the new session is itself in the list and would have to be filtered out.
    const neighbours = (await this.list()).filter((s) => s.cwd === cwd && s.id !== id);

    const secret = this.#meta.get(id)?.secret ?? newSecret();
    const { attached } = await this.#tmux.createOrAttach(
      id,
      cwd,
      profile.command,
      profile.args,
      spawnEnv(profile, { AGENTDECK_SESSION_ID: id, AGENTDECK_SECRET: secret }),
    );

    this.#meta.set(id, { cwd, agent: agentId, secret });
    if (!attached) this.#states.set(id, "idle");

    const sessions = await this.list();
    const session = sessions.find((s) => s.id === id);
    if (session === undefined) {
      // tmux accepted the create and the session is not there. Better to say so than to
      // synthesise a Session object that claims something we did not observe.
      throw new Error(`session ${id} was created but tmux does not list it`);
    }

    return attached
      ? {
          session,
          warning:
            `A ${agentId} session was already running in ${cwd}; you are attached to it rather ` +
            `than to a new one.`,
        }
      : neighbours.length > 0
        ? {
            session,
            warning:
              `${neighbours.map((n) => n.agent).join(", ")} ${neighbours.length === 1 ? "is" : "are"} ` +
              `already running in ${cwd}. Two processes editing one working tree produce conflicts ` +
              `neither understands.`,
          }
        : { session };
  }

  /**
   * The sessions this server owns: what tmux holds, filtered to the cwd allowlist.
   *
   * The filter is here rather than only at the one caller that needed it, because the allowlist
   * is the only boundary left and a boundary that two callers apply differently is not one. The
   * tmux socket is `/tmp/tmux-<uid>/agentdeck`, writable by every process running as this user, so
   * `tmux -L agentdeck new-session -d -c / -- /bin/sh` is otherwise a tab the phone can type into,
   * created by something that asked nobody.
   *
   * A session whose cwd this process does not know - one started by hand, or one it created
   * before a restart, since `#meta` is memory only - has no `#meta` entry and is not allowlisted.
   * It is left alone: not listed, not attached, not reaped. That cost is deliberate and recorded
   * in plan 005.
   */
  async list(): Promise<Session[]> {
    const live = await this.#tmux.list();
    return live.flatMap((entry) => {
      // Dropping the entry and reading its metadata are one step, so there is no branch left in
      // which a listed session has no cwd, agent or name to report.
      const meta = this.#meta.get(entry.id);
      if (meta === undefined || !this.#allowlist.allows(meta.cwd)) return [];
      const session: Session = {
        id: entry.id,
        name: sessionName(meta.cwd),
        cwd: meta.cwd,
        agent: meta.agent,
        state: entry.dead ? "exited" : (this.#states.get(entry.id) ?? "idle"),
        startedAt: entry.startedAt,
      };
      if (entry.exitCode !== undefined) session.exitCode = entry.exitCode;
      return [session];
    });
  }

  async close(id: string): Promise<void> {
    await this.#tmux.kill(id);
    this.#meta.delete(id);
    this.#states.delete(id);
  }

  /** Reap dead sessions. Called at server start and on DELETE, never on a timer. */
  async reap(): Promise<string[]> {
    const dead = (await this.list()).filter((s) => s.state === "exited");
    for (const session of dead) await this.close(session.id);
    return dead.map((s) => s.id);
  }

  setState(id: string, state: SessionState): void {
    this.#states.set(id, state);
  }

  /** Constant-time-ish check that a hook call belongs to the session it claims. */
  secretMatches(id: string, presented: string): boolean {
    const secret = this.#meta.get(id)?.secret;
    if (secret === undefined || secret.length !== presented.length) return false;
    let diff = 0;
    for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ presented.charCodeAt(i);
    return diff === 0;
  }

  async sessionsByCwd(): Promise<Map<string, string[]>> {
    const byCwd = new Map<string, string[]>();
    for (const session of await this.list()) {
      if (session.cwd === "") continue;
      const existing = byCwd.get(session.cwd);
      if (existing === undefined) byCwd.set(session.cwd, [session.id]);
      else existing.push(session.id);
    }
    return byCwd;
  }
}
