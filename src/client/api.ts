import type { AgentSummary } from "../agent-profiles.ts";
import type { Session } from "../registry.ts";

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

const request = async <T>(token: string, path: string): Promise<T> => {
  const response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new UnauthorizedError("the server rejected this token");
  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ForbiddenError(body.error ?? "the server refused this origin");
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
 */
export const verifyToken = async (token: string): Promise<TokenVerdict> => {
  try {
    await fetchSessions(token);
    return "ok";
  } catch (error) {
    if (error instanceof UnauthorizedError) return "rejected";
    if (error instanceof ForbiddenError) return "forbidden";
    return "unreachable";
  }
};
