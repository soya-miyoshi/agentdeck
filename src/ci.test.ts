// CI is a file that this repository never executes, so the only assertions worth making about it
// are the ones a green check cannot make for you. Three properties are load-bearing (plan 003, M0;
// plan 005): the workflow runs on pull requests and runs the same three scripts the container
// does; the pnpm version comes from `packageManager` via corepack rather than from a pin in the
// workflow that can drift; and the runner's `pnpm install` is the ONLY one outside the container,
// with nothing having quietly put the host-side install back into mise.toml or the README.
//
// The done-when sentence - "a deliberately broken type fails it" - is executed rather than
// asserted about: the repository's own sources are compiled under the repository's own tsconfig
// with one added file carrying the error a pull request would carry, and the clean tree is
// compiled again afterwards as the control.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const binDir = `${repoRoot}node_modules/.bin`;
const workflowPath = `${repoRoot}.github/workflows/ci.yml`;

const readWorkflow = async (): Promise<string> => await readFile(workflowPath, "utf8");

interface PackageJson {
  readonly packageManager?: string;
  readonly scripts?: Record<string, string>;
}

const readPackageJson = async (): Promise<PackageJson> =>
  JSON.parse(await readFile(`${repoRoot}package.json`, "utf8")) as PackageJson;

// Enough of a YAML reader for the one shape this file has: a flat list of steps, each a `- uses:`
// or a `- run:`. Order matters (corepack after setup-node), so the steps are returned in order
// rather than as a set. Comment lines are dropped first, because every claim in this workflow is
// also written in prose directly above the step it describes and a regex over the raw text would
// happily match the prose instead of the step.
interface Step {
  readonly kind: "uses" | "run";
  readonly value: string;
}

const stepsOf = (workflow: string): readonly Step[] =>
  workflow
    .split("\n")
    .map((line) => line.replace(/^\s*/, ""))
    .filter((line) => !line.startsWith("#"))
    .flatMap((line) => {
      const match = /^-?\s*(uses|run):\s*(.+?)\s*$/.exec(line);
      if (match === null) return [];
      const kind = match[1] === "uses" ? "uses" : "run";
      return [{ kind, value: match[2] ?? "" } satisfies Step];
    });

interface RunResult {
  readonly status: number;
  readonly output: string;
}

