import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  HOOK_MARKER,
  hookCommand,
  installHookSettings,
  mapHookEvent,
  mergeHookSettings,
} from "./claude-hooks.ts";

// Everything mapped here comes out of fixtures/claude-hooks.jsonl, which was captured from
// claude 2.1.221 driving real turns - not from documentation and not from memory. A test that
// asserts against a payload someone imagined proves only that two guesses agree.
const fixtures = readFileSync(join(import.meta.dirname, "fixtures/claude-hooks.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const fixture = (predicate: (payload: Record<string, unknown>) => boolean) => {
  const found = fixtures.find(predicate);
  assert.ok(found, "the fixture file should contain this payload");
  return found;
};

const byEvent = (name: string) => fixture((p) => p["hook_event_name"] === name);

void describe("mapping observed claude hook events", () => {
  void test("the in-turn events mean working", () => {
    for (const name of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      assert.equal(mapHookEvent(byEvent(name)).state, "working", name);
    }
  });

  void test("Stop means waiting", () => {
    assert.equal(mapHookEvent(byEvent("Stop")).state, "waiting");
  });

  void test("both observed Notification subtypes mean waiting", () => {
    // permission_prompt and idle_prompt are the two that 2.1.221 actually emitted.
    const notifications = fixtures.filter((p) => p["hook_event_name"] === "Notification");
    assert.equal(notifications.length, 2);
    const types = notifications.map((p) => p["notification_type"]);
    assert.deepEqual([...types].sort(), ["idle_prompt", "permission_prompt"]);
    for (const payload of notifications) {
      assert.equal(mapHookEvent(payload).state, "waiting", String(payload["notification_type"]));
    }
  });
});

void describe("the denylist applies at the layer it was learned at", () => {
  void test("an unrecognised notification_type is ACTIONABLE", () => {
    // A subtype Claude Code has not shipped yet. A swallowed "needs you" is the feature not
    // working, with no way for a person to discover the stuck session; a spurious one is an
    // annoyance. The failure modes are not equal, so this raises waiting.
    const observed = byEvent("Notification");
    const future = { ...observed, notification_type: "some_subtype_from_a_later_release" };
    assert.equal(mapHookEvent(future).state, "waiting");
  });

  void test("a Notification with no notification_type at all is still actionable", () => {
    const withoutType = { ...byEvent("Notification") };
    delete withoutType["notification_type"];
    assert.equal(mapHookEvent(withoutType).state, "waiting");
  });

  void test("an unrecognised EVENT NAME changes no state and says why", () => {
    // The opposite rule, and the reason this file exists. Generalising the denylist upward means
    // the next event Claude Code ships lights the strip as "needs you" - wrong, not merely
    // uninformative.
    const decision = mapHookEvent({ hook_event_name: "PreCompact", trigger: "auto" });
    assert.equal(decision.state, undefined);
    assert.match(String(decision.reason), /PreCompact/);
  });

  void test("observed-but-unmapped events change no state either", () => {
    // SessionStart and SessionEnd were captured; neither says anything about whether a person is
    // needed, and process exit is the authority on `exited`.
    for (const name of ["SessionStart", "SessionEnd"]) {
      assert.equal(mapHookEvent(byEvent(name)).state, undefined, name);
    }
  });

  void test("an informational notification_type does not raise attention", () => {
    // The denylist ships empty because 2.1.221 emitted no informational subtype. The mechanism
    // that will hold one is still tested, so the day a payload is captured it is a one-line edit
    // rather than a design question.
    const payload = { ...byEvent("Notification"), notification_type: "observed_as_informational" };
    const denied = new Set(["observed_as_informational"]);
    assert.equal(mapHookEvent(payload, denied).state, undefined);
  });

  void test("a subagent finishing mid-turn does NOT flag the tab", () => {
    // MulmoTerminal's bug, at the layer this version of Claude Code puts it: a subagent
    // completing is something ending, not somebody being needed. The parent turn is still
    // running, and flagging here would beep and push once per subagent.
    const payload = byEvent("SubagentStop");
    assert.equal(payload["agent_type"], "Explore");
    assert.equal(mapHookEvent(payload).state, undefined);
  });

  void test("junk is refused rather than interpreted", () => {
    assert.equal(mapHookEvent(undefined).state, undefined);
    assert.equal(mapHookEvent("Stop").state, undefined);
    assert.equal(mapHookEvent({ hook_event_name: 7 }).state, undefined);
  });
});

void describe("the settings fragment", () => {
  void test("carries the session id and secret from the environment, not from the file", () => {
    const command = hookCommand(7777);
    assert.match(command, /\$AGENTDECK_SESSION_ID/);
    assert.match(command, /process\.env\.AGENTDECK_SECRET/);
    // No bearer token anywhere near a file a coding agent reads by design.
    assert.doesNotMatch(command, /Authorization/i);
  });

  void test("never expands the secret into an argument, where ps would show it", () => {
    const command = hookCommand(7777);
    // The shell expands "$AGENTDECK_SECRET" before exec, so any occurrence outside single quotes
    // would put the literal secret in argv - readable by every process of this user via
    // `ps -Ao args=`, dozens of times per turn. The value must be read from the environment by
    // the process itself instead.
    assert.doesNotMatch(command, /\$AGENTDECK_SECRET/);
    assert.doesNotMatch(command, /\$\{AGENTDECK_SECRET/);

    // Not by reading the string, though: run the command through a real shell with a marked
    // secret in the environment and a stand-in on PATH that writes down the argv it was given.
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-argv-"));
    const argvFile = join(dir, "argv");
    const stub = join(dir, "node");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\n`);
    chmodSync(stub, 0o755);
    // The emitted command names an absolute interpreter, so a PATH shim no longer intercepts:
    // the stub is passed in as the interpreter instead.
    execFileSync("/bin/sh", ["-c", hookCommand(7777, stub)], {
      env: {
        PATH: dir,
        AGENTDECK_SESSION_ID: "s1",
        AGENTDECK_SECRET: "s3cret-value",
      },
    });
    const argv = readFileSync(argvFile, "utf8");
    assert.ok(!argv.includes("s3cret-value"), `secret leaked into argv: ${argv}`);
  });

  void test("runs the interpreter by absolute path, so a minimal PATH still posts", () => {
    const command = hookCommand(7777);
    // A bare `node` resolves against the session's PATH, which is the server's own. Under launchd
    // that is /usr/bin:/bin:/usr/sbin:/sbin, where no Homebrew/mise/nvm node exists - every hook
    // would die with `command not found` and `exit 0` would hide it.
    assert.doesNotMatch(command, /(?:^|[\s;])node -e/);
    assert.ok(
      command.includes(`'${process.execPath}' -e`),
      `expected the running node's absolute path in: ${command}`,
    );

    // Not by reading the string: run it through a shell with a PATH that has no node at all, and
    // an interpreter stub reachable only by absolute path.
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-abs-"));
    const marker = join(dir, "ran");
    const stub = join(dir, "interp");
    writeFileSync(stub, `#!/bin/sh\nprintf ok > ${marker}\n`);
    chmodSync(stub, 0o755);
    execFileSync("/bin/sh", ["-c", hookCommand(7777, stub)], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", AGENTDECK_SESSION_ID: "s1" },
    });
    assert.equal(readFileSync(marker, "utf8"), "ok");
  });

  void test("refuses a bare interpreter name rather than emitting one", () => {
    assert.throws(() => hookCommand(7777, "node"), /absolute path/);
  });

  void test("merges once and idempotently, preserving keys it did not write", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-hooks-"));
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          model: "opus",
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
            PreCompact: [{ hooks: [{ type: "command", command: "echo compacting" }] }],
          },
        },
        undefined,
        2,
      )}\n`,
    );

    assert.equal(installHookSettings(path, 7777).changed, true);
    const first = readFileSync(path, "utf8");
    assert.equal(installHookSettings(path, 7777).changed, false);
    assert.equal(readFileSync(path, "utf8"), first, "a second merge must change nothing");

    const parsed = JSON.parse(first) as Record<string, unknown>;
    assert.equal(parsed["model"], "opus", "a key we did not write must survive");
    const hooks = parsed["hooks"] as Record<string, unknown[]>;
    assert.equal(
      JSON.stringify(hooks["PreCompact"]),
      JSON.stringify([{ hooks: [{ type: "command", command: "echo compacting" }] }]),
      "an event we do not install must be left alone",
    );
    const stop = JSON.stringify(hooks["Stop"]);
    assert.match(stop, /say done/, "the human's own hook on the same event must survive");
    assert.match(stop, /api\/hooks/);
    assert.equal(
      (hooks["Stop"] ?? []).filter((entry) => JSON.stringify(entry).includes("api/hooks")).length,
      1,
      "exactly one agentdeck entry, however many times the merge runs",
    );
  });

  void test("writes a whole file when there is none, and stays idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-hooks-"));
    const path = join(dir, "nested", "settings.json");
    assert.equal(installHookSettings(path, 7777).changed, true);
    assert.equal(installHookSettings(path, 7777).changed, false);
  });

  void test("replaces our previous entry when the port changes rather than adding a second", () => {
    const once = mergeHookSettings({}, 7777);
    const twice = mergeHookSettings(once, 7788);
    const stop = (twice["hooks"] as Record<string, unknown[]>)["Stop"] ?? [];
    assert.equal(stop.filter((e) => JSON.stringify(e).includes(HOOK_MARKER)).length, 1);
    assert.match(JSON.stringify(stop), /7788/);
    assert.doesNotMatch(JSON.stringify(stop), /7777/);
  });

  void test("a malformed settings file is left exactly as the human left it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-hooks-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ this is not json");
    assert.throws(() => installHookSettings(path, 7777));
    assert.equal(readFileSync(path, "utf8"), "{ this is not json");
  });
});
