import { basename, dirname, join, resolve } from "node:path";

import { scanRepos } from "./repo-scan.ts";

// One list with two jobs: the allowlist `POST /api/sessions` validates against, and what the picker
// is served. AGENTDECK_MOUNTS is fixed; AGENTDECK_ROOTS is rescanned every time the list is read.

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
   * The allowlist right now: the fixed entries plus whatever the roots hold this second. Read
   * afresh rather than captured at boot, so a repository cloned a moment ago needs no restart.
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
   * Exact membership, never prefix: resolving first is not enough on its own, because
   * `/workspace/agentdeck-secrets` also starts with an allowed path.
   */
  allows(cwd: string): boolean {
    // The empty string is "we do not know where this session is". It must never be allowed, and it
    // would be: `resolve("")` is the server's own working directory.
    if (cwd === "") return false;
    return this.paths.includes(resolve(cwd));
  }

  /**
   * The refusal a person meets most often, so it says what would have to change rather than 403.
   * It prices the restart at a reconnect: overstating that misleads exactly as much as understating.
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
   * What GET /api/cwds serves: the list, with the live sessions in each. A shared basename is
   * qualified with its parent, or two owners' `dotfiles` under one root are identical rows.
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
