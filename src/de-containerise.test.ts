// The container is gone, and a plan that still describes one is the contract being wrong about the
// machine rather than a stale comment. Documents get tests here for that reason alone.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  createServer as createSocketServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Registry } from "./registry.ts";
import { Tmux } from "./tmux.ts";

const run = promisify(execFile);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const healthcheck = `${repoRoot}scripts/healthcheck.mjs`;

const readDoc = async (name: string): Promise<string> =>
  await readFile(`${repoRoot}${name}`, "utf8");

// This file, named once: its search patterns are the literals it searches for, so scanning itself
// reports the scanner. It was spelled three ways, one of which exempted other files too.
const SELF = "src/de-containerise.test.ts";

// The documents that described a container. Plan 005 is absent on purpose - it is the record of the
// one that is gone - and plan 002 was wrongly absent, having described one six times.
const decontainerised = [
  "README.md",
  "plans/001-architecture.md",
  "plans/002-wire-protocol.md",
  "plans/003-milestones.md",
  "plans/004-agent-profiles.md",
  "plans/006-availability.md",
  "mise.toml",
] as const;

// --- `grep -ril docker .` over the tracked files ---

// The command and the exact result set, not a spot check. `git ls-files` rather than a walk: the
// point is the TRACKED files, and node_modules is full of the word.
const trackedFiles = (): readonly string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((entry) => entry !== "");

// The retained deployment files, plus the documents allowed to say why. audit.md is here because
// it is append-only: rewriting an entry to remove the word would falsify the ledger.
const allowedToSayDocker = (path: string): boolean =>
  path === "Dockerfile" ||
  path === "docker-compose.yml" ||
  path === ".dockerignore" ||
  path.startsWith("docker/") ||
  path === "plans/005-containment.md" ||
  path === "TODO.md" ||
  path === "audit.md" ||
  // This file. It names the retained set in order to assert it, which is the one use that
  // cannot be removed without removing the check.
  path === SELF;

const retainedDeploymentFiles = ["Dockerfile", "docker-compose.yml", "docker/entrypoint.sh"];

