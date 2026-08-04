import type { AgentSummary } from "../agent-profiles.ts";
import type { Session } from "../registry.ts";

// The REST half. Every request carries the bearer token; a 401 is not a network failure and is
// raised as its own type so the caller can drop the token and show the paste field rather than
// retry.

export class UnauthorizedError extends Error {}

const request = async <T>(token: string, path: string): Promise<T> => {
  const response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new UnauthorizedError("the server rejected this token");
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
 * Whether the server still accepts this token.
 *
 * Deliberately answers `true` when the request itself fails: an unreachable server has not
 * rejected anything, and treating "no network" as "bad token" would throw away a working token
 * every time the phone went through a tunnel.
 */
export const verifyToken = async (token: string): Promise<boolean> => {
  try {
    await fetchSessions(token);
    return true;
  } catch (error) {
    return !(error instanceof UnauthorizedError);
  }
};
