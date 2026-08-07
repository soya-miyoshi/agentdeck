// m0/de-containerise, executed rather than asserted about.
//
// The item's done-when sentence has four halves and each one gets a test that runs the real
// thing: `grep -ril docker` over the tracked files; a suite with nothing left to self-skip;
// `scripts/healthcheck.mjs` spawned as a process against a real tmux server and a real
// /api/health handler; and the three M0 entries in TODO.md, one of which must NOT have been
// struck.
//
// Why documents get tests here at all: the container is the only thing this repository ever
// described that a reader could not check by running it, and it is now gone. A plan that still
// describes one is not a stale comment - it is the contract being wrong about the machine, and
// the next person builds against the contract. So the assertions below are about the five
// documents that described the container and about the three TODO entries that decided what to
// do with it, and they are written so that they fail against the pre-change tree.
//
// Two things this file deliberately did not assert - where the token file lives, and whether the
// cwd allowlist is a boundary - were open questions when it was written, and a test that pinned
// either would have been this file deciding a person's question. Both were decided on 2026-08-07
// by m0/host-boundary, so they are asserted now: by `src/containment.test.ts` for the token, and
// by `src/hub.test.ts` and `src/cwds.test.ts` for the allowlist.

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

// The documents that described a container. Plan 005 is absent on purpose: it is the record of
// the one that is gone. Plan 002 was absent too, with the comment "002 never described one" - it
// described one six times, in load-bearing places: `Session.cwd`, `Cwd.path`, the allowlist
// definition, the refusal rationale, the hook route, and the paragraph about one agent reading
// another's secrets. Plan 002 is the wire contract, so being wrong about the machine there is
// being wrong everywhere it is built against.
const decontainerised = [
  "README.md",
  "plans/001-architecture.md",
  "plans/002-wire-protocol.md",
  "plans/003-milestones.md",
  "plans/004-agent-profiles.md",
  "plans/006-availability.md",
  "mise.toml",
] as const;

// -----------------------------------------------------------------------------------------
// `grep -ril docker .` over the tracked files
// -----------------------------------------------------------------------------------------

// The done-when sentence names an exact result set, so the test is the command and the set,
// not a spot check. `git ls-files` rather than a directory walk, because the point of the
// sentence is the TRACKED files: node_modules and dist are full of the word and neither is
// something this repository says.
const trackedFiles = (): readonly string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((entry) => entry !== "");

// The retained deployment files, plus the two documents allowed to say why they were retained.
// audit.md is on this list for a reason worth writing down: it is an append-only ledger of what
// each iteration found, so its entries are a record of what was true then. Rewriting them to
// remove the word would be falsifying the ledger, which is a worse outcome than the grep hit.
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
  path === "src/de-containerise.test.ts";

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
    // A Dockerfile with no header is indistinguishable from a Dockerfile that is the way this
    // runs. The header is the whole reason keeping the file is honest rather than misleading,
    // so it has to be at the top where someone opening the file meets it first.
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
    // The plans are prose and a reader can discount them. A refusal message or a port-clash
    // message is what a person meets at the moment they are confused, and telling them to check
    // a container they do not have is the most expensive place to be wrong.
    for (const path of trackedFiles()) {
      if (!path.startsWith("src/") && !path.startsWith("scripts/")) continue;
      if (path === "src/de-containerise.test.ts") continue;
      const text = await readFile(`${repoRoot}${path}`, "utf8");
      assert.doesNotMatch(text, /docker/i, `${path} still describes Docker`);
      // `docker` was the only word this scanned, while the thing that is gone is the container:
      // src/ said "container" in four places the docker grep walked straight past, including a
      // docstring reasoning from "one container means one agent-state directory" - a premise the
      // next reader would carry forward into a machine that has none.
      //
      // Test files are exempt from THIS half and not from the docker half, because their subject
      // is partly the container's absence: `containment.test.ts` has to be able to say what the
      // container used to cover in order to assert that nothing still credits it.
      if (path.endsWith(".test.ts")) continue;
      assert.doesNotMatch(text, /\bcontainers?\b/i, `${path} still describes a container`);
    }
  });
});

// -----------------------------------------------------------------------------------------
// What each document had to say instead
// -----------------------------------------------------------------------------------------

