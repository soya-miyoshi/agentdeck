// agentdeck runs on the Mac now (plan 005 is superseded), so there is no boundary left to test -
// only the consequence, which is the same one and worse: an agent working in this repository can
// write the files the host then executes. The package.json scripts, eslint.config.mjs, and the
// node_modules and .pnpm-store trees git cannot see are all in reach, and review is the only
// control. These tests fail if that stops being written down where the claim is made.
//
// Plan 005's superseded header says these tests still apply, and this is what that means: the
// assertions about the container are gone, the assertions about what the container never covered
// are unchanged.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const repoRoot = new URL("..", import.meta.url);

const readDoc = async (name: string): Promise<string> =>
  await readFile(new URL(name, repoRoot), "utf8");

// pnpm-lock.yaml belongs here for the same reason as package.json and is easier to miss:
// pnpm 9 does not gate dependency lifecycle scripts, so a rewritten `resolution` entry runs
// on the host at the next install. The container-local node_modules volume protects the
// installed tree, not the input that produces it.
//
// The last three are the ones a build-file-shaped review list misses. `src/**/*.test.ts` is what
// `pnpm test` hands to `node --test`, which runs it as code — this very file already calls
// execFileSync, so one more shell-out is unremarkable in a diff. `mise.toml` documents
// `mise install` and mise executes `[env] _.source` and `[tasks]` on the host. `.claude/` needs no
// build and no host `pnpm` at all: a Claude Code process on the Mac loads SKILL.md, CLAUDE.md and
// settings.json from it, so starting a session in this repo is the whole trigger — and the skill
// there is what prescribes this review.
//
// The globs are deliberate. Every host tool here discovers its own config, so naming the one
// filename we happen to have leaves the rest unreviewed: prettier imports its `plugins` entries
// as JavaScript from any `.prettierrc*`, and mise reads `.mise.toml`, `mise.local.toml` and
// `mise-tasks/` as readily as `mise.toml`. `.github/workflows/` is the surface that picks its own
// privileges — `permissions:` lives inside the file being protected. `.git/config` and
// `.git/hooks/` are executed by git itself, which makes the prescribed `git diff` its own
// trigger, and neither is tracked, so the review cannot see them at all.
const hostExecutedFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "eslint.config.*",
  ".prettierrc*",
  ".mise*.toml",
  "mise-tasks/",
  "src/**/*.test.ts",
  ".claude/",
  ".github/workflows/",
  ".git/config",
  ".git/hooks/",
];

void describe("the host-execution consequence is documented where the claim is made", () => {
  void test("the README says the host executes agent-writable files from this repo", async () => {
    const readme = await readDoc("README.md");
    for (const file of hostExecutedFiles) {
      assert.ok(readme.includes(file), `README does not name ${file} as agent-writable`);
    }
    assert.match(readme, /agent-writable/);
  });

  void test("the README says the review is now the only control, not the second of two", async () => {
    // The container was the first of two. Its removal is the whole reason the review matters
    // more than it did, and a reader who does not meet that sentence will treat the checklist as
    // belt-and-braces.
    const readme = await readDoc("README.md");
    const toolchain = readme.slice(readme.indexOf("## Toolchain"));
    assert.ok(toolchain.length > 0, "README has no Toolchain section");
    assert.match(toolchain, /only control rather than the second of two/);
    assert.match(toolchain, /git status/);
    assert.match(toolchain, /git diff/);
  });

  void test("the host-run exception names everything the host would execute", async () => {
    // The exception paragraph is where a human decides to run something on the Mac, so the list
    // that matters is the one there, not the one anywhere in the file.
    const readme = await readDoc("README.md");
    const toolchain = readme.slice(readme.indexOf("## Toolchain"));
    for (const file of hostExecutedFiles) {
      assert.ok(
        toolchain.includes(file),
        `README's toolchain exception does not name ${file} as agent-writable`,
      );
    }
  });

  void test("plan 005 states it in what containment actually buys", async () => {
    const plan = await readDoc("plans/005-containment.md");
    const start = plan.indexOf("## What containment actually buys");
    assert.ok(start >= 0, "plan 005 has no `What containment actually buys` section");
    const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
    for (const file of hostExecutedFiles) {
      assert.ok(section.includes(file), `plan 005 does not name ${file} as agent-writable`);
    }
  });
});

// `git status` cannot see either of these trees, so the ordinary review is blind to them. The
// container-local volume that used to cover that is gone with the container, which leaves one
// command - `git status --ignored` over both paths - and the README has to carry it, because
// nothing else will.
void describe("the host-executed trees git cannot see are covered by a command that can", () => {
  for (const path of ["node_modules", ".pnpm-store"]) {
    void test(`${path} is gitignored, which is why the ordinary review misses it`, async () => {
      const ignored = await readDoc(".gitignore");
      assert.match(ignored, new RegExp(`^${path.replace(".", "\\.")}$`, "m"));
    });
  }

  void test("the README's checklist names the command that can see them", async () => {
    const readme = await readDoc("README.md");
    assert.ok(
      readme.includes("git status --ignored -- node_modules .pnpm-store"),
      "README does not name a command that can see the two gitignored executed trees",
    );
  });

  void test("both trees are named as agent-writable where the claim is made", async () => {
    const readme = await readDoc("README.md");
    const plan = await readDoc("plans/005-containment.md");
    for (const doc of [readme, plan]) {
      assert.match(doc, /node_modules/);
      assert.match(doc, /\.pnpm-store/);
    }
  });
});

