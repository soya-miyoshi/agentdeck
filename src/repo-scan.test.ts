import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { scanRepos } from "./repo-scan.ts";

// A real tree on disk rather than a stubbed fs: what this has to get right is what the filesystem
// actually reports for a worktree, a symlink and a directory it cannot read.

const root = mkdtempSync(join(tmpdir(), "agentdeck-roots-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repository at `<root>/<parts>`, with `.git` as a directory the way a clone has it. */
const repo = (...parts: string[]): string => {
  const dir = join(root, ...parts);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
};

void describe("finding the repositories under a root", () => {
  void test("a clone at ghq's own depth is found", () => {
    const cloned = repo("github.com", "someone", "thing");
    assert.ok(scanRepos([root]).includes(cloned));
  });

  void test("a repository appearing after an earlier scan is found by the next one", () => {
    // The whole point: no restart between the clone and the session.
    const before = scanRepos([root]);
    const cloned = repo("github.com", "someone", "cloned-just-now");
    assert.ok(!before.includes(cloned));
    assert.ok(scanRepos([root]).includes(cloned));
  });

  void test("a worktree, whose .git is a file, is a repository", () => {
    const dir = join(root, "github.com", "someone", "worktree");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n");
    assert.ok(scanRepos([root]).includes(dir));
  });

  void test("it does not descend into a repository", () => {
    // A vendored checkout inside a working tree is part of that work, not a second place to
    // start. Listing it would also put the same tree in the picker twice.
    const outer = repo("github.com", "someone", "outer");
    const inner = join(outer, "vendor", "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const found = scanRepos([root]);
    assert.ok(found.includes(outer));
    assert.ok(!found.includes(inner));
  });

  void test("a symlinked directory is not followed", () => {
    // It loops, and a link planted under the root would otherwise make an arbitrary directory
    // startable while reading, in the picker, as an ordinary clone.
    const target = mkdtempSync(join(tmpdir(), "agentdeck-elsewhere-"));
    mkdirSync(join(target, "secret", ".git"), { recursive: true });
    symlinkSync(target, join(root, "linked"));
    try {
      const found = scanRepos([root]);
      assert.ok(!found.some((path) => path.includes("secret")));
      assert.ok(!found.includes(join(root, "linked")));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  void test("the root itself is never startable, even holding a .git", () => {
    const own = mkdtempSync(join(tmpdir(), "agentdeck-selfroot-"));
    mkdirSync(join(own, ".git"), { recursive: true });
    try {
      assert.ok(!scanRepos([own]).includes(own));
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  void test("hidden directories are skipped", () => {
    const hidden = join(root, ".cache", "thing");
    mkdirSync(join(hidden, ".git"), { recursive: true });
    assert.ok(!scanRepos([root]).includes(hidden));
  });

  void test("a repository below the depth bound is not found", () => {
    const deep = join(root, "a", "b", "c", "d", "e");
    mkdirSync(join(deep, ".git"), { recursive: true });
    assert.ok(!scanRepos([root]).includes(deep));
  });

  void test("a root that does not exist yields nothing rather than throwing", () => {
    assert.deepEqual(scanRepos([join(root, "no-such-root")]), []);
  });

  void test("results are absolute, sorted and unique across roots", () => {
    const found = scanRepos([root, root]);
    assert.deepEqual(found, [...new Set(found)].sort());
    assert.ok(found.every((path) => path.startsWith("/")));
  });
});
