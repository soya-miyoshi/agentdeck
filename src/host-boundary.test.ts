// The halves that are properties of a BOOT rather than a function: the old token default was a path
// no ordinary Mac user can create, so the server died before the port. HOME is the clean host.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
 * Start the server as a process and resolve once it has said what it was going to say - the
 * listening line, or exit, so a refusal meant to be immediate cannot pass by hanging.
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
    // The pre-change default is not writable by this user on a Mac, so this test fails against that
    // tree by never printing a listening line.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-clean-home-"));
    try {
      const { code, signal, stdout } = await boot({ HOME: home, AGENTDECK_PORT: "0" });
      assert.match(stdout, /listening on 127\.0\.0\.1/, "the server did not reach the port");
      // Either exit is fine - the SIGTERM can land before the shutdown handler is installed. What
      // must not happen is a non-zero exit, which is the server failing after claiming the port.
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
    // The fallback used to be the operator's live Claude config, rewritten every boot. Both halves
    // are checked: the warning fires on the variable being unset, and the directory is untouched.
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
    // Plan 005 states this in prose three times and nothing checked it. There is no degraded mode,
    // so the assertion is on the exit code as much as on the sentence.
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
    // `command` and `args` go unmodified into `tmux new-session --` and run as the human, so a
    // profiles file inside an allowlisted tree lets an agent choose what the next session executes.
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

  void test("the SECURITY.md review list and plan 005 both name it", async () => {
    // It was on neither, which is how the most direct execution surface of the lot went
    // unreviewed by the checklist that exists for exactly this.
    const security = await readDoc("SECURITY.md");
    const list = security.slice(security.indexOf("clean of unreviewed agent edits"));
    assert.match(list.slice(0, 1200), /AGENTDECK_PROFILES/);
    const plan = await readDoc("plans/005-containment.md");
    assert.match(plan.slice(0, plan.indexOf("\n## ", 1)), /AGENTDECK_PROFILES/);
  });
});

// `dist/client` is published UNAUTHENTICATED, and the allowlist rule cannot see it: with this repo
// off AGENTDECK_MOUNTS the boot check passes while the token is downloadable by filename.
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

  void test("a symlink at the token path cannot smuggle it in either", async () => {
    // Both refusals compared LEXICAL paths while `writeFileSync` follows symlinks, so a link into
    // the publish root passed both and the first boot created a downloadable 0600 file there.
    const home = mkdtempSync(join(tmpdir(), "agentdeck-symlinked-"));
    const planted = join(clientDir, `smuggled-${String(process.pid)}`);
    mkdirSync(join(home, ".agentdeck"), { recursive: true });
    symlinkSync(planted, join(home, ".agentdeck", "token"));
    try {
      const result = await boot({ HOME: home, AGENTDECK_PORT: "0" });
      assert.notEqual(result.code, 0, "a symlinked token path started the server");
      assert.match(result.stderr, /UNAUTHENTICATED/);
      assert.equal(existsSync(planted), false, "the token was written into the publish root");
    } finally {
      rmSync(planted, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
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
    // The leak was documented by a mechanism macOS does not have, while the easier one went
    // unmentioned - so a reader checking the Linux path concludes the hazard is absent.
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
    // A hand-started session no longer becomes a tab - a real loss, decided deliberately, and only
    // reviewable if it is written where the boundary is described.
    const plan = await readDoc("plans/005-containment.md");
    const header = plan.slice(0, plan.indexOf("\n## ", 1));
    assert.match(header, /allowlist/i);
    assert.match(header, /by hand|hand-started/i, "the cost of the boundary is not written down");
  });
});
