import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentProfile } from "./agent-profiles.ts";
import { summarise } from "./agent-profiles.ts";
import { HOOK_MAX_BODY_BYTES, mapHookEvent } from "./claude-hooks.ts";
import type { CwdAllowlist } from "./cwds.ts";
import { sessionProcesses } from "./processes.ts";
import type { Registry } from "./registry.ts";
import { CwdNotAllowedError, UnknownAgentError } from "./registry.ts";
import type { SessionStream } from "./stream.ts";
import type { SessionState } from "./tmux.ts";
import { bearerFrom, tokenMatches } from "./token.ts";
import type { UploadStore } from "./uploads.ts";
import { UnsupportedImageError } from "./uploads.ts";

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
  /**
   * Called with the state a hook just declared, so the strip hears it now rather than at the next
   * sync. Plan 002: `state` is pushed, not polled, and a hook exists to arrive AT the transition.
   */
  onStateDeclared?: (sessionId: string, state: SessionState) => void;
  /**
   * Where an image from the phone is written. Optional: without it the route answers 501 rather
   * than the deck failing to start, so a deployment that does not want files on disk simply has
   * no upload button that works.
   */
  uploads?: UploadStore;
  /**
   * Each live session's pane process, for GET /api/processes. Optional: without it the route
   * answers an empty list rather than the deck failing to start, because a view of what a session
   * is running is worth nothing if its absence takes the terminal with it.
   */
  panePids?: () => Promise<{ sessionId: string; panePid: number }[]>;
}

