// The Origin check is real code (src/http.ts, src/ws.ts) that does nothing unless an expected
// origin is configured, and AGENTDECK_ORIGIN is read in exactly one place and set in none. So the
// documents and the boot output are what decide whether a reader can tell it is off, and that is
// what these assert: a stated protection whose enable switch is documented nowhere reads as on.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Registry } from "./registry.ts";
import { Tmux } from "./tmux.ts";

const repoRoot = new URL("..", import.meta.url);
const readDoc = async (name: string): Promise<string> =>
  await readFile(new URL(name, repoRoot), "utf8");

void describe("the Origin check is documented as present-but-off", () => {
  void test("unconfigured, /api accepts a foreign Origin - the ground truth the docs must match", async () => {
    const { profiles } = parseProfiles({});
    const allowlist = new CwdAllowlist([]);
    const server = createServer(
      createHandler({
        registry: new Registry(
          new Tmux({
            socket: "test",
            exec: async () => await Promise.resolve({ stdout: "", stderr: "" }),
          }),
          profiles,
          allowlist,
          "test-secret-key",
        ),
        profiles,
        allowlist,
        token: "test-token-value",
        version: "0.0.0-test",
        origin: undefined,
        probe: async () => await Promise.resolve(true),
      }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/agents`, {
      headers: { authorization: "Bearer test-token-value", origin: "https://evil.example" },
    });
    assert.equal(response.status, 200, "with no expected origin the check does nothing");
    await response.arrayBuffer();
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
  });

  void test("plan 001 says the check is off until AGENTDECK_ORIGIN is set", async () => {
    const plan = await readDoc("plans/001-architecture.md");
    assert.match(plan, /AGENTDECK_ORIGIN/);
    assert.match(plan, /[Pp]resent but off until configured/);
  });

  void test("TODO's ticked m1/auth-token carries the same caveat", async () => {
    const todo = await readDoc("TODO.md");
    const start = todo.indexOf("`m1/auth-token`");
    const item = todo.slice(start, todo.indexOf("\n\n- ", start));
    assert.match(item, /AGENTDECK_ORIGIN/);
    assert.match(item, /present but off/);
  });

  void test("the server warns at boot when it is unset", async () => {
    const server = await readDoc("src/server.ts");
    assert.match(server, /AGENTDECK_ORIGIN.*is not set|is not set.*Origin check/s);
    assert.match(server, /the Origin check plan 001 describes is off/);
  });
});
