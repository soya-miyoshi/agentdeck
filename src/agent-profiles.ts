import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

// Any agent CLI can be a session, and none is privileged (plan 004). A profile is declarative so
// adding a CLI is config rather than a code change.
//
// The two rules that shape this file:
//
//   `env` lists variable NAMES, never values. The server passes them through from its own
//   environment, so no API key is ever written into the profile file and an example of it is
//   safe to commit.
//
//   A broken `waiting` mechanism disables the MECHANISM, not the profile. One bad edit must not
//   take down the server for every agent, and it must not take away sessions to fix a status
//   field. That agent drops to working/idle/exited and stays startable.

export type WaitingVia = "hook" | "log" | "screen";

export interface WaitingHook {
  via: "hook";
  settings: string;
}

export interface WaitingLog {
  via: "log";
  path: string;
}

export interface WaitingScreen {
  via: "screen";
  match: string;
}

export type WaitingMechanism = WaitingHook | WaitingLog | WaitingScreen;

export interface AgentProfile {
  id: string;
  name: string;
  command: string;
  args: readonly string[];
  env: readonly string[];
  waiting: WaitingMechanism | undefined;
  /** Why `waiting` is absent when the config asked for one. Logged, never thrown. */
  waitingDisabledReason: string | undefined;
}

/** What GET /api/agents serves. `available` lets the picker grey out an agent it cannot start. */
export interface AgentSummary {
  id: string;
  name: string;
  available: boolean;
  detectsWaiting: boolean;
  /** This agent reports its turn text, so its sessions have a history to show (plan 007). */
  logsTurns: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items: unknown[] = value;
  return items.every((v): v is string => typeof v === "string") ? [...items] : undefined;
};

// Parsed separately from the profile so a malformed mechanism can be reported and dropped without
// taking the profile with it.
const parseWaiting = (
  value: unknown,
): { waiting: WaitingMechanism | undefined; reason: string | undefined } => {
  if (value === undefined) return { waiting: undefined, reason: undefined };
  if (!isRecord(value)) return { waiting: undefined, reason: "waiting is not an object" };

  const via = value["via"];
  if (via === "hook") {
    const settings = value["settings"];
    if (typeof settings !== "string") {
      return { waiting: undefined, reason: "waiting.via=hook needs a settings path" };
    }
    // Relative to the agent-state directory, always. The server writes this file at every boot,
    // so an absolute path - or a `../` out of the directory - is an arbitrary-JSON-write primitive
    // that a profiles file could point at the operator's real ~/.claude/settings.json. The
    // mechanism is disabled rather than the profile, so the agent stays startable.
    if (isAbsolute(settings) || settings.split("/").includes("..")) {
      return {
        waiting: undefined,
        reason: `waiting.settings must be relative to the agent-state directory and stay inside it, not ${settings}`,
      };
    }
    return { waiting: { via: "hook", settings }, reason: undefined };
  }
  if (via === "log") {
    const path = value["path"];
    if (typeof path !== "string") {
      return { waiting: undefined, reason: "waiting.via=log needs a path" };
    }
    return { waiting: { via: "log", path }, reason: undefined };
  }
  if (via === "screen") {
    const match = value["match"];
    if (typeof match !== "string") {
      return { waiting: undefined, reason: "waiting.via=screen needs a match" };
    }
    // A malformed regex is the classic silent-degradation case: it must disable the mechanism
    // loudly here rather than throw on the first line of output an agent produces.
    try {
      new RegExp(match);
    } catch {
      return { waiting: undefined, reason: `waiting.via=screen match is not a valid regex` };
    }
    return { waiting: { via: "screen", match }, reason: undefined };
  }
  return { waiting: undefined, reason: `unknown waiting.via: ${String(via)}` };
};

export interface ParsedProfiles {
  profiles: Map<string, AgentProfile>;
  /** Profiles that could not be parsed at all, with why. The server logs these and carries on. */
  rejected: { id: string; reason: string }[];
}

export const parseProfiles = (raw: unknown): ParsedProfiles => {
  const profiles = new Map<string, AgentProfile>();
  const rejected: { id: string; reason: string }[] = [];

  if (!isRecord(raw)) return { profiles, rejected: [{ id: "<file>", reason: "not an object" }] };

  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      rejected.push({ id, reason: "profile is not an object" });
      continue;
    }
    const command = value["command"];
    if (typeof command !== "string" || command === "") {
      rejected.push({ id, reason: "profile has no command" });
      continue;
    }
    const name = value["name"];
    const args = asStringArray(value["args"] ?? []);
    if (args === undefined) {
      rejected.push({ id, reason: "args must be an array of strings" });
      continue;
    }
    const env = asStringArray(value["env"] ?? []);
    if (env === undefined) {
      rejected.push({ id, reason: "env must be an array of variable NAMES" });
      continue;
    }

    const { waiting, reason } = parseWaiting(value["waiting"]);
    profiles.set(id, {
      id,
      name: typeof name === "string" && name !== "" ? name : id,
      command,
      args,
      env,
      waiting,
      waitingDisabledReason: reason,
    });
  }

  return { profiles, rejected };
};

/**
 * Whether `command` resolves right now.
 *
 * Checked when the list is served rather than only at spawn, so the picker can grey an agent out
 * instead of offering a session that dies a second after opening.
 */
export const resolvesOnPath = (command: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const isExecutable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes("/")) return isAbsolute(command) ? isExecutable(command) : false;
  const path = env["PATH"];
  if (path === undefined) return false;
  return path.split(delimiter).some((dir) => dir !== "" && isExecutable(join(dir, command)));
};

export const summarise = (
  profile: AgentProfile,
  env: NodeJS.ProcessEnv = process.env,
): AgentSummary => ({
  id: profile.id,
  name: profile.name,
  available: resolvesOnPath(profile.command, env),
  // Absent `waiting` is a supported configuration, not a half-finished one: that agent reports
  // working/idle/exited and never claims `waiting`. The client shows its tab without a needs-you
  // indicator rather than inventing one. Fewer states, never a wrong one.
  detectsWaiting: profile.waiting !== undefined,
  // Derived, never configured: `hook` is the only mechanism that carries the agent's own words
  // (plan 004). A `log` or `screen` profile knows when the turn ended and not what it said, and
  // cutting an answer out of a rendered screen is the inference this project refuses.
  logsTurns: profile.waiting?.via === "hook",
});

/** The environment a session is spawned with: passthrough by NAME, plus what the server adds. */
export const spawnEnv = (
  profile: AgentProfile,
  extra: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of profile.env) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return { ...out, ...extra };
};
