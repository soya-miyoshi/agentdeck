import { createHash } from "node:crypto";
import { basename } from "node:path";

// A session's id is a pure function of (absolute path, agent), which is what lets a restarted
// server recognise what tmux holds. All three parts of `<basename>-<agent>-<hash>` are load-bearing.

const HASH_LENGTH = 8;

// tmux rejects `.` and `:` in a session name outright. Folded to `-` rather than dropped, so names
// differing only in punctuation stay different even before the hash.
const sanitise = (value: string): string => {
  const folded = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  // A path like `/` leaves nothing behind, and an empty leading segment produces a name starting
  // with `-`, which reads as a flag to tmux.
  return folded === "" ? "repo" : folded;
};

export const sessionId = (absoluteCwd: string, agent: string): string => {
  const hash = createHash("sha256").update(absoluteCwd).digest("hex").slice(0, HASH_LENGTH);
  return `${sanitise(basename(absoluteCwd))}-${sanitise(agent)}-${hash}`;
};

// What the tab shows: the unsanitised basename, because the sanitising exists for tmux's naming
// rules and a human should not have to read around them.
export const sessionName = (absoluteCwd: string): string => basename(absoluteCwd);
