// m0/host-boundary's done-when sentence, for the halves that are properties of a BOOT rather
// than of a function.
//
// `src/containment.test.ts` already tests `defaultTokenFile`, `tokenInsideAllowlist` and
// `loadToken` as functions, and `src/tmux.test.ts` drives a real tmux server for the environment
// and the secret. What neither can show is the clause the finding was actually confirmed by hand
// against: "`pnpm start` works on a clean host with no environment variables set, and refuses to
// start if the token path resolves inside an allowlist entry". The old default,
// `/var/lib/agentdeck/token`, is a path no ordinary Mac user can create, so the server died on
// the token before it ever reached the port - a failure that only exists end to end, in a process
// started the way a person starts it. So these tests spawn `node src/server.ts`.
//
// Three variables are set that a person would not have to set, and no others. TMUX_SOCKET,
// because the default socket name is the operator's live one and a test must not create sessions
// on it or kill it. AGENTDECK_PORT, because 7777 may be a running agentdeck. PATH, because the
// child has to find `tmux` and `node`. HOME is pointed at an empty directory, which is the whole
// point: it stands in for the clean host.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("..", import.meta.url);
const serverPath = fileURLToPath(new URL("server.ts", import.meta.url));

const readDoc = async (name: string): Promise<string> =>
  await readFile(new URL(name, repoRoot), "utf8");

interface Boot {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const sockets: string[] = [];

after(() => {
  for (const socket of sockets) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // Already gone: the desired end state.
    }
  }
});

/**
 * Start the server as a process and resolve once it has said what it was going to say.
 *
 * Resolves on the listening line for a successful boot, or on exit for a refusal, so that a
 * refusal that is meant to be immediate cannot pass by hanging instead.
 */
