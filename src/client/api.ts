import type { AgentSummary } from "../agent-profiles.ts";
import type { Cwd } from "../cwds.ts";
import type { Session } from "../registry.ts";
// The REST half. Every request carries the bearer token, and a 401 is raised as its own type: the
// caller drops the token and shows the paste field rather than retrying.

export class UnauthorizedError extends Error {}

/**
 * The server answered, accepted the token, and refused this page's ORIGIN. Its own condition
 * because it is the one failure retrying cannot mend, and looks exactly like the network.
 */
export class ForbiddenError extends Error {}

/**
 * What one authenticated request learned about why this client cannot get in. `unreachable` is the
 * probe failing rather than answering: it retries like `ok` but is the opposite evidence.
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
  // A status code alone does not say WHO answered, and a proxy can 401 for its own reasons. Both
  // terminal verdicts therefore require the sentence THIS server writes; anything else retries.
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

export interface ProcessRow {
  pid: number;
  ppid: number;
  ageSeconds: number;
  rssKb: number;
  cpuPercent: number;
  command: string;
  depth: number;
}

export interface SessionProcesses {
  sessionId: string;
  panePid: number;
  processes: ProcessRow[];
  childCount: number;
  childRssKb: number;
}

/** What each live session is running. Read on demand, never polled: it is a `ps` per call. */
export const fetchProcesses = async (token: string): Promise<SessionProcesses[]> =>
  (await request<{ sessions: SessionProcesses[] }>(token, "/api/processes")).sessions;

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
 * Send an image into a session and get back the path it landed on. Raw bytes rather than JSON or
 * multipart, so `fetch` is called directly - but the 401/403 sentences are read the same way.
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
 * Why this client cannot get in, as one cheap authenticated request. A POST rather than a GET is
 * the whole point: fetch stamps `Origin` on it, so a browser can reach `"forbidden"` at all.
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