void describe("the container is gone from everything that says how this runs", () => {
  void test("only the retained files and the note that explains them say docker", async () => {
    const offenders: string[] = [];
    for (const path of trackedFiles()) {
      if (allowedToSayDocker(path)) continue;
      const text = await readFile(`${repoRoot}${path}`, "utf8").catch(() => "");
      if (/docker/i.test(text)) offenders.push(path);
    }
    assert.deepEqual(offenders, [], `tracked files still describe Docker: ${offenders.join(", ")}`);
  });

  void test("the retained files are still on disk, because deleting them decides deployment", () => {
    const tracked = new Set(trackedFiles());
    for (const path of retainedDeploymentFiles) {
      assert.ok(tracked.has(path), `${path} was deleted; the user asked for it to be kept`);
    }
  });

  void test("each retained file says on its first lines that it is not in use, and why", async () => {
    // A Dockerfile with no header is indistinguishable from one that is how this runs, so the
    // header has to be where someone opening the file meets it first.
    for (const path of retainedDeploymentFiles) {
      // Comment markers stripped and the lines rejoined with spaces: the header is prose wrapped
      // to a column, so asserting on the raw text would be asserting on where the wrapping fell.
      const head = (await readDoc(path))
        .split("\n")
        .slice(0, 12)
        .map((line) => line.replace(/^#!?\s?/, "").trim())
        .join(" ");
      assert.match(head, /NOT IN USE/, `${path} does not say it is not in use`);
      assert.match(head, /Mac directly/, `${path} does not say what runs instead`);
      assert.match(head, /deliberately left\s+open/, `${path} does not say why it was kept`);
      assert.match(head, /005-containment\.md/, `${path} does not point at plan 005`);
    }
  });

  void test("TODO.md carries the note that explains the retention", async () => {
    const todo = await readDoc("TODO.md");
    const start = todo.indexOf("Not a branch: **the retained deployment files.**");
    assert.ok(start >= 0, "TODO.md has no note explaining the retained deployment files");
    const note = todo.slice(start, todo.indexOf("\n\n", start));
    for (const path of ["Dockerfile", "docker-compose.yml", "docker/"]) {
      assert.ok(note.includes(path), `the retention note does not name ${path}`);
    }
    // The note is also what makes audit.md's own hits legitimate, so it has to say so - without
    // that sentence the next reader "finishes the job" by editing the ledger.
    assert.match(note, /audit\.md/);
    assert.match(note, /append-only/);
  });

  void test("no document that describes how this runs mentions Docker", async () => {
    for (const path of decontainerised) {
      const text = await readDoc(path);
      assert.doesNotMatch(text, /docker/i, `${path} still describes Docker`);
    }
  });

  void test("nothing that runs describes a container: src/ and scripts/ are clean", async () => {
    // Plans are prose a reader can discount. A refusal is what a person meets while confused, and
    // telling them to check a container they do not have is the worst place to be wrong.
    for (const path of trackedFiles()) {
      if (!path.startsWith("src/") && !path.startsWith("scripts/")) continue;
      if (path === SELF) continue;
      const text = await readFile(`${repoRoot}${path}`, "utf8");
      assert.doesNotMatch(text, /docker/i, `${path} still describes Docker`);
      // `docker` was the only word scanned while the thing gone is the CONTAINER, which src/ named
      // four times. Test files are exempt here because their subject is partly its absence.
      if (path.endsWith(".test.ts")) continue;
      assert.doesNotMatch(text, /\bcontainers?\b/i, `${path} still describes a container`);
    }
  });
});

// --- What each document had to say instead ---

// Removing a word is not the item: each document made a claim that DEPENDED on the container, so
// the test is that the replacement claim is present rather than that the old one is gone.
void describe("each plan states the post-container claim, not merely the absence of the old one", () => {
  void test("plan 001 no longer rests the reattach guarantee on a process tree it lays out", async () => {
    const plan = await readDoc("plans/001-architecture.md");
    assert.match(plan, /no longer depends on any process tree/);
    assert.match(plan, /no PID 1 to get wrong/);
  });

  void test("plan 003 states the supervision gap at M0 rather than leaving it assumed", async () => {
    // M1 onwards is built on top of M0, so an unstated gap here is inherited by every milestone
    // above it. It is stated as a known gap, in the milestone that has it.
    const plan = await readDoc("plans/003-milestones.md");
    assert.match(plan, /\*\*Nothing supervises Node\.\*\*/);
    assert.match(plan, /tmux server is a daemon of its own/);
    assert.match(plan, /launchd|watchdog/i);
  });

  void test("plan 004 names the state directory the code actually writes to", async () => {
    // The fragment used to land in a path that only existed inside the image. Checked against src
    // rather than against the plan itself, because agreeing with the wrong thing is the failure.
    const plan = await readDoc("plans/004-agent-profiles.md");
    assert.match(plan, /AGENTDECK_AGENT_STATE_DIR/);
    const server = await readDoc("src/server.ts");
    assert.match(server, /AGENTDECK_AGENT_STATE_DIR/);
  });

  void test("plan 006 costs a restart at a reconnect, and records the split option as taken", async () => {
    const plan = await readDoc("plans/006-availability.md");
    // The reserved option was splitting tmux into its own container, and running on the host IS
    // that split - so it is spent rather than available, and an available option gets re-proposed.
    assert.match(plan, /recorded as taken rather than as available/);
    assert.match(plan, /no supervisor at all/);
  });

  void test("the README names the token's home, which m0/host-boundary decided", async () => {
    // Open when this file was written and decided since. "Recorded as open" left in the README
    // after the decision is the same wrong answer the container path was.
    const readme = await readDoc("README.md");
    assert.doesNotMatch(readme, /recorded as open in plan 005's superseded header, not decided/);
    assert.match(readme, /~\/\.agentdeck\/token/);
    assert.match(readme, /refuses to start if that path resolves inside an\s+allowlist entry/);
  });

  void test("plan 005 is the only plan that describes a container, and says it is superseded", async () => {
    const plan = await readDoc("plans/005-containment.md");
    const head = plan.split("\n").slice(0, 30).join("\n");
    assert.match(head, /superseded/i, "plan 005 does not carry its superseded header");
  });
});

// --- Nothing is left to self-skip ---

void describe("the suite has nothing left that skips itself", () => {
  const testFiles = (): readonly string[] =>
    trackedFiles().filter((path) => path.endsWith(".test.ts") && path !== SELF);

  void test("no suite marks itself skipped or todo", async () => {
    // Removed rather than left to notice they were not in an image and pass. A skipped test reads
    // as a pass in every summary, which is the difference between coverage and its appearance.
    for (const path of testFiles()) {
      const text = await readFile(`${repoRoot}${path}`, "utf8");
      for (const marker of [/\b(?:test|describe|it)\.skip\b/, /\b(?:test|describe|it)\.todo\b/]) {
        assert.doesNotMatch(text, marker, `${path} contains a self-skipping suite`);
      }
      // The options-object forms of the same thing, which no grep for `.skip` finds.
      assert.doesNotMatch(text, /\bskip:\s*(?!false)/, `${path} passes a skip option`);
      assert.doesNotMatch(text, /\btodo:\s*(?!false)/, `${path} passes a todo option`);
      assert.doesNotMatch(text, /\bctx\.skip\(|\bt\.skip\(/, `${path} skips at runtime`);
    }
  });

  void test("no suite gates itself on being inside a container", async () => {
    // The self-skip that mattered was keyed on the environment: inside the image it ran, on the Mac
    // it quietly did not - and with no image, such a probe never runs anywhere.
    for (const path of testFiles()) {
      const text = await readFile(`${repoRoot}${path}`, "utf8");
      assert.doesNotMatch(text, /\.dockerenv/, `${path} probes for a container`);
    }
  });
});

// --- scripts/healthcheck.mjs, run on the host ---

interface Outcome {
  readonly code: number;
  readonly stderr: string;
}

// Spawned as a process, because the exit code IS the interface: the watchdog reads nothing else,
// and a function returning a string proves nothing about what the script does.
const runHealthcheck = async (env: Readonly<Record<string, string>>): Promise<Outcome> => {
  try {
    const { stderr } = await run(process.execPath, [healthcheck], {
      env: { ...process.env, ...env },
      timeout: 20000,
    });
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
};

// A real tmux server on this suite's own socket, so the tmux half is genuinely healthy while the
// HTTP half is what varies. Without it every failure below passes for the wrong reason.
const tmuxSocket = `agentdeck-health-${String(process.pid)}`;

// A real /api/health, built from src/http.ts with the same handler the server uses, so the body
// the check parses is the body the server produces rather than one written here to match.
let health: Server;
let healthPort: string;
let probeOk = true;

// A port nothing listens on. Bound and released rather than picked, because a hardcoded number
// is a test that passes on the day something else happens to be listening there.
let deadPort: string;

before(async () => {
  execFileSync("tmux", ["-L", tmuxSocket, "new-session", "-d", "-s", "probe", "sleep 600"], {
    encoding: "utf8",
  });

  const { profiles } = parseProfiles({ claude: { command: "/bin/sh", name: "Claude Code" } });
  const allowlist = new CwdAllowlist([repoRoot]);
  const tmux = new Tmux({
    socket: tmuxSocket,
    exec: async () => await Promise.resolve({ stdout: "", stderr: "" }),
  });
  health = createServer(
    createHandler({
      registry: new Registry(tmux, profiles, allowlist, "test-secret-key"),
      profiles,
      allowlist,
      token: "unused-by-health",
      version: "0.0.0-test",
      origin: undefined,
      probe: async () => await Promise.resolve(probeOk),
    }),
  );
  await new Promise<void>((done) => health.listen(0, "127.0.0.1", done));
  healthPort = String((health.address() as AddressInfo).port);

  const scratch = createSocketServer();
  await new Promise<void>((done) => scratch.listen(0, "127.0.0.1", done));
  deadPort = String((scratch.address() as AddressInfo).port);
  await new Promise<void>((done) =>
    scratch.close(() => {
      done();
    }),
  );
});

after(async () => {
  await new Promise<void>((done) =>
    health.close(() => {
      done();
    }),
  );
  try {
    execFileSync("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Already gone is the outcome this wanted.
  }
});

void describe("scripts/healthcheck.mjs runs on the host and both halves can fail it", () => {
  void test("a live tmux server and a live /api/health is healthy", async () => {
    probeOk = true;
    const outcome = await runHealthcheck({
      TMUX_SOCKET: tmuxSocket,
      AGENTDECK_PORT: healthPort,
    });
    assert.equal(outcome.code, 0, `expected healthy, got: ${outcome.stderr}`);
  });

  void test("tmux alive and the server down is UNHEALTHY", async () => {
    // It must fail when the server is down - the case a tmux-only check missed entirely, since tmux
    // is a daemon of its own and stays up through a node crash.
    const outcome = await runHealthcheck({
      TMUX_SOCKET: tmuxSocket,
      AGENTDECK_PORT: deadPort,
    });
    assert.equal(outcome.code, 1, "a dead server passed the health check");
    assert.match(outcome.stderr, /unhealthy/);
    assert.match(outcome.stderr, new RegExp(`127\\.0\\.0\\.1:${deadPort}`));
    assert.match(outcome.stderr, /\/api\/health/);
  });

  void test("a server that accepts the socket and never answers is unhealthy, not hung", async () => {
    // A wedged event loop does not refuse connections, so a reachability check calls it healthy -
    // and one with no timeout hangs, which for a watchdog is never alerting.
    const accepted: Socket[] = [];
    const wedged: NetServer = createSocketServer((socket) => {
      // Accepted, and deliberately never written to. Held so the teardown can destroy it: this
      // server never ends a connection, so `close()` alone would wait on it forever.
      accepted.push(socket);
    });
    await new Promise<void>((done) => wedged.listen(0, "127.0.0.1", done));
    const port = String((wedged.address() as AddressInfo).port);
    try {
      const started = Date.now();
      const outcome = await runHealthcheck({ TMUX_SOCKET: tmuxSocket, AGENTDECK_PORT: port });
      assert.equal(outcome.code, 1, "a wedged server passed the health check");
      assert.match(outcome.stderr, /did not answer within/);
      assert.ok(
        Date.now() - started < 15000,
        "the check waited far longer than its own timeout window",
      );
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((done) =>
        wedged.close(() => {
          done();
        }),
      );
    }
  });

  void test("a 200 carrying ok:false is a different sentence from no answer at all", async () => {
    // The server's own tmux probe failing is not the socket failing, and the check is read by a
    // person at 2am. Same verdict, different sentence.
    probeOk = false;
    try {
      const outcome = await runHealthcheck({
        TMUX_SOCKET: tmuxSocket,
        AGENTDECK_PORT: healthPort,
      });
      assert.equal(outcome.code, 1, "a server reporting its own probe failed passed the check");
      assert.doesNotMatch(outcome.stderr, /no answer/);
      assert.match(outcome.stderr, /returned 503|does not report ok/);
    } finally {
      probeOk = true;
    }
  });
});

// tmux's two non-zero exits mean opposite things and share an exit code. A real server cannot be
// held in "no sessions", so a stub on PATH is the only way to reach the text this parses.
void describe("the tmux half tells an empty server apart from a missing one", () => {
  const stubbed = async (stderrText: string, exitCode: number): Promise<Outcome> => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-tmux-stub-"));
    try {
      const stub = join(dir, "tmux");
      writeFileSync(stub, `#!/bin/sh\necho '${stderrText}' >&2\nexit ${String(exitCode)}\n`);
      chmodSync(stub, 0o755);
      return await runHealthcheck({
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        TMUX_SOCKET: tmuxSocket,
        AGENTDECK_PORT: healthPort,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  void test("no sessions is a healthy server with nothing running in it yet", async () => {
    // The normal state right after boot. Calling it unhealthy is how a watchdog restarts a
    // perfectly good machine every time it comes up.
    probeOk = true;
    const outcome = await stubbed("no sessions", 1);
    assert.equal(outcome.code, 0, `an empty tmux server was called unhealthy: ${outcome.stderr}`);
  });

  void test("no server running took every session with it and is unhealthy", async () => {
    const outcome = await stubbed("no server running on /tmp/tmux-501/agentdeck", 1);
    assert.equal(outcome.code, 1, "a missing tmux server passed the health check");
    assert.match(outcome.stderr, /tmux server is not running/);
  });
});

// --- The three M0 entries ---

const entryFor = (todo: string, branch: string): string => {
  // The DEFINITION, which is bold, not the first mention: one item citing another in its prose
  // otherwise retargets every assertion below onto the wrong entry.
  const start = todo.indexOf(`**\`${branch}\`**`);
  assert.ok(start >= 0, `TODO.md has no ${branch} entry`);
  const from = todo.lastIndexOf("\n- ", start);
  const next = todo.indexOf("\n- ", start);
  return todo.slice(from, next === -1 ? undefined : next);
};

void describe("the three M0 items are decided the way the container's removal decides them", () => {
  void test("m0/dockerfile-multistage is struck as moot: there is no image to build", async () => {
    const entry = entryFor(await readDoc("TODO.md"), "m0/dockerfile-multistage");
    assert.match(entry, /^\n- \[x\]/, "the item is not closed");
    assert.match(entry, /~~/, "the item is not struck through");
    assert.match(entry, /MOOT/);
    assert.match(entry, /no image to build/);
  });

  void test("m0/tmux-version is struck as moot, and cites the tmux this host actually has", async () => {
    // The plans cite a verified tmux and the item's argument is that the host's is that one, so
    // asserting against `tmux -V` is what turns a claim into an observation.
    const todo = await readDoc("TODO.md");
    const entry = entryFor(todo, "m0/tmux-version");
    assert.match(entry, /^\n- \[x\]/, "the item is not closed");
    assert.match(entry, /~~/, "the item is not struck through");
    assert.match(entry, /MOOT/);

    const version = execFileSync("tmux", ["-V"], { encoding: "utf8" })
      .trim()
      .replace(/^tmux /, "");
    assert.ok(
      entry.includes(version),
      `the item cites a tmux this host does not have (host has ${version})`,
    );
    const wire = await readDoc("plans/002-wire-protocol.md");
    assert.ok(
      wire.includes(version),
      `plan 002 verifies its tmux behaviour against a version this host does not have (${version})`,
    );
  });

  void test("m0/supervisor-crash-test is restated, NOT struck - nothing brought node back", async () => {
    // The one that must survive: nothing on the Mac restarts node, so striking this deletes the
    // only record of a real gap. Ticking it is not striking it - its deliverable is the test.
    const entry = entryFor(await readDoc("TODO.md"), "m0/supervisor-crash-test");
    assert.match(entry, /^\n- \[[ x]\]/, "the item is neither open nor closed");
    assert.doesNotMatch(entry, /~~/, "the item was struck through; it is not moot");
    assert.doesNotMatch(entry, /\bMOOT\b/);
  });

  void test("m0/supervisor-crash-test says plainly what supervises node on this Mac", async () => {
    // It must name what supervises node or say plainly that nothing does: "not yet configured"
    // reads as a forgotten setup step. Whitespace-collapsed, or this tests the formatter.
    const entry = entryFor(await readDoc("TODO.md"), "m0/supervisor-crash-test").replace(
      /\s+/g,
      " ",
    );
    assert.match(entry, /\*\*Nothing supervises the node process on this Mac\.\*\*/);
    assert.match(entry, /m4\/launchd-watchdog/);
    // And what the gap costs, which is the part that decides whether it can be lived with: the
    // agents survive, the notification does not.
    assert.match(entry, /tmux is a daemon of its own/);
    assert.match(entry, /nothing restarted it/);
  });

  void test("the crash test's claim agrees with plan 003, which is the contract", async () => {
    const plan = await readDoc("plans/003-milestones.md");
    assert.match(plan, /launchd/);
    assert.match(plan, /Nothing supervises Node/);
  });

  void test("m0/container is marked moot and points at what superseded it", async () => {
    const entry = entryFor(await readDoc("TODO.md"), "m0/container");
    assert.match(entry, /~~/);
    assert.match(entry, /MOOT/);
    assert.match(entry, /m0\/de-containerise/);
  });
});
