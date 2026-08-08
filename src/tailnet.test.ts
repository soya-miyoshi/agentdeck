// The two admin-console preconditions `tailscale serve` has and the CLI does not report well.
//
// The fixtures here are the real shape of `tailscale status --json` from the development Mac on
// 2026-08-08, with HTTPS certificates disabled - `"CertDomains": null` - which is the state this
// item was written against and the one the report exists for.

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ADMIN_DNS_PAGE,
  parseTailnetStatus,
  readTailnet,
  tailnetAdvice,
  tailscaleBinary,
} from "./tailnet.ts";

const certsOff = {
  Self: { DNSName: "example-host.tailXXXXXX.ts.net." },
  CertDomains: null,
  MagicDNSSuffix: "tailXXXXXX.ts.net",
};

const certsOn = {
  Self: { DNSName: "example-host.tailXXXXXX.ts.net." },
  CertDomains: ["example-host.tailXXXXXX.ts.net"],
  MagicDNSSuffix: "tailXXXXXX.ts.net",
};

void describe("tailnet status", () => {
  void test("the origin drops DNSName's trailing dot", () => {
    assert.equal(
      parseTailnetStatus(certsOff).origin,
      "https://example-host.tailXXXXXX.ts.net",
    );
  });

  void test("a null CertDomains is HTTPS certificates being off", () => {
    assert.equal(parseTailnetStatus(certsOff).httpsCertificates, false);
    assert.equal(parseTailnetStatus(certsOn).httpsCertificates, true);
  });

  void test("no MagicDNS name means no origin rather than a broken one", () => {
    const tailnet = parseTailnetStatus({ Self: {}, CertDomains: null });
    assert.equal(tailnet.origin, undefined);
  });
});

void describe("which tailscale is executed", () => {
  void test("AGENTDECK_TAILSCALE wins, and only if it exists", () => {
    const previous = process.env["AGENTDECK_TAILSCALE"];
    try {
      process.env["AGENTDECK_TAILSCALE"] = "/bin/sh";
      assert.equal(tailscaleBinary(), "/bin/sh");
      // A named binary that is not there is undefined rather than a PATH fallback: PATH order
      // buys nothing when the only copy lives in a directory this uid can write (watchdog audit).
      process.env["AGENTDECK_TAILSCALE"] = "/nowhere/tailscale";
      assert.equal(tailscaleBinary(), undefined);
    } finally {
      if (previous === undefined) delete process.env["AGENTDECK_TAILSCALE"];
      else process.env["AGENTDECK_TAILSCALE"] = previous;
    }
  });
});

void describe("what the operator is told", () => {
  void test("certificates off names the state, the settings page and the hang", () => {
    const advice = tailnetAdvice(parseTailnetStatus(certsOff), 7777, undefined).join("\n");
    assert.match(advice, /HTTPS certificates are DISABLED/);
    assert.ok(advice.includes(ADMIN_DNS_PAGE));
    // The single most useful thing this report does: `tailscale serve` with Serve not enabled
    // prints a link and then never exits, so an unattended caller hangs instead of failing.
    assert.match(advice, /waits forever|timeout/);
  });

  void test("the AGENTDECK_ORIGIN advice names the actual value, not a placeholder", () => {
    const advice = tailnetAdvice(parseTailnetStatus(certsOn), 7777, undefined).join("\n");
    assert.match(advice, /AGENTDECK_ORIGIN=https:\/\/example-host\.tailXXXXXX\.ts\.net\b/);
    assert.doesNotMatch(advice, /<host>/);
  });

  void test("the serve command names the port the server actually listened on", () => {
    const advice = tailnetAdvice(parseTailnetStatus(certsOn), 7999, undefined).join("\n");
    assert.match(advice, /tailscale serve --bg 7999/);
  });

  void test("an origin that is not this machine's is called out rather than left to a 403", () => {
    const advice = tailnetAdvice(
      parseTailnetStatus(certsOn),
      7777,
      "https://somewhere-else.ts.net",
    ).join("\n");
    assert.match(advice, /403/);
  });

  void test("a configured origin that matches is not nagged about", () => {
    const advice = tailnetAdvice(
      parseTailnetStatus(certsOn),
      7777,
      "https://example-host.tailXXXXXX.ts.net",
    ).join("\n");
    assert.doesNotMatch(advice, /AGENTDECK_ORIGIN=/);
    assert.doesNotMatch(advice, /403/);
  });

  void test("no tailscale at all says so instead of claiming a URL", () => {
    const advice = tailnetAdvice(undefined, 7777, undefined).join("\n");
    assert.match(advice, /could not read `tailscale status --json`/);
    assert.doesNotMatch(advice, /https:\/\/[a-z0-9-]+\.ts\.net/);
  });
});

