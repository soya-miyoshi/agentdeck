import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentProfile } from "./agent-profiles.ts";
import { summarise } from "./agent-profiles.ts";
import { mapHookEvent } from "./claude-hooks.ts";
import type { CwdAllowlist } from "./cwds.ts";
import type { Registry } from "./registry.ts";
import { AgentUnavailableError, CwdNotAllowedError, UnknownAgentError } from "./registry.ts";
import type { SessionStream } from "./stream.ts";
import { bearerFrom, tokenMatches } from "./token.ts";

// A terminal server is remote code execution by design. MulmoTerminal binds loopback for exactly
// that reason and has no auth of its own - safe only while nothing remote can connect at all,
// which stops being true the moment `tailscale serve` is running (plan 001).
//
// So: every route except the hook one requires the user's bearer token, and the hook route
// authenticates with the per-session secret instead. That asymmetry is the point. A leaked
// session secret can lie about one session's status; the user's token can start processes.

export interface HttpDeps {
  registry: Registry;
  profiles: ReadonlyMap<string, AgentProfile>;
  allowlist: CwdAllowlist;
  token: string;
  version: string;
  /** Expected Origin, so a page the phone visits cannot drive the API. */
  origin: string | undefined;
  /** Hard-timed liveness probe. Returning false means the event loop cannot do its job. */
  probe: () => Promise<boolean>;
  /**
   * Called when the session set changes, so whatever holds the live attachments can catch up
   * immediately rather than waiting for its next poll. Optional: the poll is the guarantee, this
   * is only the latency.
   */
  onSessionsChanged?: () => void;
  /**
   * The live stream for a session, so a hook's statement lands where state is decided. Optional:
   * a session tmux has but nothing is attached to still gets its state through the registry.
   */
  streamFor?: (sessionId: string) => SessionStream | undefined;
}

interface Handled {
  status: number;
  body: unknown;
}

const MAX_BODY_BYTES = 64 * 1024;

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Bounded before buffering, not after: an unbounded read is a denial of service that needs
    // no credentials at all.
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export const createHandler = (deps: HttpDeps) => {
  const handle = async (req: IncomingMessage, url: URL): Promise<Handled> => {
    const method = req.method ?? "GET";
    const path = url.pathname;

    // Health is deliberately unauthenticated: it is what the watchdog probes, it reveals only
    // liveness and a version, and requiring a token would mean the health check needs the
    // credential that starts processes.
    if (method === "GET" && path === "/api/health") {
      const ok = await deps.probe();
      return { status: ok ? 200 : 503, body: { ok, version: deps.version } };
    }

    // The hook route: authenticated by the per-session secret, never the user's token. That
    // token is the phone's, and writing it into a settings file a coding agent reads by design
    // would hand the agent the key to every session on the machine.
    const hook = /^\/api\/hooks\/([^/]+)$/.exec(path);
    if (method === "POST" && hook) {
      const id = decodeURIComponent(hook[1] ?? "");
      const secret = req.headers["x-agentdeck-secret"];
      if (typeof secret !== "string" || !deps.registry.secretMatches(id, secret)) {
        return { status: 401, body: { error: "bad session secret" } };
      }
      let payload: unknown;
      try {
        payload = await readJson(req);
      } catch {
        return { status: 400, body: { error: "hook payload was not JSON" } };
      }

      const { state, reason } = mapHookEvent(payload);
      if (state === undefined) {
        // An event whose meaning has not been established changes nothing and says so. Logging it
        // is how the next Claude Code release's new event gets observed rather than guessed.
        console.log(`agentdeck: hook for ${id} changed no state: ${reason ?? "no reason given"}`);
        return { status: 200, body: { ok: true, state: null } };
      }

      // Declared on the stream because that is where the state a session reports is decided, and
      // a statement outranks the cadence inference there. Also set on the registry so the very
      // next GET /api/sessions carries it, rather than the one after the hub's next sync.
      deps.streamFor?.(id)?.declare(state);
      deps.registry.setState(id, state);
      return { status: 200, body: { ok: true, state } };
    }

    // Everything below needs the user's token.
    const presented = bearerFrom(req.headers.authorization);
    if (presented === undefined || !tokenMatches(presented, deps.token)) {
      return { status: 401, body: { error: "missing or invalid bearer token" } };
    }

    // Checked after auth so an unauthenticated caller learns nothing about which origins are
    // configured, and only for requests a browser would send.
    const origin = req.headers.origin;
    if (deps.origin !== undefined && origin !== undefined && origin !== deps.origin) {
      return { status: 403, body: { error: "origin not allowed" } };
    }

    if (method === "GET" && path === "/api/sessions") {
      return { status: 200, body: { sessions: await deps.registry.list() } };
    }

    if (method === "POST" && path === "/api/sessions") {
      const body = await readJson(req);
      if (typeof body !== "object" || body === null) {
        return { status: 400, body: { error: "expected a JSON object" } };
      }
      const record: Record<string, unknown> = body as Record<string, unknown>;
      const cwd = asString(record["cwd"]);
      const agent = asString(record["agent"]);
      if (cwd === undefined || agent === undefined) {
        return { status: 400, body: { error: "cwd and agent are both required" } };
      }
      // The client names a profile id and never a command line. A remote client supplying a
      // command is remote code execution with extra steps.
      try {
        const created = await deps.registry.create(cwd, agent);
        deps.onSessionsChanged?.();
        return { status: 201, body: created };
      } catch (error) {
        if (error instanceof CwdNotAllowedError)
          return { status: 403, body: { error: error.message } };
        if (error instanceof UnknownAgentError)
          return { status: 404, body: { error: error.message } };
        if (error instanceof AgentUnavailableError) {
          return { status: 409, body: { error: error.message } };
        }
        throw error;
      }
    }

    const remove = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (method === "DELETE" && remove) {
      await deps.registry.close(decodeURIComponent(remove[1] ?? ""));
      deps.onSessionsChanged?.();
      return { status: 200, body: { closed: true } };
    }

    if (method === "GET" && path === "/api/agents") {
      const agents = [...deps.profiles.values()].map((profile) => summarise(profile));
      return { status: 200, body: { agents } };
    }

    if (method === "GET" && path === "/api/cwds") {
      const byCwd = await deps.registry.sessionsByCwd();
      return { status: 200, body: { cwds: deps.allowlist.list(byCwd) } };
    }

    return { status: 404, body: { error: `no route for ${method} ${path}` } };
  };

  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    handle(req, url)
      .then(({ status, body }) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          // The API is JSON for one known client; nothing here should ever be framed, sniffed or
          // cached by something in between.
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(payload);
      })
      .catch((error: unknown) => {
        // Errors are sentences the client renders verbatim, so this one must not leak a stack.
        const message = error instanceof Error ? error.message : "unknown error";
        const payload = JSON.stringify({ error: message });
        res.writeHead(500, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      });
  };
};