// None of `.git` is tracked, so the `git status` / `git diff` review is as blind to
// `.git/config` and `.git/hooks/` as it is to node_modules - and `git diff` is itself what fires
// a `[core] pager` entry. The volume that used to mask `.git` from a container session is gone
// with the container, so what remains is the pair of commands that can see the surfaces and the
// hardening on every git command this pipeline runs.
const docs: readonly (readonly [string, string])[] = [
  ["README.md", "README.md"],
  ["plan 005", "plans/005-containment.md"],
];

void describe("git's own execution surfaces are covered where review cannot see them", () => {
  for (const [name, path] of docs) {
    void test(`${name} names the two commands that can see .git`, async () => {
      const doc = await readDoc(path);
      assert.ok(
        doc.includes("git config --local --list"),
        `${name} omits git config --local --list`,
      );
      assert.ok(doc.includes("ls -la .git/hooks"), `${name} omits ls -la .git/hooks`);
      assert.match(doc, /\.sample/);
    });
  }

  void test("the iterate skill runs host git with pager and hooks disabled", async () => {
    // The skill is what prescribes the review and then does the branch, merge and switch on the
    // host. Each of those is a hook trigger, and `git diff` is a pager trigger.
    const skill = await readDoc(".claude/skills/iterate/SKILL.md");
    const hardened = /git -c core\.pager=cat -c\s+core\.hooksPath=\/dev\/null/g;
    const uses = skill.match(hardened) ?? [];
    assert.ok(uses.length >= 4, `only ${uses.length} host git commands are hardened`);

    // A count is a floor, not coverage: every stage prompt ends with "Commit.", and those
    // commits are host git run by a subagent, which no per-command flag in this file reaches.
    // The shared prompt is the only layer that does, so assert the instruction is in it.
    assert.match(
      skill,
      /Every git command you run is HOST git/,
      "the shared agent prompt must tell every stage to harden its own git commands",
    );
    for (const bare of [
      /(?<!-c )\bgit switch -c /,
      /(?<!-c )\bgit merge --no-ff /,
      /(?<!-c )\bgit status --porcelain/,
    ]) {
      assert.doesNotMatch(skill, bare, `the skill still runs an unhardened ${String(bare)}`);
    }
  });
});

// The enumerated list is a floor: the host tools discover config we did not name, so a review
// scoped to the list is a review with a hole in it. Both documents have to say so.
void describe("the review list is stated as a floor rather than the whole job", () => {
  for (const [name, path] of docs) {
    void test(`${name} requires reviewing every modified file, not only the listed ones`, async () => {
      const doc = await readDoc(path);
      assert.match(doc, /floor/);
      assert.match(doc, /every added or modified\s+file in the diff/);
    });
  }

  void test("plan 005 says a workflow file declares its own permissions", async () => {
    const plan = await readDoc("plans/005-containment.md");
    const start = plan.indexOf("## What containment actually buys");
    const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
    assert.match(section, /permissions:/);
    assert.match(section, /default workflow permission/);
  });
});

void describe("the user's bearer token is not at the root of a working tree", () => {
  void test(".gitignore does not put it at the repo root", async () => {
    // The repo root is a directory sessions are pointed at, and every session runs as the uid the
    // server runs as, so mode 0600 separates nothing. Placement is the only control left. Where
    // it should live now that there is no container is open, recorded in plan 005's superseded
    // header - this asserts only the one place it must not be.
    const ignored = await readDoc(".gitignore");
    assert.doesNotMatch(
      ignored,
      /^\.agentdeck-token$/m,
      ".agentdeck-token at the repo root is where an agent's own `ls -la` meets it",
    );
  });

  void test("neither .gitignore nor loadToken claims a container protects the placement", async () => {
    // The .gitignore comment is the only tracked file that tells a reader where the token goes,
    // and loadToken's docstring is the only one a reader of the code meets. Both used to say the
    // path was outside every bind mount, in a container that no longer exists - a protection a
    // reader would credit, and so never make the choice plan 005 says is open.
    for (const [path, text] of [
      [".gitignore", await readDoc(".gitignore")],
      ["src/server.ts", (await readDoc("src/server.ts")).slice(0, 3000)],
    ] as const) {
      assert.doesNotMatch(text, /bind mount/i, `${path} still credits a bind mount`);
      assert.doesNotMatch(text, /container-local volume/i, `${path} still credits a volume`);
    }
    const ignored = await readDoc(".gitignore");
    assert.match(ignored, /AGENTDECK_TOKEN_FILE/);
    assert.match(ignored, /undecided|open in plan 005/i, ".gitignore must say the home is open");
    assert.match(ignored, /root of a tree a session is\s*#?\s*pointed at/);
  });

  void test("an unwritable token path is a sentence naming AGENTDECK_TOKEN_FILE", async () => {
    // The default path is /var/lib/agentdeck/token, which no ordinary user on a Mac can create,
    // so this is the first thing `pnpm start` hits. An unhandled EACCES names no variable and the
    // token then lands wherever happened to be writable - including the one place it must not be.
    const { loadToken } = await import("./server.ts");
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-token-"));
    try {
      chmodSync(dir, 0o500);
      assert.throws(
        () => loadToken(join(dir, "nested", "token")),
        (error: Error) => {
          assert.match(error.message, /AGENTDECK_TOKEN_FILE/);
          assert.match(error.message, /session is pointed at/);
          return true;
        },
      );
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void test("plan 005 lists the token in the blast radius with the same-uid caveat", async () => {
    const plan = await readDoc("plans/005-containment.md");
    const start = plan.indexOf("## What containment actually buys");
    const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
    assert.match(section, /AGENTDECK_TOKEN_FILE/);
    assert.match(section, /distinct uid/);
  });
});