void describe("plan 006 is where this shape is written down", () => {
  void test("the plan names both switches, the hang and the admin page", async () => {
    const plan = await readFile(new URL("../plans/006-availability.md", import.meta.url), "utf8");
    assert.match(plan, /CertDomains/);
    assert.match(plan, /Serve is not enabled on your tailnet/);
    assert.ok(plan.includes(ADMIN_DNS_PAGE));
    // Reporting only: nothing in agentdeck runs `tailscale serve`, and the plan has to say so
    // because the obvious next commit is the one that does it automatically.
    assert.match(plan, /agentdeck does not run `tailscale serve` itself/);
  });
});

// --- The reader itself, and the boot that prints what it found. ---
//
// Everything above is pure. What follows drives `readTailnet` and then a whole `node src/server.ts`
// against a STUB tailscale, the way src/watchdog.test.ts does: AGENTDECK_TAILSCALE names an
// absolute path and the stub is a shell script. The real CLI is never run here - one switch is off
// on this Mac, so the only reachable real answer is the refusal, and a stub can reach both.

const serverPath = fileURLToPath(new URL("server.ts", import.meta.url));
const run = promisify(execFile);

let dir = "";
let stub = "";

/** A `tailscale` printing the given body for `status --json`, after `delay` seconds. The delay is
 *  the wedged `tailscaled` a boot must not wait for. */
const stubStatus = (body: string, options: { delay?: number; exit?: number } = {}): void => {
  writeFileSync(
    stub,
    `#!/bin/sh
sleep ${String(options.delay ?? 0)}
echo 'Warning: client version mismatch' >&2
cat <<'JSON'
${body}
JSON
exit ${String(options.exit ?? 0)}
`,
    { mode: 0o755 },
  );
};

const withStub = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = process.env["AGENTDECK_TAILSCALE"];
  process.env["AGENTDECK_TAILSCALE"] = stub;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["AGENTDECK_TAILSCALE"];
    else process.env["AGENTDECK_TAILSCALE"] = previous;
  }
};

const sockets: string[] = [];

