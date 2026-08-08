// scripts/tailscale-serve.mjs: the one command the operator runs, driven against a STUB tailscale.
//
// Both tailnet switches are off on this Mac (TODO.md), so the success path cannot be run against
// the real CLI. Everything that does not need the switches is here: the two refusals, the hang,
// the serve-status check, and the AGENTDECK_ORIGIN value the run finishes by naming. The stub is
// injected the way src/watchdog.test.ts injects one - AGENTDECK_TAILSCALE naming an absolute path.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const script = new URL("../scripts/tailscale-serve.mjs", import.meta.url).pathname;
const DNS_NAME = "example-host.tailXXXXXX.ts.net";

let dir = "";
let stub = "";
let argvLog = "";
// Written by the stub's `serve --bg` branch, so `serve status` can answer differently once the
// proxy has been applied - which is the only way to test the post-apply checks.
let applied = "";

/** A `tailscale` whose three subcommands each print what this test wants. `serveDelay` is the
 *  hang: with Serve disabled the real CLI blocks instead of exiting. */
const stubTailscale = (options: {
  certDomains: string | null;
  dnsName?: string;
  rawStatus?: string;
  serveDelay?: number;
  serveStatus?: string;
  serveStatusAfter?: string;
  serveStatusExit?: number;
  serveStatusExitAfter?: number;
  serveExit?: number;
}): void => {
  const status =
    options.rawStatus ??
    JSON.stringify({
      Self: { DNSName: `${options.dnsName ?? DNS_NAME}.` },
      CertDomains: options.certDomains === null ? null : [options.certDomains],
    });
  writeFileSync(argvLog, "");
  rmSync(applied, { force: true });
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> '${argvLog}'
if [ "$1" = "status" ]; then
  echo 'Warning: client version mismatch' >&2
  echo '${status}'
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "--bg" ]; then
  echo "Serve is not enabled on your tailnet. https://login.tailscale.com/f/serve?node=abc"
  : > '${applied}'
  sleep ${String(options.serveDelay ?? 0)}
  exit ${String(options.serveExit ?? 0)}
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then
  if [ -f '${applied}' ]; then
    echo '${options.serveStatusAfter ?? options.serveStatus ?? "No serve config"}'
    exit ${String(options.serveStatusExitAfter ?? options.serveStatusExit ?? 0)}
  else
    echo '${options.serveStatus ?? "No serve config"}'
  fi
  exit ${String(options.serveStatusExit ?? 0)}
