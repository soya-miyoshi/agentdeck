import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Finding the repositories under a root, so a clone made after boot needs no restart. The server
// knows nothing about ghq: a repository is a directory holding a `.git`, and that is all.

/** ghq's own layout is host/owner/repo; a host with subgroups adds one level below that. */
const MAX_DEPTH = 4;

/** A worktree and a submodule hold a `.git` FILE, so this asks that it exists, not that it is a
 *  directory. */
const isRepo = (dir: string): boolean => {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
};

/** Descends until it meets a repository, never into one: `vendor/` inside a checkout is not a
 *  separate place to start. Unreadable directories are skipped rather than fatal. */
const walk = (dir: string, depth: number, maxDepth: number, found: Set<string>): void => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Symlinks are skipped: they loop, and they would let a link planted under the root make an
    // arbitrary directory startable while reading as an ordinary clone.
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const child = join(dir, entry.name);
    if (isRepo(child)) found.add(child);
    else if (depth < maxDepth) walk(child, depth + 1, maxDepth, found);
  }
};

/** Every repository under every root, sorted, absolute. A root is never itself a result. */
export const scanRepos = (roots: readonly string[], maxDepth = MAX_DEPTH): string[] => {
  const found = new Set<string>();
  for (const root of roots) walk(resolve(root), 1, maxDepth, found);
  return [...found].sort();
};
