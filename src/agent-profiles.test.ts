import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseProfiles, resolvesOnPath, spawnEnv, summarise } from "./agent-profiles.ts";

const oneProfile = (raw: unknown, id = "claude") => {
  const parsed = parseProfiles(raw);
  const profile = parsed.profiles.get(id);
  assert.ok(profile, `no profile ${id}: ${JSON.stringify(parsed.rejected)}`);
  return { profile, parsed };
};

void describe("profiles parse", () => {
  void test("a minimal profile needs only a command", () => {
    const { profile } = oneProfile({ claude: { command: "claude" } });
    assert.equal(profile.command, "claude");
    assert.equal(profile.name, "claude", "name falls back to the id");
    assert.deepEqual(profile.args, []);
  });

  void test("a profile with no command is rejected, and the others survive", () => {
    // One bad edit must not take down the server for every agent.
    const parsed = parseProfiles({ broken: { name: "Broken" }, shell: { command: "/bin/zsh" } });
    assert.equal(parsed.profiles.has("broken"), false);
    assert.equal(parsed.profiles.has("shell"), true);
    assert.equal(parsed.rejected.length, 1);
    assert.match(parsed.rejected[0]?.reason ?? "", /command/);
  });

  void test("env lists names, and a non-string entry rejects the profile", () => {
    const { profile } = oneProfile({ claude: { command: "claude", env: ["ANTHROPIC_API_KEY"] } });
    assert.deepEqual(profile.env, ["ANTHROPIC_API_KEY"]);

    const parsed = parseProfiles({ claude: { command: "claude", env: [{ key: "secret" }] } });
    assert.equal(parsed.profiles.has("claude"), false);
    assert.match(parsed.rejected[0]?.reason ?? "", /NAMES/);
  });
});

void describe("a broken waiting mechanism disables the mechanism, not the profile", () => {
  void test("hook without settings", () => {
    const { profile } = oneProfile({ claude: { command: "claude", waiting: { via: "hook" } } });
    assert.equal(profile.waiting, undefined);
    assert.match(profile.waitingDisabledReason ?? "", /settings/);
    // Still startable - that is the whole point.
    assert.equal(profile.command, "claude");
  });

  void test("an unparseable screen regex", () => {
    // The failure this prevents: a malformed regex throwing on the first byte of output an agent
    // produces, rather than being reported once when the config is read.
    const { profile } = oneProfile({
      claude: { command: "claude", waiting: { via: "screen", match: "([unclosed" } },
    });
    assert.equal(profile.waiting, undefined);
    assert.match(profile.waitingDisabledReason ?? "", /regex/);
  });

  void test("an unknown via", () => {
    const { profile } = oneProfile({
      claude: { command: "claude", waiting: { via: "telepathy" } },
    });
    assert.equal(profile.waiting, undefined);
    assert.match(profile.waitingDisabledReason ?? "", /telepathy/);
  });

  void test("a valid hook survives", () => {
    const { profile } = oneProfile({
      claude: { command: "claude", waiting: { via: "hook", settings: "claude-hooks.json" } },
    });
    assert.deepEqual(profile.waiting, { via: "hook", settings: "claude-hooks.json" });
    assert.equal(profile.waitingDisabledReason, undefined);
  });
});

void describe("availability and the summary the picker reads", () => {
  void test("a command that does not resolve reports available: false", () => {
    // Not an error at parse time: a missing binary is a clear refusal when the session is
    // created, and a greyed-out entry in the picker before that.
    const { profile } = oneProfile({ claude: { command: "definitely-not-installed-xyz" } });
    assert.equal(summarise(profile, { PATH: "/usr/bin:/bin" }).available, false);
  });

  void test("a real command resolves", () => {
    assert.equal(resolvesOnPath("sh", { PATH: "/usr/bin:/bin" }), true);
  });

  void test("an absolute path is checked directly; a relative one is refused", () => {
    assert.equal(resolvesOnPath("/bin/sh", {}), true);
    assert.equal(resolvesOnPath("./sh", { PATH: "/bin" }), false);
  });

  void test("detectsWaiting false is a supported configuration, not a defect", () => {
    // That agent reports working/idle/exited and never claims `waiting`. The client shows its tab
    // without a needs-you indicator rather than inventing one.
    const { profile } = oneProfile({ shell: { command: "/bin/sh" } }, "shell");
    assert.equal(summarise(profile).detectsWaiting, false);
  });

  void test("a disabled mechanism reports detectsWaiting false, like an absent one", () => {
    const { profile } = oneProfile({ claude: { command: "/bin/sh", waiting: { via: "hook" } } });
    assert.equal(summarise(profile).detectsWaiting, false);
  });
});

void describe("spawn environment", () => {
  void test("passes named variables through and drops unset ones", () => {
    const { profile } = oneProfile({ claude: { command: "claude", env: ["SET_ME", "UNSET_ME"] } });
    const env = spawnEnv(profile, {}, { SET_ME: "value" });
    assert.deepEqual(env, { SET_ME: "value" });
    assert.equal("UNSET_ME" in env, false, "an unset name must not become an empty string");
  });

  void test("carries the per-session extras the hook route authenticates against", () => {
    const { profile } = oneProfile({ claude: { command: "claude" } });
    const env = spawnEnv(profile, { AGENTDECK_SESSION_ID: "s1", AGENTDECK_SECRET: "abc" }, {});
    assert.equal(env["AGENTDECK_SESSION_ID"], "s1");
    assert.equal(env["AGENTDECK_SECRET"], "abc");
  });

  void test("extras win over passthrough, so a profile cannot shadow the session secret", () => {
    const { profile } = oneProfile({ claude: { command: "claude", env: ["AGENTDECK_SECRET"] } });
    const env = spawnEnv(profile, { AGENTDECK_SECRET: "real" }, { AGENTDECK_SECRET: "spoofed" });
    assert.equal(env["AGENTDECK_SECRET"], "real");
  });
});
