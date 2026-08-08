// The two admin-console preconditions `tailscale serve` has and the CLI does not report well.
//
// The fixtures here are the real shape of `tailscale status --json` from the development Mac on
// 2026-08-08, with HTTPS certificates disabled - `"CertDomains": null` - which is the state this
// item was written against and the one the report exists for.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { ADMIN_DNS_PAGE, parseTailnetStatus, tailnetAdvice, tailscaleBinary } from "./tailnet.ts";

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
