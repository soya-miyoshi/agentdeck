import { basename, dirname, join, resolve } from "node:path";

import { scanRepos } from "./repo-scan.ts";

// One list with two jobs: the `cwd` allowlist that POST /api/sessions validates against, and what
// GET /api/cwds serves to the phone's new-session picker. It has two sources: AGENTDECK_MOUNTS,
// whose name is older than the decision to run on the Mac directly, and AGENTDECK_ROOTS, which
// names directories to scan for repositories every time the list is read.
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

/** How long a scan is reused. The registry re-filters every live session against this list every
 *  two seconds, so without it the walk runs once per session per sync. */
const SCAN_TTL_MS = 1000;

export interface AllowlistOptions {
  /** Swapped in tests; the real one walks the filesystem. */
  scan?: (roots: readonly string[]) => readonly string[];
  ttlMs?: number;
}

export class CwdAllowlist {
  readonly #mounts: readonly string[];
  readonly #roots: readonly string[];
  readonly #scan: (roots: readonly string[]) => readonly string[];
  readonly #ttlMs: number;
  #scanned: readonly string[] = [];
  #scannedAt = -Infinity;

  constructor(
    paths: readonly string[],
    roots: readonly string[] = [],
    options: AllowlistOptions = {},
  ) {
    // Normalised once here so every comparison downstream is between canonical absolute paths.
    // Comparing raw strings would let `/workspace/repo/` and `/workspace/repo` disagree.
    this.#mounts = paths.map((p) => resolve(p));
    this.#roots = roots.map((p) => resolve(p));
    this.#scan = options.scan ?? scanRepos;
    this.#ttlMs = options.ttlMs ?? SCAN_TTL_MS;
  }

  /** The roots themselves, which are containment ancestors rather than startable directories. */
  get roots(): readonly string[] {
    return this.#roots;
  }

  /**
   * The allowlist as it is right now: the fixed entries plus whatever the roots hold this second.
   *
   * Read afresh rather than captured at boot, which is the whole point of the roots: a repository
   * cloned a moment ago is startable at the next tap of `New session`, with no restart and so no
   * loss of any running agent's hook secret.
   */
  get paths(): readonly string[] {
    if (this.#roots.length === 0) return this.#mounts;
    const now = Date.now();
    if (now - this.#scannedAt >= this.#ttlMs) {
      this.#scanned = this.#scan(this.#roots).map((p) => resolve(p));
      this.#scannedAt = now;
    }
    return [...new Set([...this.#mounts, ...this.#scanned])];
  }

  /**
   * Exact membership, never prefix membership.
   *
   * A prefix test would accept `/workspace/agentdeck/../../etc`, and resolving first is not
   * enough on its own: `/workspace/agentdeck-secrets` also starts with an allowed path. The list
   * names the repositories chosen, and only those are startable.
   */
  allows(cwd: string): boolean {
    // The empty string is "we do not know where this session is", which is what a session started
    // by hand or one that outlived the process that created it reports. It must never be allowed,
    // and it would be: `resolve("")` is the server's own working directory, so a server started
    // inside an allowlisted repository would silently adopt every unknown session on the socket.
    if (cwd === "") return false;
    return this.paths.includes(resolve(cwd));
  }

  /**
   * The refusal a person meets most often, so it says what would have to change rather than 403.
   *
   * Two ways out, and they do not cost the same. A clone under a root is free and immediate; an
   * AGENTDECK_MOUNTS entry needs a restart. That restart used to cost every running session its
   * `waiting` alerts - the hook secret was minted at random and could not be handed to a process
   * already running - and this sentence existed to stop someone paying it casually. The secret is
   * derived now, so the cost is a reconnect and nothing else. Said plainly rather than left as the
   * old warning, because a refusal that overstates the price is as misleading as one that
   * understates it.
   */
  refusal(cwd: string): string {
    const free =
      this.#roots.length === 0
        ? ""
        : `Clone it under one of ${this.#roots.join(", ")} and it is startable at the next tap of ` +
          `New session, with no restart. Otherwise: `;
    return (
      `${resolve(cwd)} is not on the allowlist, so no session can start there. ${free}` +
      `Add it to AGENTDECK_MOUNTS and restart agentdeck - tmux keeps the running agents across ` +
      `that restart, and they are listed, streamed and still able to report waiting afterwards, ` +
      `because the hook secret is derived rather than minted. Currently allowed: ` +
      `${this.paths.join(", ")}`
    );
  }

  /**
   * What GET /api/cwds serves: the list, with the live sessions in each.
   *
   * A basename shared by two entries is qualified with its parent, because a root holds one
   * directory per owner and two owners' `dotfiles` would otherwise be two identical rows.
   */
  list(sessionsByCwd: ReadonlyMap<string, string[]>): Cwd[] {
    const paths = this.paths;
    const seen = new Map<string, number>();
    for (const path of paths) seen.set(basename(path), (seen.get(basename(path)) ?? 0) + 1);
    return paths.map((path) => ({
      path,
      name:
        (seen.get(basename(path)) ?? 0) > 1
          ? join(basename(dirname(path)), basename(path))
          : basename(path),
      sessions: [...(sessionsByCwd.get(path) ?? [])],
    }));
  }
}