interface Handled {
  status: number;
  body: unknown;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The image route's own ceiling, far above every other route's.
 *
 * Its own constant rather than a raised `MAX_BODY_BYTES`, because the reason 64KB is right for the
 * JSON routes has not changed: this is the only route whose body is legitimately megabytes, and it
 * is the only one that writes to disk. The client downscales before sending, so this is the
 * backstop for a client that does not, not the expected size.
 */
const UPLOAD_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Typed so the route can answer 413 with this sentence rather than the generic 500. */
class BodyTooLargeError extends Error {}

const readBody = async (req: IncomingMessage, limit: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Bounded before buffering, not after: an unbounded read is a denial of service that needs
    // no credentials at all.
    if (size > limit) throw new BodyTooLargeError("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
};

const readJson = async (req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> => {
  const body = await readBody(req, limit);
  if (body.length === 0) return undefined;
  return JSON.parse(body.toString("utf8"));
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * Hook POSTs allowed per session per second, and the burst above that.
 *
 * `POST /api/hooks/:id` is the one route not behind the user's token, and since the tab strip is
 * pushed rather than polled every accepted POST fans out a frame to every open socket. The secret
 * that authenticates it is readable by any same-uid process (`tmux show-environment -t`, see
 * m0/host-boundary), and the route is reachable over the tailnet rather than loopback-only because
 * `tailscale serve` fronts the whole port. So the cost of a POST has to be bounded by something
 * other than the caller's good behaviour: an agent looping on two events that map to different
 * states defeats the announce dedupe by construction.
 *
 * A real agent's transitions are human-paced. Ten a second per session is far above that and far
 * below what a loop produces.
 */
const HOOKS_PER_SECOND = 10;
const HOOK_BURST = 20;

export const createHandler = (deps: HttpDeps) => {
  // Per session, refilled by elapsed time rather than on a timer: no interval to clean up, and a
  // session that stops posting costs one map entry until the process ends.
  const hookBudget = new Map<string, { tokens: number; at: number }>();
  const hookAllowed = (id: string, now: number): boolean => {
    const bucket = hookBudget.get(id) ?? { tokens: HOOK_BURST, at: now };
    const refilled = Math.min(
      HOOK_BURST,
      bucket.tokens + ((now - bucket.at) / 1000) * HOOKS_PER_SECOND,
    );
    if (refilled < 1) {
      hookBudget.set(id, { tokens: refilled, at: now });
      return false;
    }
    hookBudget.set(id, { tokens: refilled - 1, at: now });
    return true;
  };

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
      if (!hookAllowed(id, Date.now())) {
        // Answered rather than dropped, so a legitimate agent that briefly outruns the budget can
        // see why. Nothing is declared and nothing is announced.
        return { status: 429, body: { error: "too many hook posts for this session" } };
      }
      let payload: unknown;
      try {
        payload = await readJson(req, HOOK_MAX_BODY_BYTES);
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
      // And out to every open socket, at the transition. This is the one path that can be fast:
      // the agent said so itself, so there is nothing to infer and nothing to wait for.
      deps.onStateDeclared?.(id, state);
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

    // The client's "why can I not get in" question. A POST rather than a GET because that is
    // what makes the origin check above reachable from a browser at all: a same-origin GET
    // carries no `Origin` header, so a GET probe is answered 200 by the same server that just
    // refused this page's socket upgrade 403. Fetch stamps `Origin` on any non-GET/HEAD request.
    // It reads nothing and changes nothing.
    if (method === "POST" && path === "/api/probe") {
      return { status: 200, body: { ok: true } };
    }

    if (method === "GET" && path === "/api/sessions") {
      return { status: 200, body: { sessions: await deps.registry.list() } };
    }

    if (method === "POST" && path === "/api/sessions") {
      // Caught here rather than at the generic 500, which now answers with a fixed sentence: a
      // body the server refused to buffer is a thing the client can act on, and a sentence
      // someone wrote on purpose is safe to hand back.
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError)
          return { status: 413, body: { error: error.message } };
        return { status: 400, body: { error: "expected a JSON object" } };
      }
      if (typeof body !== "object" || body === null) {
        return { status: 400, body: { error: "expected a JSON object" } };
      }
      const record = body as Record<string, unknown>;
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
        throw error;
      }
    }

    // An image from the phone, written to disk so the agent can be handed a path. The bytes are
    // the body as they are - no multipart, no base64 - because both cost a dependency or a third
    // of the phone's uplink for nothing.
    const upload = /^\/api\/sessions\/([^/]+)\/uploads$/.exec(path);
    if (method === "POST" && upload) {
      if (deps.uploads === undefined) {
        return { status: 501, body: { error: "this deck has no upload directory configured" } };
      }
      const id = decodeURIComponent(upload[1] ?? "");
      // The same allowlist-filtered list `close` goes through: an id that is not one of ours must
      // not get a directory, and this is the only thing standing between a path segment and mkdir.
      const ours = (await deps.registry.list()).some((session) => session.id === id);
      if (!ours) return { status: 404, body: { error: `no session ${id}` } };
      let bytes: Buffer;
      try {
        bytes = await readBody(req, UPLOAD_MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError)
          return { status: 413, body: { error: "that image is too large; send under 8MB" } };
        throw error;
      }
      if (bytes.length === 0) return { status: 400, body: { error: "the image body was empty" } };
      try {
        const saved = await deps.uploads.save(id, req.headers["content-type"], bytes);
        return { status: 201, body: { path: saved } };
      } catch (error) {
        if (error instanceof UnsupportedImageError)
          return { status: 415, body: { error: error.message } };
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

    // What each session is actually running. The deck is the only thing on this Mac that knows
    // which pane belongs to which session, which is the whole reason this is a route rather than a
    // `ps` someone runs.
    if (method === "GET" && path === "/api/processes") {
      if (deps.panePids === undefined) return { status: 200, body: { sessions: [] } };
      const sessions = await sessionProcesses(await deps.panePids());
      return { status: 200, body: { sessions } };
    }

    if (method === "GET" && path === "/api/cwds") {
      const byCwd = await deps.registry.sessionsByCwd();
      return { status: 200, body: { cwds: deps.allowlist.list(byCwd) } };
    }

    return { status: 404, body: { error: `no route for ${method} ${path}` } };
  };

  return (req: IncomingMessage, res: ServerResponse): void => {
    // This parse is synchronous and outside every catch below: `//` and `/\` make the WHATWG parser
    // throw on the empty host, and an uncaught throw here ends the process. A request target the
    // parser refuses is not a route we have, so it gets a fixed sentence rather than the deck.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      const payload = JSON.stringify({ error: "that request target is not a valid URL path" });
      res.writeHead(400, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(payload);
      return;
    }
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
        // The typed errors above are deliberately worded and reach the client as themselves.
        // Everything here is an error nobody wrote for a reader, and the client renders `message`
        // verbatim - `execFile` alone puts the whole argv, secrets included, in one. So: a fixed
        // sentence and an id, with the real text on the server's log where it belongs.
        const id = randomBytes(6).toString("hex");
        console.error(`agentdeck: unhandled request error ${id}:`, error);
        const payload = JSON.stringify({
          error: `the server failed to handle that request (ref ${id}); see the server log`,
        });
        res.writeHead(500, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      });
  };
};