// Non-zero is the assertion in the acceptance test, so the exit status is returned rather than
// thrown.
const run = (command: string): RunResult => {
  try {
    const output = execFileSync("/bin/sh", ["-c", command], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
};

void describe("the M0 CI acceptance criterion", () => {
  void test("the workflow runs on pull requests, so a PR gets a check at all", async () => {
    const workflow = await readWorkflow();
    // Without a pull_request trigger the checks only ever appear after the merge, which is not
    // the thing the done-when sentence asks for.
    assert.match(workflow, /^on:$/m);
    assert.match(workflow, /^\s{2}pull_request:/m);
    assert.match(workflow, /^\s{2}push:/m);
    assert.match(workflow, /branches:\s*\[main\]/);
  });

  void test("a deliberately broken type fails the typecheck the workflow runs", async () => {
    // The done-when sentence, executed: the repository's real sources, compiled under the
    // repository's real tsconfig, with one file added that carries the kind of error a pull
    // request would carry. The broken file is written outside src/ and reached through a
    // generated tsconfig that extends the project's own - writing it into src/ would be closer to
    // what CI sees, but this suite runs alongside toolchain.test.ts, which typechecks the tree at
    // the same moment and would fail on the fixture.
    const pkg = await readPackageJson();
    const workflowScripts = stepsOf(await readWorkflow())
      .filter((step) => step.kind === "run")
      .map((step) => /^pnpm\s+(\S+)$/.exec(step.value)?.[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(
      workflowScripts.includes("typecheck"),
      `the workflow runs no typecheck step: ${workflowScripts.join(", ")}`,
    );
    const script = pkg.scripts?.["typecheck"];
    assert.ok(script, "package.json declares no typecheck script");
    assert.match(script, /^tsc\b/, "the typecheck script no longer runs tsc");

    const dir = mkdtempSync(join(tmpdir(), "agentdeck-ci-"));
    try {
      writeFileSync(join(dir, "broken.ts"), "export const port: number = 'not a number';\n");
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          extends: `${repoRoot}tsconfig.json`,
          compilerOptions: { typeRoots: [`${repoRoot}node_modules/@types`] },
          include: [`${repoRoot}src/**/*.ts`, "./broken.ts"],
        }),
      );
      const broken = run(`tsc --noEmit --project ${dir}/tsconfig.json`);
      assert.notEqual(broken.status, 0, `expected the broken type to fail:\n${broken.output}`);
      assert.match(broken.output, /broken\.ts/);
      assert.match(broken.output, /error TS2322/);

      // The control. Without it this passes just as happily against a tree that never
      // typechecked, which is the failure the whole step exists to distinguish.
      rmSync(join(dir, "broken.ts"));
      const clean = run(`tsc --noEmit --project ${dir}/tsconfig.json`);
      assert.equal(clean.status, 0, `the tree does not typecheck at all:\n${clean.output}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void test("every script the workflow runs exists in package.json", async () => {
    // A workflow step naming a script that was renamed fails CI loudly; one naming a script that
    // never existed under a `continue-on-error` or in a job nothing depends on does not. Checking
    // the names against package.json costs nothing and does not depend on which of those it is.
    const pkg = await readPackageJson();
    const scripts = stepsOf(await readWorkflow())
      .filter((step) => step.kind === "run")
      .map((step) => /^pnpm\s+(\S+)$/.exec(step.value)?.[1])
      .filter((name): name is string => name !== undefined && name !== "install");
    assert.deepEqual([...scripts].sort(), ["lint", "test", "typecheck"]);
    for (const name of scripts) {
      assert.ok(pkg.scripts?.[name], `the workflow runs \`pnpm ${name}\`, which does not exist`);
    }
  });
});

void describe("CI cannot drift from the container's pnpm", () => {
  void test("pnpm comes from corepack, not from a version pinned in the workflow", async () => {
    const workflow = await readWorkflow();
    const steps = stepsOf(workflow);
    // pnpm/action-setup takes its own `version` input, and a second place to write the version is
    // a second place for it to be wrong. corepack reads package.json.
    assert.ok(
      !steps.some((step) => step.kind === "uses" && step.value.includes("pnpm/action-setup")),
      "the workflow installs pnpm with an action that pins its own version",
    );
    assert.ok(
      steps.some((step) => step.kind === "run" && step.value.startsWith("corepack enable")),
      "the workflow never enables corepack",
    );
    assert.ok(
      !/pnpm@\d/.test(workflow.replace(/^\s*#.*$/gm, "")),
      "the workflow names a pnpm version of its own",
    );
  });

  void test("corepack runs after setup-node, where the shims land on the right Node", async () => {
    // Ordering, not presence: corepack enable before setup-node installs its shims into the
    // runner's preinstalled Node, and setup-node then puts a different Node ahead of it on PATH.
    // The workflow still goes green, on whatever pnpm that other Node ships.
    const steps = stepsOf(await readWorkflow());
    const setupNode = steps.findIndex(
      (step) => step.kind === "uses" && step.value.startsWith("actions/setup-node@"),
    );
    const corepack = steps.findIndex(
      (step) => step.kind === "run" && step.value.startsWith("corepack enable"),
    );
    assert.notEqual(setupNode, -1, "the workflow does not set up Node");
    assert.notEqual(corepack, -1, "the workflow never enables corepack");
    assert.ok(corepack > setupNode, "corepack enable runs before actions/setup-node");
  });

  void test("the version corepack will select is the one the image activates", async () => {
    const pkg = await readPackageJson();
    const pinned = pkg.packageManager;
    assert.ok(pinned, "package.json has no packageManager field for corepack to read");
    assert.match(pinned, /^pnpm@\d+\.\d+\.\d+$/, "packageManager must pin an exact pnpm version");
    const dockerfile = await readFile(`${repoRoot}Dockerfile`, "utf8");
    const activated = /corepack prepare (pnpm@\d+\.\d+\.\d+) --activate/.exec(dockerfile)?.[1];
    assert.equal(activated, pinned, "the container and CI would run different pnpm versions");
  });

  void test("the runner installs from the lockfile rather than resolving afresh", async () => {
    // Without --frozen-lockfile a stale lockfile is silently updated in the runner's working copy
    // and CI passes on a dependency set nobody has on disk.
    const steps = stepsOf(await readWorkflow());
    const install = steps.filter(
      (step) => step.kind === "run" && step.value.startsWith("pnpm install"),
    );
    assert.equal(install.length, 1, "expected exactly one install step");
    assert.match(install[0]?.value ?? "", /--frozen-lockfile/);
  });
});

void describe("CI does not undo what the container decisions bought", () => {
  void test("the workflow does not build the arm64 image", async () => {
    // Plan 003, M0: not built here because nothing in CI would then run it. A build step that
    // creeps back in is minutes of qemu or a second runner arch per push, buying an artifact
    // nothing consumes.
    const workflow = await readWorkflow();
    const steps = stepsOf(workflow);
    for (const step of steps) {
      assert.ok(
        !/docker\/(build-push-action|setup-buildx-action|setup-qemu-action)/.test(step.value),
        `the workflow builds the image: ${step.value}`,
      );
      assert.ok(
        !/^docker\b.*\bbuild\b/.test(step.value),
        `the workflow builds the image: ${step.value}`,
      );
      assert.ok(
        !/docker\s+compose\s+(up|build)/.test(step.value),
        `the workflow brings up the container: ${step.value}`,
      );
    }
  });

  void test("the runner's install is the only one outside the container", async () => {
    // Plan 005: `pnpm install` on the Mac executes this repo's own agent-writable package.json and
    // lockfile under pnpm 9, which does not gate lifecycle scripts. mise.toml and the README were
    // moved to a container-side install for that reason, and a documented host-side install is the
    // regression - a green CI would never notice it, because CI is the one place it is fine.
    const documents = {
      "mise.toml": await readFile(`${repoRoot}mise.toml`, "utf8"),
      "README.md": await readFile(`${repoRoot}README.md`, "utf8"),
    };
    for (const [name, text] of Object.entries(documents)) {
      const commands = text
        .split("\n")
        .map((line) => line.replace(/^[\s#>*-]*/, "").trim())
        .filter((line) => /^(pnpm|docker)\b.*\bpnpm install\b|^pnpm install\b/.test(line));
      for (const command of commands) {
        assert.match(
          command,
          /^docker compose exec\b/,
          `${name} documents a host-side install: ${command}`,
        );
      }
    }
  });

  void test("CI's install is justified in the workflow rather than left to be inferred", async () => {
    // The exception is only safe because the runner is disposable and carries no human identity.
    // That reasoning lives next to the step, since this is the one file where the repo's stated
    // rule is deliberately broken and a reader who does not find the reason will either copy it to
    // the host or delete it from here.
    const workflow = await readWorkflow();
    const comments = workflow
      .split("\n")
      .filter((line) => line.trimStart().startsWith("#"))
      .join("\n");
    assert.match(comments, /plan 005/);
    assert.match(comments, /runner/);
  });
});
