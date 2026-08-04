import { createHash } from "node:crypto";
import { basename } from "node:path";

// A session's id is a pure function of (absolute path, agent id). That is what makes it stable
// across a server restart without anything being written down - the registry can list tmux and
// recognise what it finds, rather than needing a file that says which session was which.
//
// The name is `<sanitised-basename>-<agent>-<short-hash-of-abs-path>`, and each of the three
// parts is load-bearing (plan 002):
//
//   basename    so `tmux ls` stays readable by a human
//   agent       so two agents in one working tree are two sessions rather than one. Keyed on the
//               path alone, a second create would hit `new-session -A`, silently attach to the
//               agent already running there, and return a Session whose `agent` field was a lie
//   path hash   so two checkouts named `web` under different parents do not collide. A collision
//               means attaching to somebody else's agent, which is the worst failure available

const HASH_LENGTH = 8;

// tmux rejects `.` and `:` in a session name outright. Everything outside this set is folded to
// `-` rather than dropped, so two names that differ only in punctuation stay different before the
// hash is appended - and the hash makes them different regardless.
const sanitise = (value: string): string => {
  const folded = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  // A path like `/` or a name that was entirely punctuation leaves nothing behind. The hash still
  // separates those, but an empty leading segment would produce a name starting with `-`, which
  // reads as a flag to tmux.
  return folded === "" ? "repo" : folded;
};

export const sessionId = (absoluteCwd: string, agent: string): string => {
  const hash = createHash("sha256").update(absoluteCwd).digest("hex").slice(0, HASH_LENGTH);
  return `${sanitise(basename(absoluteCwd))}-${sanitise(agent)}-${hash}`;
};

// What the tab shows: the unsanitised basename, because the sanitising exists for tmux's naming
// rules and a human should not have to read around them.
export const sessionName = (absoluteCwd: string): string => basename(absoluteCwd);