const boot = async (env: Record<string, string>): Promise<Boot> => {
  const socket = `agentdeck-boot-${String(process.pid)}-${String(sockets.length)}`;
  sockets.push(socket);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      TMUX_SOCKET: socket,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  return await new Promise<Boot>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the server neither listened nor exited within 20s\n${stdout}\n${stderr}`));
    }, 20_000);
    timer.unref();
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("listening on")) {
        child.kill("SIGTERM");
        // Not resolving here: let the exit handler run, so the process is reaped either way.
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", done);
  });
};

void describe("a clean host, which is what the container-era token home made impossible", () => {
  void test("`pnpm start` reaches the port with nothing set, and leaves a 0600 token", async () => {
    // The pre-change default was /var/lib/agentdeck/token. On this Mac that is not writable by
    // this user, and it was confirmed by hand that the server refused to start - so this test
    // fails against the pre-change tree by never printing a listening line.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clean-home-"));
    try {
      const { code, signal, stdout } = await boot({ HOME: home, AGENTDECK_PORT: "0" });
      assert.match(stdout, /listening on 127\.0\.0\.1/, "the server did not reach the port");
      // Either exit is fine: the SIGTERM that ends the test can land in the window between
      // listening and the shutdown handler being installed. What must not happen is a non-zero
      // exit, which would be the server failing after it claimed the port.
      assert.ok(code === 0 || signal === "SIGTERM", `boot exited ${String(code)}`);

      const tokenPath = join(home, ".agentdeck", "token");
      const stat = statSync(tokenPath);
      assert.equal(
        stat.mode & 0o777,
        0o600,
        "the token is readable by more than its owner on first run",
      );
      assert.match(readFileSync(tokenPath, "utf8").trim(), /^[A-Za-z0-9_-]{20,}$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  void test("the same token is reused on the next boot rather than rotated", async () => {
    // A token regenerated at every start logs the phone out on every restart, and plan 006 prices
    // a restart at what the sessions lose - not at re-pairing the client.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clean-home-"));
    try {
      await boot({ HOME: home, AGENTDECK_PORT: "0" });
      const first = readFileSync(join(home, ".agentdeck", "token"), "utf8");
      await boot({ HOME: home, AGENTDECK_PORT: "0" });
      assert.equal(readFileSync(join(home, ".agentdeck", "token"), "utf8"), first);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  void test("the agent-state directory is agentdeck's own, and a live Claude config is untouched", async () => {
    // The fallback used to be CLAUDE_CONFIG_DIR, the operator's live config, rewritten every
    // boot - including for sessions agentdeck has nothing to do with. So the check is both
    // halves: the warning fires whenever AGENTDECK_AGENT_STATE_DIR itself is unset (the
    // silent-landing case was exactly the one where CLAUDE_CONFIG_DIR was set), and the directory
    // it names is not written to.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clean-home-"));
    const claude = mkdtempSync(join(tmpdir(), "agentdeck-live-claude-"));
    try {
      const { stderr } = await boot({
        HOME: home,
        AGENTDECK_PORT: "0",
        CLAUDE_CONFIG_DIR: claude,
      });
      assert.match(stderr, /AGENTDECK_AGENT_STATE_DIR is not set/);
      assert.match(stderr, new RegExp(join(home, ".agentdeck", "agent-state")));
      assert.doesNotMatch(stderr, new RegExp(claude), "the boot pointed at the live config");
      assert.deepEqual(
        execFileSync("ls", ["-A", claude], { encoding: "utf8" }).trim(),
        "",
        "agentdeck wrote into the operator's live Claude config",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
    }
  });

  void test("the Origin check being off is said at boot, not only in a comment", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clean-home-"));
    try {
      const { stderr } = await boot({ HOME: home, AGENTDECK_PORT: "0" });
      assert.match(stderr, /AGENTDECK_ORIGIN is not set/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

void describe("the token is never inside a tree a session is pointed at", () => {
  void test("a token under an allowlisted directory is a refusal to start, not a warning", async () => {
    // Plan 005 states this in prose in three places and nothing checked it. There is no degraded
    // mode: starting anyway serves precisely the situation the rule exists to prevent, and does it
    // silently, so the assertion is on the exit code as much as on the sentence.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clash-home-"));
    try {
      const { code, stderr, stdout } = await boot({
        HOME: home,
        AGENTDECK_PORT: "0",
        AGENTDECK_MOUNTS: home,
      });
      assert.equal(code, 1, "the server started with its token inside an allowlisted tree");
      assert.doesNotMatch(stdout, /listening on/);
      assert.match(stderr, new RegExp(join(home, ".agentdeck", "token")));
      assert.match(stderr, new RegExp(home));
      // The sentence has to say what to change, both ways round.
      assert.match(stderr, /AGENTDECK_MOUNTS/);
      assert.match(stderr, /grep -rn token/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  void test("the refusal happens before the token file is created", async () => {
    // Writing it and then refusing would leave the token sitting in the allowlisted tree, which
    // is the whole hazard, with the server that could have used it gone.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clash-home-"));
    try {
      await boot({ HOME: home, AGENTDECK_PORT: "0", AGENTDECK_MOUNTS: home });
      assert.throws(
        () => statSync(join(home, ".agentdeck", "token")),
        /ENOENT/,
        "a token was written into the tree the refusal exists to keep it out of",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  void test("an allowlist that does not contain the token is an ordinary boot", async () => {
    // The refusal has to be about containment rather than about AGENTDECK_MOUNTS being set at
    // all, or the check is a way of turning the allowlist off.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clean-home-"));
    const work = mkdtempSync(join(tmpdir(), "agentdeck-work-"));
    try {
      const { code, signal, stdout } = await boot({
        HOME: home,
        AGENTDECK_PORT: "0",
        AGENTDECK_MOUNTS: work,
      });
      assert.match(stdout, /listening on 127\.0\.0\.1/);
      assert.ok(code === 0 || signal === "SIGTERM", `boot exited ${String(code)}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

void describe("the agent profiles file is a host-execution surface, not config", () => {
  void test("a profiles file inside an allowlisted tree refuses the boot", async () => {
    // `command` and `args` go unmodified into `tmux new-session -- command args` and run as the
    // human, so a profiles file inside a tree an agent is started in lets that agent choose what
    // the next session executes - and no prescribed review command looks at the file. The same
    // rule as the token, for the file that is the more direct surface of the two.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-prof-home-"));
    const work = mkdtempSync(join(tmpdir(), "agentdeck-prof-work-"));
    try {
      const profiles = join(work, "agents.json");
      writeFileSync(profiles, JSON.stringify({ shell: { command: "/bin/sh" } }));
      const { code, stderr } = await boot({
        HOME: home,
        AGENTDECK_PORT: "0",
        AGENTDECK_MOUNTS: work,
        AGENTDECK_PROFILES: profiles,
      });
      assert.equal(code, 1, `boot should have refused\n${stderr}`);
      assert.match(stderr, /profiles file/i);
      assert.match(stderr, /AGENTDECK_MOUNTS/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  void test("a profiles file outside every entry is an ordinary boot", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentdeck-prof2-home-"));
    const work = mkdtempSync(join(tmpdir(), "agentdeck-prof2-work-"));
    const conf = mkdtempSync(join(tmpdir(), "agentdeck-prof2-conf-"));
    try {
      const profiles = join(conf, "agents.json");
      writeFileSync(profiles, JSON.stringify({ shell: { command: "/bin/sh" } }));
      const { code, signal, stdout } = await boot({
        HOME: home,
        AGENTDECK_PORT: "0",
        AGENTDECK_MOUNTS: work,
        AGENTDECK_PROFILES: profiles,
      });
      assert.match(stdout, /listening on 127\.0\.0\.1/);
      assert.ok(code === 0 || signal === "SIGTERM", `boot exited ${String(code)}`);
    } finally {
      for (const dir of [home, work, conf]) rmSync(dir, { recursive: true, force: true });
    }
  });

  void test("the README review list and plan 005 both name it", async () => {
    // It was on neither, which is how the most direct execution surface of the lot went
    // unreviewed by the checklist that exists for exactly this.
    const readme = await readDoc("README.md");
    const list = readme.slice(readme.indexOf("clean of unreviewed agent edits"));
    assert.match(list.slice(0, 1200), /AGENTDECK_PROFILES/);
    const plan = await readDoc("plans/005-containment.md");
    assert.match(plan.slice(0, plan.indexOf("\n## ", 1)), /AGENTDECK_PROFILES/);
  });
});

// `dist/client` is published UNAUTHENTICATED - the page has to load before a token exists - so it
// is the second location a credential must never be placed in, and the allowlist rule cannot see
// it: if this repo is not itself on AGENTDECK_MOUNTS, `tokenInsideAllowlist` says nothing and the
// boot check passes while the token is downloadable at a URL equal to its filename.
void describe("the published build directory is a place a secret cannot go", () => {
  const clientDir = fileURLToPath(new URL("../dist/client", import.meta.url));

  void test("a token file inside it is a refusal, not a warning", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentdeck-published-"));
    const result = await boot({
      HOME: home,
      AGENTDECK_PORT: "0",
      AGENTDECK_TOKEN_FILE: join(clientDir, "token"),
    });
    assert.notEqual(result.code, 0, "the server started with its token in a published directory");
    assert.match(result.stderr, /UNAUTHENTICATED/);
    assert.match(result.stderr, /dist\/client/);
    rmSync(home, { recursive: true, force: true });
  });

  void test("so is a profiles file, which is the more direct execution surface", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentdeck-published-"));
    const result = await boot({
      HOME: home,
      AGENTDECK_PORT: "0",
      AGENTDECK_PROFILES: join(clientDir, "agents.json"),
    });
    assert.notEqual(
      result.code,
      0,
      "the server started with its profiles in a published directory",
    );
    assert.match(result.stderr, /UNAUTHENTICATED/);
    rmSync(home, { recursive: true, force: true });
  });
});

void describe("the documents name the mechanism this host has", () => {
  void test("plan 002 replaces /proc/<pid>/environ with the tmux read that was real here", async () => {
    // The leak was documented as one agent reading another's /proc/<pid>/environ, a path macOS
    // does not have - so the plan described a hazard by a mechanism absent on this machine while
    // the easier one, `tmux show-environment -t`, went unmentioned. A reader checking the Linux
    // path and not finding it concludes the hazard is absent.
    const plan = await readDoc("plans/002-wire-protocol.md");
    const start = plan.indexOf("/proc/<pid>/environ");
    assert.notEqual(start, -1, "plan 002 should still name the path, as the thing being corrected");
    const section = plan.slice(start, start + 1600);
    assert.match(section, /macOS does not have/);
    assert.match(section, /show-environment/, "the mechanism this host actually had is unnamed");
    assert.match(section, /same uid/i, "what remains open is not stated");
  });

  void test("the README's Environment section is where AGENTDECK_ORIGIN can be found", async () => {
    // It was in no README section and no example env file, so an ordinary run accepted any
    // Origin and nothing a person reads said so.
    const readme = await readDoc("README.md");
    const start = readme.indexOf("## Environment");
    assert.notEqual(start, -1, "the README has no Environment section");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    for (const name of [
      "AGENTDECK_PORT",
      "AGENTDECK_TOKEN_FILE",
      "AGENTDECK_MOUNTS",
      "AGENTDECK_PROFILES",
      "AGENTDECK_AGENT_STATE_DIR",
      "AGENTDECK_ORIGIN",
      "TMUX_SOCKET",
    ])
      assert.match(section, new RegExp(name), `${name} is not in the README's Environment section`);
    assert.match(section, /~\/\.agentdeck\/token/);
  });

  void test("every variable the server reads is in that section, so the table cannot drift", async () => {
    const readme = await readDoc("README.md");
    const start = readme.indexOf("## Environment");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    const server = await readDoc("src/server.ts");
    const read = new Set(
      [...server.matchAll(/process\.env\["([A-Z_]+)"\]|env\("([A-Z_]+)"/g)].map(
        (match) => match[1] ?? match[2] ?? "",
      ),
    );
    for (const name of read)
      assert.match(section, new RegExp(name), `src/server.ts reads ${name}; the README does not`);
  });
});

void describe("the audit's own section is closed out", () => {
  void test("every finding under m0/de-containerise is fixed or accepted with a reason", async () => {
    // The last clause of the done-when sentence. A finding with no status is one nobody decided
    // about, which is indistinguishable from one that was missed.
    const audit = await readDoc("audit.md");
    const start = audit.indexOf("## m0/de-containerise - 2026-08-07");
    assert.notEqual(start, -1, "the audit section this item answers is missing");
    const section = audit.slice(start, audit.indexOf("\n## ", start + 1));
    const findings = section
      .split(/\n- \[(?=high|medium|low)/)
      .slice(1)
      // The findings are wrapped prose, so a status can straddle a line break. Compare against
      // one long line rather than making the audit's line wrapping load-bearing.
      .map((entry) => (entry.split(/\n(?=- \[|#{2,} )/)[0] ?? "").replace(/\s+/g, " "));
    assert.equal(findings.length, 12, "the section should carry the twelve findings filed");
    for (const finding of findings) {
      const where = (/^\w+\] ([^\s]+)/.exec(finding) ?? [])[1] ?? finding.slice(0, 40);
      assert.match(
        finding,
        /Status: (FIXED|ACCEPTED WITH A REASON)/,
        `the finding at ${where} has no status`,
      );
      if (!finding.includes("ACCEPTED WITH A REASON")) continue;
      assert.match(finding, /because|since/i, `the acceptance at ${where} carries no reason`);
    }
  });

  void test("the resource half is accepted with an owner rather than silently dropped", async () => {
    // The decision was explicitly not to invent a cpu or memory limit on this branch, so what
    // makes that a decision rather than an omission is the item that carries it.
    const audit = await readDoc("audit.md");
    const start = audit.indexOf("## m0/de-containerise - 2026-08-07");
    const section = audit.slice(start, audit.indexOf("\n## ", start + 1));
    const accepted = section.slice(section.indexOf("plans/005-containment.md:8"));
    assert.match(accepted, /m4\/launchd-watchdog/);
    assert.match(accepted, /LaunchAgents/);

    const plan = await readDoc("plans/005-containment.md");
    const header = plan.slice(0, plan.indexOf("\n## ", 1));
    assert.match(header, /cpus/);
    assert.match(header, /mem_limit/);
    assert.match(header, /LaunchAgents/);
    assert.match(header, /m4\/launchd-watchdog/);
  });

  void test("plan 005 records the accepted cost of the allowlist being a boundary", async () => {
    // A session started by hand in tmux no longer becomes a tab. That is a real loss of a real
    // behaviour, decided deliberately, and the decision is only reviewable if it is written down
    // where the boundary is described rather than left implicit in Hub.sync.
    const plan = await readDoc("plans/005-containment.md");
    const header = plan.slice(0, plan.indexOf("\n## ", 1));
    assert.match(header, /allowlist/i);
    assert.match(header, /by hand|hand-started/i, "the cost of the boundary is not written down");
  });
});
