// Every assertion runs the real tool against a real file rather than reading a config key: a setting
// present but not wired up looks identical from outside. That this file ran proves the runner.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const binDir = `${repoRoot}node_modules/.bin`;

interface PackageJson {
  readonly type?: string;
  readonly engines?: Record<string, string>;
  readonly packageManager?: string;
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const readPackageJson = async (): Promise<PackageJson> =>
  JSON.parse(await readFile(`${repoRoot}package.json`, "utf8")) as PackageJson;

interface RunResult {
  readonly status: number;
  readonly output: string;
}

// Captures both streams and the exit status instead of throwing, because a non-zero exit is the
// assertion in half of these tests.
const run = (command: string, cwd: string = repoRoot): RunResult => {
  try {
    const output = execFileSync("/bin/sh", ["-c", command], {
      cwd,
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

// Scratch space for fixtures that must NOT compile, lint or format cleanly. Outside the repo,
// because this suite runs the repo's own checks for real and would fail on them.
const scratchRoot = mkdtempSync(join(tmpdir(), "agentdeck-toolchain-"));
after(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

// A fixture directory the toolchain treats exactly as src/, on the project's own tsconfig rather
// than hand-picked flags. typeRoots is repointed only because it sits outside the repo.
const fixture = (label: string, files: Readonly<Record<string, string>>): string => {
  const dir = join(scratchRoot, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: `${repoRoot}tsconfig.json`,
      compilerOptions: { typeRoots: [`${repoRoot}node_modules/@types`] },
      include: ["./*.ts"],
    }),
  );
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  return dir;
};

const typecheckFixture = (label: string, source: string): RunResult => {
  const dir = fixture(label, { "fixture.ts": source });
  return run(`tsc --noEmit --project ${dir}/tsconfig.json`);
};

void describe("the M0 acceptance criterion", () => {
  // The done-when sentence, executed. The script strings come out of package.json rather than
  // being repeated here, so a script renamed to something that does not run the tool fails.
  void test("the typecheck script passes on the current tree", async () => {
    const pkg = await readPackageJson();
    const script = pkg.scripts?.["typecheck"];
    assert.ok(script, "package.json declares no typecheck script");
    const result = run(script);
    assert.equal(result.status, 0, `typecheck failed:\n${result.output}`);
  });

  void test("the lint script passes on the current tree", async () => {
    const pkg = await readPackageJson();
    const script = pkg.scripts?.["lint"];
    assert.ok(script, "package.json declares no lint script");
    // Both halves have to be there: a lint script that has quietly lost `prettier --check` still
    // exits 0 on a badly formatted tree.
    assert.match(script, /eslint/);
    assert.match(script, /prettier --check/);
    const result = run(script);
    assert.equal(result.status, 0, `lint failed:\n${result.output}`);
  });

  void test("the test script collects the .ts suites in src", async () => {
    const pkg = await readPackageJson();
    const script = pkg.scripts?.["test"] ?? "";
    assert.match(script, /^node --test\b/);
    assert.match(script, /"src\/\*\*\/\*\.test\.ts"/);
  });

  // The suites spawn real servers, tmux and ptys, so one worker per core oversubscribes the machine
  // and starves the wall-clock-bound tests. Measured rather than guessed (audit.md).
  void test("the test run is capped below the core count, because the suites spawn real processes", async () => {
    const pkg = await readPackageJson();
    const capped = /--test-concurrency=(\d+)/.exec(pkg.scripts?.["test"] ?? "");
    assert.ok(capped, "the test script sets no concurrency cap");
    assert.ok(
      Number(capped[1]) <= 4,
      `the cap is ${String(capped[1])}, high enough for the starvation this exists to prevent`,
    );
  });

  void test("the toolchain is pinned to the package manager and Node line it was built on", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.type, "module");
    assert.match(pkg.packageManager ?? "", /^pnpm@9\./);
    // 22.18 is the first release that runs .ts under `node --test` without a flag; below it the
    // test script does not start at all.
    assert.equal(pkg.engines?.["node"], ">=22.18");
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    assert.ok(
      major > 22 || (major === 22 && minor >= 18),
      `running on Node ${process.versions.node}, below the declared floor`,
    );
  });
});

void describe("the dependency budget", () => {
  // A guardrail rather than a preference: six runtime dependencies and the budget is spent. A lint
  // plugin arriving as a runtime dependency is how it is overspent without a decision.
  void test("no more than six runtime dependencies are declared", async () => {
    const pkg = await readPackageJson();
    const runtime = Object.keys(pkg.dependencies ?? {});
    assert.ok(runtime.length <= 6, `runtime dependencies over budget: ${runtime.join(", ")}`);
  });

  void test("the test runner costs nothing - it is node:test, not a package", async () => {
    const pkg = await readPackageJson();
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ["vitest", "jest", "mocha", "tap", "ava", "tsx", "ts-node"]) {
      assert.ok(!(name in declared), `${name} is declared; the runner is meant to be node:test`);
    }
  });
});

void describe("the suite does not leak tmux servers", () => {
  // A booted server turns `exit-empty off` on the tmux it starts, so that tmux outlives every process
  // the test kills - 236 servers had accumulated. Source-level: workers cannot count each other.
  void test("every test file that names a TMUX_SOCKET also kills that server", async () => {
    const testDir = join(repoRoot, "src");
    const names = await readdir(testDir, { recursive: true });
    const offenders: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".test.ts")) continue;
      const source = await readFile(join(testDir, name), "utf8");
      if (!source.includes("TMUX_SOCKET")) continue;
      if (!source.includes("kill-server")) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      `these files boot a server with its own tmux socket and never kill it: ${offenders.join(", ")}`,
    );
  });
});

