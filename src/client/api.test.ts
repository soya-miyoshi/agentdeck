// What one authenticated request can tell the client about why it cannot get in.
//
// The interesting case is the 403. A browser sends `Origin` by itself, so a server started with
// AGENTDECK_ORIGIN set to an address the page was not opened from answers 403 to every `/api` call
// AND to the socket upgrade - and the upgrade's status never reaches the client, so this probe is
// the only place the difference is visible. Folded into "not a 401, so the token is good", it
// became "must be the network" and the ladder ran forever.
//
// Node's fetch does not send `Origin`, so the two halves are asserted separately: the server
// really does answer 403 with this body when an origin is expected and a different one arrives,
// and `verifyToken` really does turn that response into its own verdict.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";

import { parseProfiles } from "../agent-profiles.ts";
import { CwdAllowlist } from "../cwds.ts";
import { createHandler } from "../http.ts";
import { Registry } from "../registry.ts";
import { Tmux } from "../tmux.ts";
import { fetchSessions, ForbiddenError, UnauthorizedError, verifyToken } from "./api.ts";

const token = "test-token-value";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with this, as the browser's `fetch` would have. */
const answerWith = (status: number, body: unknown): void => {
  globalThis.fetch = async () =>
    await Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
};

void describe("the server's answer to a mismatched Origin", () => {
  void test("is 403 with a sentence, not 401 and not a socket that just closes", async () => {
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
        ),
        profiles,
        allowlist,
        token,
        version: "0.0.0-test",
        origin: "https://mac.tailnet.example",
        probe: async () => await Promise.resolve(true),
      }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const response = await realFetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
      headers: { authorization: `Bearer ${token}`, origin: "http://localhost:7778" },
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error?: string };
    assert.equal(typeof body.error, "string", "the refusal carried no sentence to render");
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
  });
});

void describe("verifyToken tells the three failures apart", () => {
  void test("a 403 is its own verdict, not a good token", async () => {
    answerWith(403, { error: "origin not allowed" });
    assert.equal(await verifyToken(token), "forbidden");
  });

  void test("a 401 is a rejected token", async () => {
    answerWith(401, { error: "unauthorized" });
    assert.equal(await verifyToken(token), "rejected");
  });

  void test("an unreachable server keeps the token", async () => {
    // A tunnel has not rejected anything. Reading it as a bad token would throw away a working
    // one every time the phone lost signal.
    globalThis.fetch = async () => await Promise.reject(new TypeError("fetch failed"));
    assert.equal(await verifyToken(token), "ok");
  });

  void test("a 500 is not read as a refusal either", async () => {
    answerWith(500, { error: "something broke" });
    assert.equal(await verifyToken(token), "ok");
  });
});

void describe("the error types the page branches on", () => {
  void test("403 raises ForbiddenError and 401 raises UnauthorizedError", async () => {
    answerWith(403, { error: "origin not allowed" });
    await assert.rejects(async () => await fetchSessions(token), ForbiddenError);
    answerWith(401, { error: "unauthorized" });
    await assert.rejects(async () => await fetchSessions(token), UnauthorizedError);
  });
});
