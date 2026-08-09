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
  /**
   * True when this session was ADOPTED from tmux after a restart, so nothing here holds the
   * secret its agent was started with and its hook POSTs can never be authenticated again.
   *
   * The session is otherwise whole - listed, attachable, streamable - but `waiting` is the one
   * state it cannot reach, because the only mechanism that produces it is the hook route. It is on
   * the wire (plan 002) rather than kept here so the tab strip can say so; a tab that silently
   * never reports `waiting` again is a confidently wrong tab. m3/tab-strip owns showing it.
   */
  waitingDetectionLost?: true;
}

export interface CreateResult {
  session: Session;
  warning?: string;
}

export class CwdNotAllowedError extends Error {}
export class UnknownAgentError extends Error {}

/** Per-session secret for the hook route. Never the user's token - see plan 002. */
const newSecret = (): string => randomBytes(24).toString("base64url");

interface SessionMeta {
  cwd: string;
  agent: string;
  /** Absent for an adopted session: see `Registry.#adopt`. Nothing else may leave it unset. */
  secret?: string;
}

export class Registry {
  #tmux: Tmux;
  #profiles: ReadonlyMap<string, AgentProfile>;
  #allowlist: CwdAllowlist;

  // What the registry keeps in memory. `cwd` and `agent` are recoverable from tmux after a
  // restart (see `#adopt`); the secret is NOT, and must not be - which is why it is optional here
  // rather than always present. `secret: undefined` means "this session's hook path is dead", and
  // it is a state the code carries deliberately instead of papering over with a fresh secret the
  // running agent could never be told about.
  #meta = new Map<string, SessionMeta>();
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
    // socket. `#adopt` recovers such a corpse after a restart and `reap()` deliberately leaves it
    // alone, so it is still here when the next create arrives - and a corpse this process watched
    // exit can also outlive a reap, which is not run on a timer. Otherwise tmux would report `attached: true` and the phone would
    // get a 201 saying "a claude session was already running in <cwd>; you are attached to it rather than to
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