void describe("Node runs the TypeScript sources directly", () => {
  void test("a .ts file with type annotations executes with no build step", () => {
    const dir = fixture("strip", {
      "ok.ts":
        'const greet = (who: string): string => `hi ${who}`;\nprocess.stdout.write(greet("deck"));\n',
    });
    const result = run(`node ${dir}/ok.ts`);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output, "hi deck");
  });

  void test("a relative import written with its .ts extension resolves", () => {
    // allowImportingTsExtensions plus Node's own resolution. If either side stops accepting it,
    // every import in the codebase breaks at once.
    const dir = fixture("extension", {
      "dep.ts": "export const answer: number = 42;\n",
      "main.ts": 'import { answer } from "./dep.ts";\nprocess.stdout.write(String(answer));\n',
    });
    const result = run(`node ${dir}/main.ts`);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output, "42");
  });
});

void describe("erasableSyntaxOnly rejects what Node cannot strip", () => {
  // The three constructs named in the tsconfig comment: without the flag they type check happily and
  // fail at runtime. TS1294 is the diagnostic observed from tsc 5.8.3.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["enum", "export enum Colour {\n  Red,\n}\n"],
    [
      "parameter-property",
      "export class Session {\n  constructor(private readonly id: string) {}\n}\n",
    ],
    ["namespace", "export namespace Wire {\n  export const version = 1;\n}\n"],
  ];

  for (const [label, source] of cases) {
    void test(`a ${label} fails typecheck with TS1294`, () => {
      const result = typecheckFixture(label, source);
      assert.notEqual(result.status, 0, `expected a ${label} to be rejected:\n${result.output}`);
      assert.match(result.output, /error TS1294/);
      assert.match(result.output, /erasableSyntaxOnly/);
    });
  }

  void test("the erasable equivalents still compile", () => {
    // The control. A flag that rejected everything would pass the three tests above and make the
    // language unusable, and nothing else here would notice.
    const result = typecheckFixture(
      "erasable",
      [
        "export interface Session {",
        "  readonly id: string;",
        "}",
        "export type Status = 'running' | 'exited';",
        "export const of = (id: string): Session => ({ id });",
        "export const status = 'running' satisfies Status;",
        "export class Registry {",
        "  readonly sessions: readonly Session[] = [];",
        "}",
        "",
      ].join("\n"),
    );
    assert.equal(result.status, 0, result.output);
  });

  void test("an unchecked index access is an error", () => {
    // noUncheckedIndexedAccess. The ring buffer and the tmux output parsing at M2 are built out
    // of exactly this operation, and an undefined there is silent.
    const result = typecheckFixture(
      "index-access",
      "const rows: string[] = [];\nexport const first: string = rows[0];\n",
    );
    assert.notEqual(
      result.status,
      0,
      `expected the index access to be rejected:\n${result.output}`,
    );
    assert.match(result.output, /error TS2322/);
  });
});

