import type { AgentSummary } from "../agent-profiles.ts";
import type { Cwd } from "../cwds.ts";
import type { Session } from "../registry.ts";
import type { Turn } from "../turn-log.ts";

export interface TurnPage {
  turns: Turn[];
  truncated: boolean;
}

// The REST half. Every request carries the bearer token; a 401 is not a network failure and is
// raised as its own type so the caller can drop the token and show the paste field rather than
// retry.

export class UnauthorizedError extends Error {}

/**
 * The server answered, accepted the token, and refused the ORIGIN this page was opened from.
 *
 * Its own condition rather than one more failed request, because it is the one failure that is
 * neither the network nor the token and is indistinguishable from the network if it is not raised:
 * the socket upgrade is refused the same way, the client reads "not a 401, so the token is still
 * good, so it must be the network", and the ladder runs forever against a server that is answering
 * correctly. What has to change is `AGENTDECK_ORIGIN` or the address the page was opened from, and
 * no amount of retrying reaches either.
 */
export class ForbiddenError extends Error {}

/**
 * What one authenticated request learned about why this client cannot get in.
 *
 * `unreachable` is the probe failing rather than answering. It behaves exactly like `ok` for the
 * ladder - the token is kept and retrying continues - and is a verdict of its own only because the
 * two are opposite evidence about everything else: `ok` is a server that answered, and a client
 * whose sockets carry nothing while the server answers knows something no other state can tell it.
 */
export type TokenVerdict = "ok" | "rejected" | "forbidden" | "unreachable";

const request = async <T>(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> => {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // A status code alone does not say WHO answered. `POST /api/probe` traverses `tailscale serve`,
  // whatever is on the phone's path, and in development the Vite proxy - and any of them can
  // answer 401 or 403 for reasons that have nothing to do with this server. The consequences are
  // not symmetric with being wrong in the other direction: a 403 stops the ladder permanently and
  // blames AGENTDECK_ORIGIN, and a 401 signs the user out and clears the stored token, which on a
  // phone cannot be regenerated - recovery means reading ~/.agentdeck/token on the Mac. So both
  // terminal verdicts require the sentence THIS server writes (src/http.ts). Anything else is a
  // failure to reach it, which keeps retrying and destroys nothing.
  const refusal = async (): Promise<string | undefined> =>
    ((await response.json().catch(() => ({}))) as { error?: string }).error;
  if (response.status === 401) {
    const error = await refusal();
    if (error === "missing or invalid bearer token") throw new UnauthorizedError(error);
    throw new Error(error ?? "something on the way answered 401");
  }
  if (response.status === 403) {
    const error = await refusal();
    if (error === "origin not allowed") throw new ForbiddenError(error);
    throw new Error(error ?? "something on the way answered 403");
  }
  if (!response.ok) {
    // Errors are sentences the server wrote for a person. Rendered verbatim, because rewording a
    // refusal on the client loses the advice it contained.
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${path} failed with ${String(response.status)}`);
  }
  return (await response.json()) as T;
};

export const fetchSessions = async (token: string): Promise<Session[]> =>
  (await request<{ sessions: Session[] }>(token, "/api/sessions")).sessions;

export const fetchAgents = async (token: string): Promise<AgentSummary[]> =>
  (await request<{ agents: AgentSummary[] }>(token, "/api/agents")).agents;

/**
 * What this session was asked and what it answered, newest first (plan 007).
 *
 * Answers an empty list for a session with no history rather than failing, so the caller has one
 * path: an agent that does not report turns and an agent that has not finished one look the same
 * from here, and `logsTurns` is what tells them apart before the call is made.
 */
export const fetchTurns = async (token: string, sessionId: string): Promise<TurnPage> =>
  await request<TurnPage>(token, `/api/sessions/${encodeURIComponent(sessionId)}/turns`);

/** The directories a session may be started in. The picker's left half; nothing is typed. */
export const fetchCwds = async (token: string): Promise<Cwd[]> =>
  (await request<{ cwds: Cwd[] }>(token, "/api/cwds")).cwds;

/**
 * Start a session in a directory the server named, with an agent the server named. The 201's
 * `warning` is returned rather than dropped: it is how a second agent in one tree is ever seen.
 */
export const createSession = async (
  token: string,
  cwd: string,
  agent: string,
): Promise<{ session: Session; warning?: string }> =>
  await request<{ session: Session; warning?: string }>(token, "/api/sessions", "POST", {
    cwd,
    agent,
  });

/**
 * Send an image into a session and get back the path it landed on.
 *
 * Raw bytes rather than JSON or multipart: the body IS the image, so there is no encoding to pay
 * for and no parser to add. It goes through `fetch` directly rather than `request`, which is the
 * JSON helper - but the 401/403 sentences still have to mean what they mean everywhere else, so
 * they are recognised the same way.
 */
export const uploadImage = async (
  token: string,
  sessionId: string,
  image: Blob,
): Promise<string> => {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": image.type },
    body: image,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 401 && body.error === "missing or invalid bearer token") {
      throw new UnauthorizedError(body.error);
    }
    if (response.status === 403 && body.error === "origin not allowed") {
      throw new ForbiddenError(body.error);
    }
    throw new Error(body.error ?? `the upload failed with ${String(response.status)}`);
  }
  return ((await response.json()) as { path: string }).path;
};

/** Kill a session and its agent. Irreversible from here: the tmux session goes with it. */
export const closeSession = async (token: string, id: string): Promise<void> => {
  await request<{ closed: true }>(token, `/api/sessions/${encodeURIComponent(id)}`, "DELETE");
};

/**
 * Why this client cannot get in, as one cheap authenticated request.
 *
 * A request that fails rather than answering is `"unreachable"`, which the caller must treat as
 * the token still being good: an unreachable server has not rejected anything, and reading "no
 * network" as "bad token" would throw away a working token every time the phone went through a
 * tunnel. It is nonetheless not `"ok"`. `"ok"` is the positive claim that the server answered and
 * accepted this token, and it is the only state that makes a socket carrying nothing diagnosable
 * as something other than the network - said out loud to the user, which a guess must not be.
 *
 * `"forbidden"` is separated from all of them because it is the one condition retrying cannot
 * mend, and it used to be folded into `"ok"` - so an `AGENTDECK_ORIGIN` that does not match the
 * address the page was opened from produced a client that reconnected forever with no diagnosis.
 *
 * It asks `POST /api/probe` rather than reading `/api/sessions`, and the method is the whole
 * point. A browser MUST send `Origin` on a WebSocket handshake and MUST NOT send it on a
 * same-origin GET; the page and the API are same-origin by construction, so a GET probe is
 * answered 200 by the same server that just refused the upgrade 403, and `"forbidden"` was
 * unreachable from a browser - the ladder ran forever and `#diagnoseSilence` then blamed a proxy
 * that was not there. Fetch appends `Origin` to any request whose method is not GET or HEAD, so
 * the probe now carries the same evidence the upgrade does.
 */
export const verifyToken = async (token: string): Promise<TokenVerdict> => {
  try {
    await request<{ ok: true }>(token, "/api/probe", "POST");
    return "ok";
  } catch (error) {
    if (error instanceof UnauthorizedError) return "rejected";
    if (error instanceof ForbiddenError) return "forbidden";
    return "unreachable";
  }
};
