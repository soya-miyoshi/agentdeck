import { createHmac } from "node:crypto";
import { resolve } from "node:path";

import type { AgentProfile } from "./agent-profiles.ts";
import { spawnEnv } from "./agent-profiles.ts";
import type { CwdAllowlist } from "./cwds.ts";
import { sessionId, sessionName } from "./session-id.ts";
import type { SessionState, Tmux } from "./tmux.ts";

// The session registry: what the HTTP routes talk to. It holds no list of its own - everything is
// derived from what tmux has, so a restarted server recognises what it finds rather than needing notes.

export interface Session {
  id: string;
  name: string;
  cwd: string;
  agent: string;
  state: SessionState;
  startedAt: number;
  exitCode?: number;
  /**
   * True when this session's hooks are refused, so `waiting` is the one state it cannot reach.
   * Detected from a refused hook rather than assumed, and on the wire so the strip can say `muted`.
   */
  waitingDetectionLost?: true;
}

export interface CreateResult {
  session: Session;
  warning?: string;
}

export class CwdNotAllowedError extends Error {}
export class UnknownAgentError extends Error {}

/**
 * A session's hook secret, DERIVED rather than minted, so a restarted server recomputes what the
 * running agent already holds. The key is the bearer token; the residual is in audit.md.
 */
export const secretFor = (key: string, id: string): string =>
  createHmac("sha256", key).update(id).digest("base64url");

interface SessionMeta {
  cwd: string;
  agent: string;
  secret: string;
  /**
   * Whether THIS process created the session, rather than adopting one that outlived a restart.
   * Its own field because the secret is always present now, and `reap()` used to ask about that.
   */
  startedHere: boolean;
}

export class Registry {
  #tmux: Tmux;
  #profiles: ReadonlyMap<string, AgentProfile>;
  #allowlist: CwdAllowlist;
  #secretKey: string;

  // What the registry keeps in memory. All recoverable after a restart: `cwd` and `agent` from what
  // tmux reports (see `#adopt`), the secret by derivation.
  #meta = new Map<string, SessionMeta>();
  #states = new Map<string, SessionState>();
  // Sessions whose agent presented a secret that does not match the derived one, so their hooks are
  // 401 and they never report `waiting`. Bounded by the session set, cleared when a session goes.
  #deaf = new Set<string>();

  constructor(
    tmux: Tmux,
    profiles: ReadonlyMap<string, AgentProfile>,
    allowlist: CwdAllowlist,
    secretKey: string,
  ) {
    this.#tmux = tmux;
    this.#profiles = profiles;
    this.#allowlist = allowlist;
    if (secretKey === "") {
      // An empty key would derive one predictable secret per session id for every deck on earth,
      // and the failure is invisible: hooks would keep working. Refused at construction instead.
      throw new Error(
        "Registry needs a non-empty secret key; it derives every hook secret from it",
      );
    }
    this.#secretKey = secretKey;
  }