    const prior = this.#meta.get(id);
    const minted = prior?.secret ?? newSecret();
    // tmux reports session_created in whole seconds, so the window opens at the last second
    // boundary before the create rather than at this millisecond - otherwise a session created in
    // the same second reads as older than the call that made it and is never cleaned up.
    const startedAfter = Math.floor(Date.now() / 1000) * 1000;
    const { attached } = await this.#tmux.createOrAttach(
      id,
      cwd,
      profile.command,
      profile.args,
      spawnEnv(profile, { AGENTDECK_SESSION_ID: id, AGENTDECK_SECRET: minted }),
    );

    // Only a secret the AGENT actually received is recorded. `new-session -A` on an existing
    // session injects no environment, so on the attach path the running process keeps whatever it
    // was started with: the one this process minted before (`prior.secret`), or - for a session
    // adopted after a restart - one nothing here has. Recording the freshly minted secret in that
    // last case would make `secretMatches` compare against a string no one holds while the session
    // claimed a working hook path; the hooks are 401 either way, and this way the list says so.
    const carried = attached ? prior?.secret : minted;
    this.#meta.set(
      id,
      carried === undefined ? { cwd, agent: agentId } : { cwd, agent: agentId, secret: carried },
    );
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

    // The only warning left is the one that says the caller did not get what it asked for: a
    // second session of the SAME agent lands on the running one. A neighbouring session of a
    // different agent used to warn as well (plan 004); it was removed because the common
    // neighbour is a shell, which is the operator's own terminal rather than a second process
    // editing the tree, and the picker still shows what is live per directory before the choice.
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
   * Take back a session this call just created, when the rest of the call could not finish.
   *
   * Not `close()`: `close()` goes through `list()`, and the reason we are here is that `list()`
   * either threw or does not contain the session - so it would refuse the one kill that is
   * definitely ours to make. The id is `sessionId(cwd, agent)` for an allowlisted cwd and
   * `createOrAttach` reported it as newly created moments ago, which is the whole warrant.
   *
   * Best-effort: a kill that fails leaves the orphan, and the original failure is still the one
   * worth reporting.
   *
   * It kills the session this call started and refuses to kill anything else. `attached === false` is not on its own a warrant. It comes from a `has()` that ran BEFORE
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
   * A session with no `#meta` entry gets one chance to earn it, in `#adopt` below. A session that
   * does not - one started by hand under a name that is not `sessionId(its path, a configured
   * agent)`, or one at a path off the allowlist - is left alone: not listed, not attached, not
   * reaped. That cost is deliberate and recorded in plan 005.
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
      if (meta.secret === undefined) session.waitingDetectionLost = true;
      if (entry.exitCode !== undefined) session.exitCode = entry.exitCode;
      return [session];
    });
  }

  /**
   * Recover the metadata of a session that outlived the process which created it.
   *
   * The problem it solves: a `kill -9` takes `#meta` with it while tmux keeps every agent running,
   * so before this the survivor was invisible - `GET /api/sessions` answered `[]`, a client's
   * re-attach was answered `no session <id>`, and the tab stayed blank with the work still going
   * on behind it (m0/supervisor-crash-test measured exactly that).
   *
   * Nothing is written down to fix it, and nothing may be: there is no database and no sidecar
   * file by design (plan 001), and the tmux session environment is readable by any same-uid
   * process via `show-environment -t` (m0/host-boundary). So the recovery is arithmetic on what
   * tmux already reports. `#{session_path}` IS the cwd, and the id is `sessionId(cwd, agent)` - a
   * pure function - so the agent is whichever configured profile reproduces the id from that path.
   * That is a check, not a parse: a name whose middle segment merely looks like an agent does not
   * pass it, because the hash would not match.
   *
   * TWO THINGS ARE NOT RECOVERED, and both are stated rather than smoothed over:
   *
   *   the secret     Not recoverable, and a re-minted one never reaches the agent already
   *                  running - `new-session -A` injects no environment into a live session. So the
   *                  survivor's hook POSTs stay unauthenticated and `waiting` detection is dead for
   *                  that session until its AGENT is restarted, not merely the server. The session
   *                  says so on the wire as `waitingDetectionLost` (plan 002) instead of quietly
   *                  reporting working/idle forever.
   *   provenance     This cannot know that agentdeck started the session; only that a session at an
   *                  allowlisted path is named as one of ours would be. That is why the allowlist
   *                  check in `list()` runs on `#{session_path}` for adopted sessions exactly as it
   *                  does for remembered ones - adoption changes what may be listed, and must not
   *                  change WHERE. m0/host-boundary closed the hole where `Hub.sync()` attached to
   *                  anything on the socket; a session at `/` or anywhere else off the allowlist is
   *                  still not adopted, not attached and not streamed. What a same-uid process can
   *                  do is create a session INSIDE a directory the operator already pointed this
   *                  server at, under the derived name, and have it appear as a tab - the same
   *                  residual the allowlist has always had, since it is a filter on where a session
   *                  is rather than a claim about who made it (plan 005).
   */
  #adopt(id: string, path: string): SessionMeta | undefined {
    if (path === "" || !this.#allowlist.allows(path)) return undefined;
    for (const agent of this.#profiles.keys()) {
      if (sessionId(path, agent) !== id) continue;
      const meta: SessionMeta = { cwd: path, agent };
      this.#meta.set(id, meta);
      // Say so, every time. Adoption is arithmetic on what tmux reports and cannot establish that
      // WE created the session - `sessionId(cwd, agent)` is a pure function of two values any
      // client reads from `GET /api/cwds` and `GET /api/agents`, so anything running as this user
      // can put a session on the socket under the name we would derive, and it becomes a tab the
      // operator streams and types into. Provenance would need something written down, which plan
      // 001 forecloses; what is available instead is visibility. An adoption during the first
      // seconds after a restart is the expected case; one at any other time is not, and the log is
      // the only place that difference can be seen.
      console.error(
        `agentdeck: adopted session ${id} at ${path} - this process has no record of creating it, ` +
          `and its hook secret is gone, so it will not report waiting until its agent restarts`,
      );
      return meta;
    }
    return undefined;
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

  /**
   * Reap the corpses THIS process left. Called at server start, never on a timer.
   *
   * Scoped to sessions with a recorded secret, which is exactly the set this process started and
   * watched exit. An adopted corpse - one whose agent died while the server was down - has no
   * secret (see `#adopt`), and killing it would destroy the pane whose scrollback and `exited N`
   * are the only remaining answer to "did it finish, or did I lose it". That is the question
   * reaping at start rather than on a timer exists to keep answerable, so an adopted corpse stays
   * listed as `exited` with its code until a human closes it.
   */
  async reap(): Promise<string[]> {
    const dead = (await this.list()).filter(
      (s) => s.state === "exited" && this.#meta.get(s.id)?.secret !== undefined,
    );
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