fi
exit 1
`,
    { mode: 0o755 },
  );
};

/** A child process answering `/api/health` 200 with agentdeck's body, and the port it got. Its port
 *  is printed on stdout because the parent must not pick one this test would then race for.
 *  `body` is how a DIFFERENT process holding the port is played. */
const healthResponder = async (
  body = '{"ok":true,"version":"0.0.0-test"}',
): Promise<{ server: ChildProcess; port: string }> => {
  const server = spawn(
    process.execPath,
    [
      "-e",
      `require('http').createServer((_q,s)=>{s.writeHead(200);s.end(${JSON.stringify(body)})})` +
        ".listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port))})",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const port = await new Promise<string>((resolve) => {
    server.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()));
  });
  return { server, port };
};

const run = (port: string): { status: number | null; out: string } => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: dir,
      AGENTDECK_TAILSCALE: stub,
      AGENTDECK_PORT: port,
      AGENTDECK_SERVE_TIMEOUT_MS: "1500",
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

void describe("the operator's serve command", () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "agentdeck-serve-"));
    stub = join(dir, "tailscale");
    argvLog = join(dir, "argv.log");
    applied = join(dir, "applied");
  });

  /** Every argument list the stub was invoked with, one per line: what the script actually ran, as
   *  opposed to what it said it ran. */
  const invocations = (): string => readFileSync(argvLog, "utf8");

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  void test("HTTPS certificates off: it refuses BEFORE running serve, and says where", () => {
    stubTailscale({ certDomains: null });
    const { status, out } = run("7777");
    assert.notEqual(status, 0);
    assert.match(out, /HTTPS certificates are DISABLED/);
    assert.match(out, /https:\/\/login\.tailscale\.com\/admin\/dns/);
    assert.match(out, /NOT running `tailscale serve --bg`/);
    // The refusal is the point: it never reached the command that blocks forever. Asserted on
    // what the stub was CALLED with, not on what the script printed - a script that ran
    // `serve --bg` and then printed a refusal would pass the message check and hang in practice.
    assert.doesNotMatch(out, /putting tailscale serve in front of/);
    assert.equal(invocations().trim(), "status --json");
  });

  void test("it never runs `tailscale funnel`, on any path", () => {
    // funnel is the public internet. Nothing in this item is authorised to reach it, and the
    // difference from `serve` is one word in one argument list.
    stubTailscale({
      certDomains: DNS_NAME,
      serveStatus: `https://${DNS_NAME} (tailnet only) |-- / proxy http://127.0.0.1:7798`,
    });
    run("7798");
    // Asserted on the argv log only: the script must MENTION funnel (it refuses when Funnel is on),
    // so "the source never says funnel" would forbid the check that enforces this.
    assert.doesNotMatch(invocations(), /funnel/);
  });

  void test("Funnel already on: it refuses BEFORE running serve", async () => {
    const { server, port } = await healthResponder();
    stubTailscale({
      certDomains: DNS_NAME,
      serveStatus: `https://${DNS_NAME} (Funnel on) |-- / proxy http://127.0.0.1:${port}`,
    });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, /Funnel is ON/);
    assert.match(out, new RegExp(`tailscale funnel ${port} off`));
    assert.doesNotMatch(out, /putting tailscale serve in front of/);
    assert.doesNotMatch(invocations(), /--bg/);
  });

  void test("no server on the port: serve is never applied", () => {
    stubTailscale({
      certDomains: DNS_NAME,
      serveStatus: `https://${DNS_NAME} (tailnet only) |-- / proxy http://127.0.0.1:7799`,
    });
    const { status, out } = run("7799");
    assert.notEqual(status, 0);
    assert.match(out, /server is not answering on 127\.0\.0\.1:7799/);
    assert.match(out, /nothing was exposed/);
    assert.doesNotMatch(invocations(), /--bg/);
  });

  void test("a different process holding the port: serve is never applied", async () => {
    // An SPA dev server answering 200 on every path is the realistic case. A 2xx is not proof the
    // port is agentdeck's, and publishing it would put an unrelated service on the tailnet.
    const { server, port } = await healthResponder("<!doctype html><title>vite</title>");
    stubTailscale({
      certDomains: DNS_NAME,
      serveStatus: `https://${DNS_NAME} (tailnet only) |-- / proxy http://127.0.0.1:${port}`,
    });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, /not agentdeck/);
    assert.match(out, /nothing was exposed/);
    assert.doesNotMatch(invocations(), /--bg/);
  });

  void test("a 200 without agentdeck's health body is also refused", async () => {
    const { server, port } = await healthResponder('{"ok":true}');
    stubTailscale({ certDomains: DNS_NAME });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, /agentdeck's \/api\/health body/);
    assert.doesNotMatch(invocations(), /--bg/);
  });

  void test("unreadable `serve status` refuses instead of reading it as Funnel off", async () => {
    // Fail-open here is the whole exposure: on a node with AllowFunnel set, the handler serve
    // installs is public the moment it is written.
    const { server, port } = await healthResponder();
    stubTailscale({ certDomains: DNS_NAME, serveStatus: "", serveStatusExit: 1 });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, /whether Funnel is on for this node cannot be read/);
    assert.match(out, /nothing was exposed/);
    assert.doesNotMatch(invocations(), /--bg/);
  });

  void test("no tailscale binary is a named refusal, not a stack trace", () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: dir,
        AGENTDECK_TAILSCALE: join(dir, "absent", "tailscale"),
      },
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /no tailscale binary found/);
  });

  void test("status output that is not JSON refuses instead of guessing a tailnet", () => {
    // `tailscaled` down prints prose on stdout and exits 0 often enough that a JSON.parse throw
    // here would be the script's most likely real-world crash.
    stubTailscale({ certDomains: null, rawStatus: "failed to connect to local tailscaled" });
    const { status, out } = run("7777");
    assert.equal(status, 1);
    assert.match(out, /could not read `tailscale status --json`/);
    assert.equal(invocations().trim(), "status --json");
  });

  void test("no MagicDNS name: also a refusal, naming MagicDNS rather than the certificates", () => {
    stubTailscale({ certDomains: null, dnsName: "" });
    const { status, out } = run("7777");
    assert.notEqual(status, 0);
    assert.match(out, /no MagicDNS name/);
  });

  void test("serve that never exits is killed, and the run says what is live now", async () => {
    const { server, port } = await healthResponder();
    stubTailscale({ certDomains: DNS_NAME, serveDelay: 30 });
    const started = Date.now();
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.ok(Date.now() - started < 20_000, "it waited on the hang instead of timing out");
    assert.match(out, /did not exit within 1500ms and was killed/);
    assert.match(out, /login\.tailscale\.com\/f\/serve/);
    // It ran the command, so it must not claim nothing was left running - it must report and
    // name the undo.
    assert.doesNotMatch(out, /Nothing was left running/);
    assert.match(out, /tailscale serve reset/);
  });

  void test("serve exiting non-zero still reports what serve status says is live", async () => {
    const { server, port } = await healthResponder();
    stubTailscale({ certDomains: DNS_NAME, serveExit: 1 });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, /failed/);
    assert.match(out, /tailscale serve reset/);
  });

  void test("serve status that does not mention the port fails the run and names the undo", async () => {
    const { server, port } = await healthResponder();
    stubTailscale({ certDomains: DNS_NAME, serveStatus: "No serve config" });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, new RegExp(`does not mention port ${port}`));
    assert.match(out, /tailscale serve reset/);
  });

  void test("Funnel turned on by the apply is caught after the fact, not certified green", async () => {
    const { server, port } = await healthResponder();
    stubTailscale({
      certDomains: DNS_NAME,
      serveStatus: "No serve config",
      serveStatusAfter: `https://${DNS_NAME} (Funnel on) |-- / proxy http://127.0.0.1:${port}`,
    });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, /public internet/);
    assert.match(out, new RegExp(`tailscale funnel ${port} off`));
    assert.doesNotMatch(out, /is up\. Open it on the phone/);
  });

  void test("`serve status` failing AFTER the apply names that, not a missing port", async () => {
    const { server, port } = await healthResponder();
    stubTailscale({ certDomains: DNS_NAME, serveStatusExitAfter: 1 });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, /neither Funnel nor the proxy target can be confirmed/);
    assert.doesNotMatch(out, /does not mention port/);
    assert.match(out, /tailscale serve reset/);
  });

  void test("with the server up, the last thing it cannot do is the ts.net fetch", async () => {
    // The furthest this can be driven without the switches: everything up to the HTTPS request,
    // which needs a certificate this tailnet has not been given. The health responder is a CHILD
    // process, because the script is run with spawnSync and an in-process server would never get
    // the event loop back to answer it.
    const { server, port } = await healthResponder();
    stubTailscale({
      certDomains: DNS_NAME,
      serveStatus: `https://${DNS_NAME} (tailnet only) |-- / proxy http://127.0.0.1:${port}`,
    });
    const { status, out } = run(port);
    server.kill("SIGKILL");
    assert.notEqual(status, 0);
    assert.match(out, new RegExp(`serve is configured but https://${DNS_NAME}/api/health`));
  });
});

void describe("the documents say what could not be demonstrated", () => {
  void test("the README names the one command", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    assert.match(readme, /scripts\/tailscale-serve\.mjs/);
    assert.match(readme, /AGENTDECK_ORIGIN=https:\/\/<host>/);
  });

  void test("the TODO entry is not ticked and names both settings", async () => {
    const todo = await readFile(new URL("../TODO.md", import.meta.url), "utf8");
    const rest = todo.slice(todo.indexOf("- [ ] **`m4/tailscale-serve`**"));
    const item = rest.slice(0, rest.indexOf("\n- ["));
    assert.match(todo, /- \[ \] \*\*`m4\/tailscale-serve`\*\*/);
    assert.match(item, /HTTPS half/);
    assert.match(item, /login\.tailscale\.com\/admin\/dns/);
    assert.match(item, /f\/serve/);
  });
});