  async create(rawCwd: string, agentId: string): Promise<CreateResult> {
    const cwd = resolve(rawCwd);
    if (!this.#allowlist.allows(cwd)) throw new CwdNotAllowedError(this.#allowlist.refusal(cwd));

    const profile = this.#profiles.get(agentId);
    if (profile === undefined) throw new UnknownAgentError(`no agent profile named ${agentId}`);

    const id = sessionId(cwd, agentId);

    // A corpse under our own id would make `createOrAttach` report `attached: true`, so the 201
    // would claim an agent is running while the tab sits at `exited`. Only a DEAD pane at this cwd.
    const existing = (await this.#tmux.list()).find((entry) => entry.id === id);
    if (existing?.dead === true && existing.path === cwd) {
      await this.#tmux.kill(id);
      this.#meta.delete(id);
      this.#states.delete(id);
    }

    const secret = secretFor(this.#secretKey, id);
    // tmux reports session_created in whole seconds, so the window opens at the last second
    // boundary: otherwise a session made in this same second reads as older than the call.
    const startedAfter = Math.floor(Date.now() / 1000) * 1000;
    const { attached } = await this.#tmux.createOrAttach(
      id,
      cwd,
      profile.command,
      profile.args,
      spawnEnv(profile, { AGENTDECK_SESSION_ID: id, AGENTDECK_SECRET: secret }),
    );

    // The same value either way: `-A` injects no environment, but the running agent was started
    // from the same key and id. `startedHere` is false on the attach path - `reap()` must not take it.
    this.#meta.set(id, { cwd, agent: agentId, secret, startedHere: !attached });
    if (!attached) this.#states.set(id, "idle");

    // Everything after the create either produces the 201 or undoes it, so no failure leaves an
    // agent nobody was told about. Only a session THIS call started is ever killed.
    let session: Session | undefined;
    try {
      session = (await this.list()).find((s) => s.id === id);
    } catch (error) {
      if (!attached) await this.#undoCreate(id, cwd, startedAfter);
      throw error;
    }
    if (session === undefined) {
      // tmux accepted the create and the session is not there. Better to say so than to synthesise
      // a Session claiming something nobody observed.
      if (!attached) await this.#undoCreate(id, cwd, startedAfter);
      throw new Error(`session ${id} was created but tmux does not list it`);
    }

    // The only warning left is "you did not get what you asked for": a second session of the SAME
    // agent lands on the running one. A different agent next door no longer warns (plan 004).
    return attached
      ? {
          session,
          warning:
            `A ${agentId} session was already running in ${cwd}; you are attached to it rather ` +
            `than to a new one.`,
        }
      : { session };
  }

  /**
   * Take back a session this call just created, when the rest of it could not finish. Conditional
   * on what tmux reports AFTER the create: `attached === false` alone would kill a running agent.
   */
  async #undoCreate(id: string, cwd: string, startedAfter: number): Promise<void> {
    const ours = await this.#tmux.describe(id);
    this.#meta.delete(id);
    this.#states.delete(id);
    this.#deaf.delete(id);
    // Cannot confirm, so do not act: an orphan is adoptable, and a killed agent's work is not.
    if (ours === undefined || ours.path !== cwd || ours.startedAt < startedAfter) return;
    await this.#tmux.kill(id).catch(() => undefined);
  }

  /**
   * The sessions this server owns: what tmux holds, filtered against `#{session_path}` - where TMUX
   * says a session is, not a remembered name. A filter on WHERE, never a claim about who made it.
   */
  async list(): Promise<Session[]> {
    const live = await this.#tmux.list();
    return live.flatMap((entry) => {
      // Dropping the entry and reading its metadata are one step, so no listed session can be
      // missing its cwd, agent or name.
      const meta = this.#meta.get(entry.id) ?? this.#adopt(entry.id, entry.path);
      if (meta === undefined) return [];
      if (!this.#allowlist.allows(entry.path) || entry.path !== meta.cwd) return [];
      const session: Session = {
        id: entry.id,
        name: sessionName(entry.path),
        cwd: entry.path,
        agent: meta.agent,
        state: entry.dead ? "exited" : (this.#states.get(entry.id) ?? "idle"),
        startedAt: entry.startedAt,
      };
      // Adoption no longer sets this - the secret is derived. What does is a hook arriving with a
      // secret that does not match, which is the one case derivation cannot reach.
      if (this.#deaf.has(entry.id)) session.waitingDetectionLost = true;
      if (entry.exitCode !== undefined) session.exitCode = entry.exitCode;
      return [session];
    });
  }

  /**
   * Recover the metadata of a session that outlived its creator: the agent is whichever profile
   * reproduces the id from `#{session_path}`. Provenance is NOT recovered (plan 005).
   */
  #adopt(id: string, path: string): SessionMeta | undefined {
    if (path === "" || !this.#allowlist.allows(path)) return undefined;
    for (const agent of this.#profiles.keys()) {
      if (sessionId(path, agent) !== id) continue;
      // The secret comes back by derivation, which is what stops a restart muting every tab.
      // `startedHere` is false: `reap()` must keep its hands off an adopted corpse.
      const meta: SessionMeta = {
        cwd: path,
        agent,
        secret: secretFor(this.#secretKey, id),
        startedHere: false,
      };
      this.#meta.set(id, meta);
      // Said every time, because provenance would need something written down and visibility is
      // what is available instead: adoption seconds after a restart is expected, later is not.
      console.error(
        `agentdeck: adopted session ${id} at ${path} - this process has no record of creating it. ` +
          `Its hook secret is derived, so waiting detection comes back with it.`,
      );
      return meta;
    }
    return undefined;
  }

  /**
   * Kill one of OUR sessions and nothing else. The id is a raw path segment from the route, so it
   * goes through the same allowlist-filtered `list()` first or the boundary would be one-way.
   */
  async close(id: string): Promise<void> {
    const ours = (await this.list()).some((session) => session.id === id);
    if (!ours) return;
    await this.#tmux.kill(id);
    this.#meta.delete(id);
    this.#states.delete(id);
    this.#deaf.delete(id);
  }

  /**
   * Reap the corpses THIS process left, at server start and never on a timer. An adopted corpse
   * stays: its scrollback and `exited N` are the only answer left to "did it finish, or did I lose it".
   */
  async reap(): Promise<string[]> {
    const dead = (await this.list()).filter(
      (s) => s.state === "exited" && this.#meta.get(s.id)?.startedHere === true,
    );
    for (const session of dead) await this.close(session.id);
    return dead.map((s) => s.id);
  }

  setState(id: string, state: SessionState): void {
    this.#states.set(id, state);
  }

  /**
   * Constant-time-ish check that a hook call belongs to the session it claims. A mismatch marks the
   * session deaf, so the strip says `muted` rather than looking healthy while every hook is refused.
   */
  secretMatches(id: string, presented: string): boolean {
    const secret = this.#meta.get(id)?.secret;
    if (secret === undefined) return false;
    if (secret.length !== presented.length) {
      this.#deaf.add(id);
      return false;
    }
    let diff = 0;
    for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ presented.charCodeAt(i);
    if (diff !== 0) this.#deaf.add(id);
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
