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

// A terminal server is remote code execution by design, and `tailscale serve` makes loopback-only no
// protection. Every route but the hook one needs the user's token; that one takes a session secret.

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
   * Called when the session set changes, so the attachments catch up without waiting for a poll.
   * Optional: the poll is the guarantee, this is only the latency.
   */
  onSessionsChanged?: () => void;
  /**
   * The live stream for a session, so a hook's statement lands where state is decided. Optional:
   * an unattached session still gets its state through the registry.
   */
  streamFor?: (sessionId: string) => SessionStream | undefined;
  /**
   * Called with the state a hook just declared, so the strip hears it at the transition rather than
   * at the next sync (plan 002).
   */
  onStateDeclared?: (sessionId: string, state: SessionState) => void;
  /**
   * Where an image from the phone is written. Optional: without it the route answers 501 rather
   * than the deck failing to start.
   */
  uploads?: UploadStore;
  /**
   * Each live session's pane process, for GET /api/processes. Optional: it answers an empty list
   * rather than taking the terminal down with it.
   */
  panePids?: () => Promise<{ sessionId: string; panePid: number }[]>;
}

interface Handled {
  status: number;
  body: unknown;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The image route's own ceiling, far above every other route's: it is the only one whose body is
 * legitimately megabytes. The client downscales first, so this is a backstop, not the expected size.
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
 * Hook POSTs allowed per session per second, and the burst above it. Every accepted POST fans a
 * frame out to every socket, and an agent alternating two states defeats the announce dedupe.
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

    // Deliberately unauthenticated: the watchdog probes it, and it reveals only liveness and a
    // version. A token here would mean the health check holds the credential that starts processes.
    if (method === "GET" && path === "/api/health") {
      const ok = await deps.probe();
      return { status: ok ? 200 : 503, body: { ok, version: deps.version } };
    }

    // Authenticated by the per-session secret, never the user's token: writing that into a settings
    // file an agent reads by design would hand it every session on the machine.
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

      // On the stream, where state is decided and a statement outranks the cadence inference, and
      // on the registry so the very next session list carries it rather than the one after.
      deps.streamFor?.(id)?.declare(state);
      deps.registry.setState(id, state);
      // And out to every socket at the transition: the agent said so, so there is nothing to infer.
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

    // The client's "why can I not get in" question. A POST because fetch stamps `Origin` on any
    // non-GET request, and a same-origin GET carries none - so a GET probe cannot see a 403.
    if (method === "POST" && path === "/api/probe") {
      return { status: 200, body: { ok: true } };
    }

    if (method === "GET" && path === "/api/sessions") {
      return { status: 200, body: { sessions: await deps.registry.list() } };
    }

    if (method === "POST" && path === "/api/sessions") {
      // Caught here rather than at the generic 500: a refused body is something the client can act
      // on, and a sentence written on purpose is safe to hand back.
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

    // An image from the phone, written to disk so the agent is handed a path. Raw body bytes: both
    // multipart and base64 cost a dependency or a third of the uplink for nothing.
    const upload = /^\/api\/sessions\/([^/]+)\/uploads$/.exec(path);
    if (method === "POST" && upload) {
      if (deps.uploads === undefined) {
        return { status: 501, body: { error: "this deck has no upload directory configured" } };
      }
      const id = decodeURIComponent(upload[1] ?? "");
      // The same allowlist-filtered list `close` goes through: this is the only thing standing
      // between a raw path segment and a mkdir.
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

    // What each session is actually running. A route rather than a `ps` someone runs, because the
    // deck is the only thing that knows which pane belongs to which session.
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
    // Synchronous and outside every catch below: `//` makes the WHATWG parser throw on the empty
    // host, and an uncaught throw here ends the process.
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
        // Everything here is an error nobody wrote for a reader, and the client renders `message`
        // verbatim - `execFile` puts the whole argv in one. A fixed sentence and an id instead.
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