// Removing a word is not the item. Each of these documents made a claim that DEPENDED on the
// container, and the test is that the replacement claim is present - otherwise the plans are
// merely silent about the thing they exist to describe, which is how the next person rebuilds
// the assumption from scratch.
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
    // The fragment used to land in a path that only existed inside the image. What the code does
    // is read AGENTDECK_AGENT_STATE_DIR, and the plan now says that - checked against src rather
    // than against itself, because agreeing with the wrong thing is the failure mode.
    const plan = await readDoc("plans/004-agent-profiles.md");
    assert.match(plan, /AGENTDECK_AGENT_STATE_DIR/);
    const server = await readDoc("src/server.ts");
    assert.match(server, /AGENTDECK_AGENT_STATE_DIR/);
  });

  void test("plan 006 costs a restart at a reconnect, and records the split option as taken", async () => {
    const plan = await readDoc("plans/006-availability.md");
    // The reserved option was to split tmux into its own container so the wedge-prone web server
    // could be restarted without it. Running on the host IS that split, for free, so the option
    // is spent rather than available - and an option recorded as available gets re-proposed.
    assert.match(plan, /recorded as taken rather than as available/);
    assert.match(plan, /no supervisor at all/);
  });

  void test("the README names the token's home, which m0/host-boundary decided", async () => {
    // Open when this file was written and decided since: ~/.agentdeck/token. The README is where
    // a person meets it, and "recorded as open" left there after the decision is the same wrong
    // answer as the container path was.
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

// -----------------------------------------------------------------------------------------
// Nothing is left to self-skip
// -----------------------------------------------------------------------------------------

void describe("the suite has nothing left that skips itself", () => {
  // This file is excluded from its own scan. It is the one test file that must contain the
  // markers as literals - they are its search patterns - so scanning itself reports the scanner
  // rather than a skipped suite, and the failure looks exactly like the thing it exists to catch.
  const testFiles = (): readonly string[] =>
    trackedFiles().filter(
      (path) => path.endsWith(".test.ts") && !path.endsWith("de-containerise.test.ts"),
    );

  void test("no suite marks itself skipped or todo", async () => {
    // The in-image toolchain assertions were removed rather than left to notice they were not in
    // an image and pass silently. A skipped test reports as a pass in every summary a person
    // reads, so this is the difference between coverage and the appearance of it.
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
    // The self-skip that mattered was the one keyed on the environment: inside the image it ran,
    // on the Mac it quietly did not. There is no image now, so any such probe is a test that
    // never runs anywhere.
    for (const path of testFiles()) {
      const text = await readFile(`${repoRoot}${path}`, "utf8");
      assert.doesNotMatch(text, /\.dockerenv/, `${path} probes for a container`);
    }
  });
});

// -----------------------------------------------------------------------------------------
// scripts/healthcheck.mjs, run on the host
// -----------------------------------------------------------------------------------------

interface Outcome {
  readonly code: number;
  readonly stderr: string;
}

// Spawned as a process, because the exit code IS the interface: the M4 watchdog will read
// nothing else, and a function returning a string proves nothing about what `node
// scripts/healthcheck.mjs` does.
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

// A tmux server that exists, on a socket of this suite's own, so the tmux half is genuinely
// healthy while the HTTP half is what the test varies. Without this every failure below would
// pass for the wrong reason.
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
      registry: new Registry(tmux, profiles, allowlist),
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
    // The done-when sentence: it fails when the server is down. This is the case the check used
    // to miss entirely - tmux is a daemon of its own, so it stays up through a node crash and a
    // tmux-only check reports a machine with no server on it as healthy.
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
    // The failure the HTTP half exists for. A wedged event loop does not refuse connections, so
    // a check that only tests reachability calls it healthy and a check with no timeout hangs
    // forever - which for a watchdog is the same as never alerting.
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

// The tmux half's two non-zero exits mean opposite things and cannot be told apart by exit code.
// A real tmux server cannot be held in the "no sessions" state - it exits when its last session
// dies - so the branch is driven with a stub tmux on PATH, which is the only way to reach the
// text this parsing exists for.
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

// -----------------------------------------------------------------------------------------
// The three M0 entries
// -----------------------------------------------------------------------------------------

const entryFor = (todo: string, branch: string): string => {
  const start = todo.indexOf(`\`${branch}\``);
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
    // Plans 001 and 002 cite a verified tmux, and the item's whole argument is that the host's
    // is that one. Asserting the number against `tmux -V` is the difference between a claim and
    // an observation - if the Mac is upgraded, the plans' "verified" citations are stale and
    // this is what says so.
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
    // The one that must survive. PID 1 was what restarted the node process, and on the Mac
    // nothing does, so striking this item would delete the only record of a real gap. The test
    // is deliberately the inverse of the two above: still open, still a branch to do.
    const entry = entryFor(await readDoc("TODO.md"), "m0/supervisor-crash-test");
    assert.match(entry, /^\n- \[ \]/, "the item was closed; nothing supervises node yet");
    assert.doesNotMatch(entry, /~~/, "the item was struck through; it is not moot");
    assert.doesNotMatch(entry, /\bMOOT\b/);
  });

  void test("m0/supervisor-crash-test says plainly what supervises node on this Mac", async () => {
    // The done-when sentence: it names what supervises node, or says plainly that nothing does
    // until m4/launchd-watchdog. Vagueness here is the whole failure - "supervision is not yet
    // configured" reads like a setup step someone forgot rather than a designed gap.
    // Whitespace-collapsed: these are wrapped prose, and a test that failed on where the line
    // broke would be testing the formatter.
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
