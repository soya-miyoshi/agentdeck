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

    // A dead session under our own id, left by a previous run, otherwise makes this a lie.
    // `createOrAttach` sets `remain-on-exit on`, so a session whose agent exited stays on the
    // socket; `#meta` is memory only, so after a restart `list()` cannot see it and `reap()` at
    // boot cannot clear it. tmux would then report `attached: true` and the phone would get a 201
    // saying "a claude session was already running in <cwd>; you are attached to it rather than to
    // a new one" - false, with a tab pinned at `exited` and no agent started. A tab that is
    // confidently wrong is the one output this design refuses, so the corpse goes first.
    //
    // Scoped deliberately: `id` is `sessionId(cwd, agent)` for a cwd already checked against the
    // allowlist above, and the pane must be dead. A live session is left to `createOrAttach`,
    // and a session at any other path is not ours to touch.
    const existing = (await this.#tmux.list()).find((entry) => entry.id === id);
    if (existing?.dead === true && existing.path === cwd) {
      await this.#tmux.kill(id);
      this.#meta.delete(id);
      this.#states.delete(id);
    }

    // Read the neighbours BEFORE creating, so the warning can name what was already there. After
    // the call the new session is itself in the list and would have to be filtered out.
    const neighbours = (await this.list()).filter((s) => s.cwd === cwd && s.id !== id);

    const secret = this.#meta.get(id)?.secret ?? newSecret();
    // tmux reports session_created in whole seconds, so the window opens at the last second
    // boundary before the create rather than at this millisecond - otherwise a session created in
    // the same second reads as older than the call that made it and is never cleaned up.
    const startedAfter = Math.floor(Date.now() / 1000) * 1000;
    const { attached } = await this.#tmux.createOrAttach(
      id,
      cwd,
      profile.command,
      profile.args,
      spawnEnv(profile, { AGENTDECK_SESSION_ID: id, AGENTDECK_SECRET: secret }),
    );

    this.#meta.set(id, { cwd, agent: agentId, secret });
    if (!attached) this.#states.set(id, "idle");

    // Everything after the create either produces the 201 or undoes the create. Before
    // m0/create-500 this block could throw - and did, on every real server run, because
    // `Tmux.list()` was parsing mangled output (see `baseEnv`) - leaving the caller with a 500 and
    // the machine with an agent nobody had been told about. The parse bug is fixed at its cause;
    // this is the property that makes ANY later failure survivable rather than that one.
    //
    // Only a session THIS call started is killed. `attached: true` means the agent was already
    // running and was somebody else's work before this request existed.
    let session: Session | undefined;
    try {
      session = (await this.list()).find((s) => s.id === id);
    } catch (error) {
      if (!attached) await this.#undoCreate(id, cwd, startedAfter);
      throw error;
    }
    if (session === undefined) {
      // tmux accepted the create and the session is not there. Better to say so than to
      // synthesise a Session object that claims something we did not observe.
      if (!attached) await this.#undoCreate(id, cwd, startedAfter);
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
   * Take back a session this call just created, when the rest of the call could not finish.
   *
   * Not `close()`: `close()` goes through `list()`, and the reason we are here is that `list()`
   * either threw or does not contain the session - so it would refuse the one kill that is
   * definitely ours to make. The id is `sessionId(cwd, agent)` for an allowlisted cwd and
   * `createOrAttach` reported it as newly created moments ago, which is the whole warrant.
   *
   * Best-effort: a kill that fails leaves the orphan, and the original failure is still the one
   * worth reporting.
   */
  /**
   * Kill the session this call started, and refuse to kill anything else.
   *
   * `attached === false` is not on its own a warrant. It comes from a `has()` that ran BEFORE
   * `new-session -A`, and the name is `sessionId(cwd, agent)` - a pure function of two values any
   * client reads from `GET /api/cwds` and `GET /api/agents`, and any same-uid process can compute
   * offline. Something that creates that name inside the window makes `-A` attach to ITS session
   * while `attached` still reports false.
   *
   * The non-adversarial half is worse because it needs no attacker: when the post-create `list()`
   * fails transiently, the agent that was just started would be killed. Before this branch it
   * survived and a retry adopted it with the "already running" warning, so a transient failure was
   * self-healing. Undoing on any thrown error made it destructive - and what it destroys is a
   * running agent's work, which is the one thing this design says survives.
   *
   * So the kill is conditional on something observed AFTER the create: tmux must still report the
   * session at the cwd this call passed, and report it as started within the window this call has
   * been running. Anything else is left alone and reported.
   */
  async #undoCreate(id: string, cwd: string, startedAfter: number): Promise<void> {
    const ours = await this.#tmux.describe(id);
    this.#meta.delete(id);
    this.#states.delete(id);
    // Cannot confirm, so do not act. An orphan is visible on the socket and adoptable; a killed
    // agent's work is not recoverable, so the two failures are not equally bad.
    if (ours === undefined || ours.path !== cwd || ours.startedAt < startedAfter) return;
    await this.#tmux.kill(id).catch(() => undefined);
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
   *
   * What is enforced, stated exactly, because the previous wording claimed more than the code did:
   * the allowlist is matched against `#{session_path}` - where TMUX says the session is - and the
   * remembered cwd must agree with it. Matching against `#meta` alone was enforcement against a
   * remembered NAME, and the name is `sessionId(cwd, agent)`, a pure function of two knowable
   * things. Anything running as this user could kill `repo-claude-1a2b3c4d` and recreate it with
   * `-c /`, and within one sync the shell in `/` was a tab, reported as being in the allowlisted
   * repository. A same-uid process still owns the socket, so this is a filter on where a session
   * is, not a claim that agentdeck started it.
   */
  async list(): Promise<Session[]> {
    const live = await this.#tmux.list();
    return live.flatMap((entry) => {
      // Dropping the entry and reading its metadata are one step, so there is no branch left in
      // which a listed session has no cwd, agent or name to report.
      const meta = this.#meta.get(entry.id);
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
      if (entry.exitCode !== undefined) session.exitCode = entry.exitCode;
      return [session];
    });
  }

  /**
   * Kill one of OUR sessions, and nothing else.
   *
   * The id arrives as a raw path segment from `DELETE /api/sessions/:id`, so it goes through the
   * same allowlist-filtered `list()` as everything else first. Without that, the boundary was
   * one-way: a session this class refuses to list, attach or reap - the one a human started by
   * hand under the same socket - was still killable, along with everything running in it.
   */
  async close(id: string): Promise<void> {
    const ours = (await this.list()).some((session) => session.id === id);
    if (!ours) return;
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
