// The documented half of m0/host-boundary: the boot properties themselves are exercised against
// the Go server in server-go/; what stays here is what the docs say about them.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

const repoRoot = new URL("..", import.meta.url);

const readDoc = async (name: string): Promise<string> =>
  await readFile(new URL(name, repoRoot), "utf8");

void describe("the agent profiles file is a host-execution surface, not config", () => {
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
