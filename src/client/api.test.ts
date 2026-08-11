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
          "test-secret-key",
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
    const response = await realFetch(`http://127.0.0.1:${String(port)}/api/probe`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "http://localhost:7778" },
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error?: string };
    assert.equal(typeof body.error, "string", "the refusal carried no sentence to render");

    // The same route, with the origin the server expects, is the plain `ok` the ladder reads.
    const allowed = await realFetch(`http://127.0.0.1:${String(port)}/api/probe`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "https://mac.tailnet.example" },
    });
    assert.equal(allowed.status, 200);
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
  });
});

void describe("the probe asks a question a browser stamps with Origin", () => {
  void test("it is not a GET, so the server's origin check can see it", async () => {
    // The defect this pins: a browser MUST send `Origin` on the socket upgrade and MUST NOT send
    // it on a same-origin GET, and the page and the API are same-origin. A GET probe is therefore
    // answered 200 by the very server whose upgrade check returned 403, `forbidden` is unreachable
    // and the ladder runs forever. Fetch appends `Origin` to any non-GET/HEAD request, so the
    // method is the fix and a mocked status can never catch a regression of it.
    const seen: { url: string; method: string }[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, method: init?.method ?? "GET" });
      return await Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    assert.equal(await verifyToken(token), "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, "/api/probe");
    assert.notEqual(seen[0]?.method.toUpperCase(), "GET");
    assert.notEqual(seen[0]?.method.toUpperCase(), "HEAD");
  });
});

void describe("verifyToken tells the four answers apart", () => {
  void test("a 403 is its own verdict, not a good token", async () => {
    answerWith(403, { error: "origin not allowed" });
    assert.equal(await verifyToken(token), "forbidden");
  });

  void test("a 401 is a rejected token, when the SERVER is the one saying so", async () => {
    answerWith(401, { error: "missing or invalid bearer token" });
    assert.equal(await verifyToken(token), "rejected");
  });

  void test("a 401 from something on the way is not a reason to destroy the token", async () => {
    // `rejected` reaches App.vue's signOut(), which clears the stored token - and a phone cannot
    // regenerate it: recovery means reading ~/.agentdeck/token on the Mac. A proxy auth challenge
    // or a captive portal must not be able to do that, so the terminal verdict requires the
    // sentence this server writes.
    answerWith(401, { error: "Proxy Authentication Required" });
    assert.equal(await verifyToken(token), "unreachable");
  });

  void test("a 403 from something on the way keeps the ladder running", async () => {
    // `forbidden` stops the ladder permanently and blames AGENTDECK_ORIGIN. `POST /api/probe`
    // traverses tailscale serve and whatever is on the phone's path, so a Tailscale ACL change or
    // a proxy refusing an unknown POST target would otherwise kill the tab and misname the cause.
    answerWith(403, { error: "Forbidden" });
    assert.equal(await verifyToken(token), "unreachable");
  });

  void test("an unreachable server keeps the token, and does not claim to have reached it", async () => {
    // A tunnel has not rejected anything. Reading it as a bad token would throw away a working
    // one every time the phone lost signal - and reading it as `ok` would let the client tell the
    // user the server is answering when nothing has answered at all.
    globalThis.fetch = async () => await Promise.reject(new TypeError("fetch failed"));
    assert.equal(await verifyToken(token), "unreachable");
  });

  void test("a 500 is not read as a refusal either", async () => {
    // The server answered, but it did not accept anything - it failed. Not evidence that this
    // client can get in, so not `ok`; not a refusal of the token, so the token is kept.
    answerWith(500, { error: "something broke" });
    assert.equal(await verifyToken(token), "unreachable");
  });
});

void describe("the error types the page branches on", () => {
  void test("403 raises ForbiddenError and 401 raises UnauthorizedError", async () => {
    answerWith(403, { error: "origin not allowed" });
    await assert.rejects(async () => await fetchSessions(token), ForbiddenError);
    answerWith(401, { error: "missing or invalid bearer token" });
    await assert.rejects(async () => await fetchSessions(token), UnauthorizedError);
  });
});