void describe("eslint is wired to the type checker", () => {
  interface PrintedConfig {
    readonly rules: Record<string, unknown>;
    readonly globals: Record<string, unknown> | undefined;
  }

  const printConfig = (file: string): PrintedConfig => {
    const result = run(`eslint --print-config ${file}`);
    assert.equal(result.status, 0, result.output);
    const parsed = JSON.parse(result.output) as {
      rules: Record<string, unknown>;
      languageOptions?: { globals?: Record<string, unknown> };
    };
    return { rules: parsed.rules, globals: parsed.languageOptions?.globals };
  };

  const severityOf = (rules: Record<string, unknown>, name: string): number => {
    const entry = rules[name];
    return Array.isArray(entry) ? Number(entry[0]) : Number(entry ?? 0);
  };

  void test("the type-aware rules are enabled for .ts sources", () => {
    // Why the config pays for projectService: a floating promise around a tmux round trip is
    // invisible to a syntax-only lint, and it is the mistake this codebase is most exposed to.
    const { rules } = printConfig("src/index.ts");
    assert.equal(severityOf(rules, "@typescript-eslint/no-floating-promises"), 2);
    assert.equal(severityOf(rules, "@typescript-eslint/await-thenable"), 2);
  });

  void test("eslint actually reports a floating promise in a .ts file", () => {
    // `--print-config` proves the rule is on; only running it proves type information reaches the
    // rule, since a service that cannot resolve the file degrades to on-and-silent.
    const dir = fixture("floating", {
      "floating.ts":
        "const later = async (): Promise<void> => {};\nexport const go = (): void => {\n  later();\n};\n",
    });
    const result = run(
      `eslint --no-ignore --config ${repoRoot}eslint.config.mjs ./floating.ts`,
      dir,
    );
    assert.notEqual(result.status, 0, `expected a lint error:\n${result.output}`);
    assert.match(result.output, /no-floating-promises/);
  });

  void test("the type-aware rules are off for .mjs, which has no project to check against", () => {
    // The override exists because eslint.config.mjs and scripts/ sit outside the TypeScript
    // project. If it regresses, lint fails on its own config file.
    const { rules, globals } = printConfig("eslint.config.mjs");
    assert.equal(severityOf(rules, "@typescript-eslint/no-floating-promises"), 0);
    assert.equal(globals?.["process"], "readonly");
    assert.equal(globals?.["console"], "readonly");
  });
});

void describe("prettier is the formatter and it is enforced", () => {
  void test("a badly formatted file is rejected by --check", () => {
    const dir = fixture("format", { "ugly.ts": "export const   a= {b:1,\n c:2}\n" });
    const result = run(`prettier --check ${dir}/ugly.ts`);
    assert.notEqual(result.status, 0, `expected --check to fail:\n${result.output}`);
  });

  void test("the configured options are the ones the tree is written in", async () => {
    const config = JSON.parse(await readFile(`${repoRoot}.prettierrc.json`, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(config["printWidth"], 100);
    assert.equal(config["singleQuote"], false);
    assert.equal(config["trailingComma"], "all");
  });
});