interface Boot {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Boot the real server against the stub and collect what it said, resolving on the listening line
 *  or on exit so a boot that hangs fails rather than passing slowly. */
const boot = async (env: Record<string, string>): Promise<Boot> => {
  const socket = `agentdeck-tailnet-${String(process.pid)}-${String(sockets.length)}`;
  sockets.push(socket);
  const home = mkdtempSync(join(tmpdir(), "agentdeck-tailnet-home-"));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      TMUX_SOCKET: socket,
      HOME: home,
      AGENTDECK_PORT: "0",
      AGENTDECK_TAILSCALE: stub,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  try {
    return await new Promise<Boot>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the server neither listened nor exited in 20s\n${stdout}\n${stderr}`));
      }, 20_000);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("listening on")) child.kill("SIGTERM");
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

void describe("reading the tailnet", () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "agentdeck-tailnet-"));
    stub = join(dir, "tailscale");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const socket of sockets) {
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      } catch {
        // Already gone: the desired end state.
      }
    }
  });

  void test("the two facts come back out of the process, warnings on stderr and all", async () => {
    stubStatus(JSON.stringify(certsOff));
    const tailnet = await withStub(readTailnet);
    assert.deepEqual(tailnet, {
      origin: "https://example-host.tailXXXXXX.ts.net",
      httpsCertificates: false,
    });
  });

  void test("no binary at the named path is undefined, not a throw and not a PATH search", async () => {
    const previous = process.env["AGENTDECK_TAILSCALE"];
    process.env["AGENTDECK_TAILSCALE"] = join(dir, "nowhere", "tailscale");
    try {
      assert.equal(await readTailnet(), undefined);
    } finally {
      if (previous === undefined) delete process.env["AGENTDECK_TAILSCALE"];
      else process.env["AGENTDECK_TAILSCALE"] = previous;
    }
  });

  void test("output that is not JSON is nothing known, not a crashed boot", async () => {
    stubStatus("tailscaled is not running");
    assert.equal(await withStub(readTailnet), undefined);
  });

  void test("a non-zero exit is nothing known", async () => {
    stubStatus(JSON.stringify(certsOn), { exit: 1 });
    assert.equal(await withStub(readTailnet), undefined);
  });

  void test("a tailscale that never answers is timed out, not waited on", async () => {
    // The done-when's timeout clause on the read side: a wedged tailscaled must cost a boot a
    // bounded few seconds, not the boot.
    stubStatus(JSON.stringify(certsOn), { delay: 30 });
    const started = Date.now();
    assert.equal(await withStub(readTailnet), undefined);
    assert.ok(Date.now() - started < 10_000, "readTailnet waited on a wedged tailscale");
  });

  void test("the boot names the missing switch, the page, and still serves loopback", async () => {
    stubStatus(JSON.stringify(certsOff));
    const { stdout, stderr } = await boot({});
    assert.match(stdout, /listening on/, "a tailnet with a switch off stopped the server booting");
    assert.match(stderr, /HTTPS certificates are DISABLED/);
    assert.ok(stderr.includes(ADMIN_DNS_PAGE));
  });

  void test("the boot prints the AGENTDECK_ORIGIN to run behind the proxy, in full", async () => {
    // The done-when: agentdeck knows the origin it should be run with, and says it - not a
    // placeholder a person has to fill in from a hostname they have to go and find.
    stubStatus(JSON.stringify(certsOn));
    const { stderr } = await boot({});
    assert.match(stderr, /AGENTDECK_ORIGIN=https:\/\/example-host\.tailXXXXXX\.ts\.net\b/);
    assert.match(stderr, /tailscale serve --bg \d+/);
  });

  void test("an AGENTDECK_ORIGIN that is not this machine's is called out at boot", async () => {
    stubStatus(JSON.stringify(certsOn));
    const { stderr } = await boot({ AGENTDECK_ORIGIN: "https://other.tailXXXXXX.ts.net" });
    assert.match(stderr, /403/);
    assert.doesNotMatch(stderr, /AGENTDECK_ORIGIN is not set/);
  });

  void test("the right AGENTDECK_ORIGIN boots quietly", async () => {
    stubStatus(JSON.stringify(certsOn));
    const { stdout, stderr } = await boot({
      AGENTDECK_ORIGIN: "https://example-host.tailXXXXXX.ts.net",
    });
    assert.match(stdout, /listening on/);
    assert.doesNotMatch(stderr, /AGENTDECK_ORIGIN=/);
    assert.doesNotMatch(stderr, /403/);
  });

  void test("a wedged tailscale delays the boot by seconds, it does not prevent it", async () => {
    stubStatus(JSON.stringify(certsOn), { delay: 30 });
    const { stdout, stderr } = await boot({});
    assert.match(stdout, /listening on/, "a hanging tailscale took the server down with it");
    assert.match(stderr, /could not read `tailscale status --json`/);
  });
});

void describe("the real tailscale still reports what the parser reads", () => {
  void test("Self.DNSName and CertDomains are the fields this version emits", async () => {
    // Not a fixture: the field NAMES are the assumption that a tailscale upgrade could break
    // silently, turning "certificates are off" into a permanent wrong answer. Skipped where there
    // is no tailscale, and never mutating - `status --json` only.
    const binary = tailscaleBinary();
    if (binary === undefined || process.env["AGENTDECK_TAILSCALE"] !== undefined) return;
    let raw: string;
    try {
      ({ stdout: raw } = await run(binary, ["status", "--json"], { timeout: 5000 }));
    } catch {
      return; // Not logged in, or tailscaled is down: nothing to check against.
    }
    const status = JSON.parse(raw) as Record<string, unknown>;
    assert.ok("CertDomains" in status, "tailscale no longer reports CertDomains");
    const self = status["Self"] as { DNSName?: unknown };
    assert.equal(typeof self.DNSName, "string");
    assert.match(self.DNSName as string, /\.$/, "DNSName lost the trailing dot the parser strips");
  });
});
