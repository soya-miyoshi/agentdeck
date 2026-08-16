// CI is a file this repository never executes, so the only assertions worth making are the ones a
// green check cannot make: the same scripts, pnpm from corepack, and the RUNNER's install.

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

// Enough of a YAML reader for one flat list of steps, in ORDER because corepack must follow
// setup-node. Comments are dropped first, or a regex matches the prose above the step.
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
    // The real sources under the real tsconfig, with one file carrying the error a pull request
    // would. Outside src/, because toolchain.test.ts typechecks the tree at the same moment.
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
    // A step naming a renamed script fails CI loudly; one naming a script that never existed under
    // `continue-on-error` does not. Checking the names costs nothing either way.
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

void describe("CI cannot drift from the pnpm mise.toml pins", () => {
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
    // Ordering rather than presence: corepack before setup-node puts its shims on the wrong Node,
    // and the workflow still goes green on whatever pnpm the other one ships.
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

  void test("corepack is given an exact version to select", async () => {
    // Without the pin corepack resolves whatever `pnpm@9` means on the day, so CI and the Mac
    // drift apart on a resolver change nobody made.
    const pkg = await readPackageJson();
    const pinned = pkg.packageManager;
    assert.ok(pinned, "package.json has no packageManager field for corepack to read");
    assert.match(pinned, /^pnpm@\d+\.\d+\.\d+$/, "packageManager must pin an exact pnpm version");
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

void describe("CI builds nothing, because nothing consumes it", () => {
  void test("the workflow runs the suite and produces no artifact", async () => {
    // Plan 003, M0. There is no image and no deployment artifact, so a build step that creeps
    // back in is minutes per push buying something nothing installs.
    const steps = stepsOf(await readWorkflow());
    for (const step of steps) {
      assert.ok(
        !/\b(image|buildx|qemu|build-push|podman|upload-artifact)\b/i.test(step.value),
        `the workflow produces an artifact nothing consumes: ${step.value}`,
      );
    }
  });

  void test("the documented install is the host one, and it is the same one CI runs", async () => {
    // `pnpm install` runs on the Mac and executes this repo's own agent-writable manifest under a
    // pnpm that does not gate lifecycle scripts - a review gate, which needs the real command named.
    const documents = {
      "mise.toml": await readFile(`${repoRoot}mise.toml`, "utf8"),
      "README.md": await readFile(`${repoRoot}README.md`, "utf8"),
    };
    for (const [name, text] of Object.entries(documents)) {
      const commands = text
        .split("\n")
        .map((line) => line.replace(/^[\s#>*-]*/, "").trim())
        .filter((line) => /^pnpm install\b/.test(line));
      assert.ok(commands.length > 0, `${name} documents no install command`);
      for (const command of commands) {
        assert.match(
          command,
          /^pnpm install --frozen-lockfile$/,
          `${name} documents an install that is not the reviewed one: ${command}`,
        );
      }
    }
  });

  void test("CI's install is justified in the workflow rather than left to be inferred", async () => {
    // The runner is disposable and carries no human identity, which is why the same command that
    // is a review gate on the Mac is unremarkable there. That reasoning lives next to the step.
    const workflow = await readWorkflow();
    const comments = workflow
      .split("\n")
      .filter((line) => line.trimStart().startsWith("#"))
      .join("\n");
    assert.match(comments, /plan 005/);
    assert.match(comments, /runner/);
  });
});
