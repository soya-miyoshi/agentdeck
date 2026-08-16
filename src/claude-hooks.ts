import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { SessionState } from "./tmux.ts";

/**
 * Body limit for `POST /api/hooks/:id`, larger than every other route's: a payload carries the
 * turn's text, and two `MAX_FIELD_CHARS` fields at three bytes per character must clear it.
 */
export const HOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Where the hook command cuts the payload's two long fields, in code points because a byte cut
 * splits a character. A refused body loses that turn's STATUS frame, which is the half still wanted.
 */
export const MAX_FIELD_CHARS = 16 * 1024;

/** What the hook command buffers before giving up: enough to parse and trim a large payload. */
const HOOK_READ_LIMIT = 1024 * 1024;

// Claude Code's hooks mapped to session states: the agent's own statement rather than inference
// from its pixels (plan 004). Every name below was OBSERVED - `fixtures/claude-hooks.jsonl`.

export interface HookDecision {
  /** The state to declare, or undefined for "log it, change nothing". */
  state: SessionState | undefined;
  /** Why nothing changed, or which rule matched. Logged either way. */
  reason: string | undefined;
}

/** Observed to fire strictly inside a turn: the agent is doing something. */
const WORKING_EVENTS: ReadonlySet<string> = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
]);

/**
 * `Notification` subtypes that are announcements rather than requests for a person. Empty
 * deliberately: in 2.1.221 the subagent case is a separate event, so nothing observed belongs here.
 */
export const INFORMATIONAL_NOTIFICATION_TYPES: ReadonlySet<string> = new Set<string>();

/**
 * Events observed to fire mid-turn while the parent turn continues. A subagent finishing is
 * something ending rather than somebody being needed, so `waiting` would flag a working tab.
 */
const INFORMATIONAL_EVENTS: ReadonlySet<string> = new Set(["SubagentStop"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Map one hook payload to a state. An unrecognised `notification_type` is ACTIONABLE, since a
 * swallowed "needs you" is the feature not working; an unrecognised EVENT changes nothing.
 */
export const mapHookEvent = (
  payload: unknown,
  informational: ReadonlySet<string> = INFORMATIONAL_NOTIFICATION_TYPES,
): HookDecision => {
  if (!isRecord(payload)) return { state: undefined, reason: "payload is not an object" };

  const event = payload["hook_event_name"];
  if (typeof event !== "string" || event === "") {
    return { state: undefined, reason: "payload has no hook_event_name" };
  }

  if (WORKING_EVENTS.has(event)) return { state: "working", reason: event };

  if (event === "Stop") return { state: "waiting", reason: "Stop: the turn ended" };

  if (event === "Notification") {
    const type = payload["notification_type"];
    if (typeof type === "string" && informational.has(type)) {
      return { state: undefined, reason: `Notification ${type} is informational` };
    }
    // Including an absent or unrecognised subtype. See the rule above.
    return {
      state: "waiting",
      reason: `Notification ${typeof type === "string" ? type : "<no notification_type>"}`,
    };
  }

  if (INFORMATIONAL_EVENTS.has(event)) {
    return { state: undefined, reason: `${event} is informational: the parent turn continues` };
  }

  return { state: undefined, reason: `unrecognised event ${event}: no state changed` };
};

// ---------------------------------------------------------------------------------------------
// The settings fragment.

/** The events worth installing. Anything else would post a request that changes no state. */
export const INSTALLED_EVENTS: readonly string[] = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
];

/**
 * How agentdeck's own hook entries are recognised on a later merge: the URL path prefix rather than
 * the whole command, so a changed port or transport replaces the entry instead of duplicating it.
 */
export const HOOK_MARKER = "/api/hooks/";

/**
 * The one line that runs per event: exits 0 whatever happens, and does nothing without
 * `AGENTDECK_SESSION_ID`. `node -e` and an ABSOLUTE path - a shell would put the secret in argv.
 */
export const hookCommand = (port: number, interpreter: string = process.execPath): string => {
  if (!interpreter.startsWith("/")) {
    throw new Error(`hook interpreter must be an absolute path, got ${interpreter}`);
  }
  const quoted = `'${interpreter.split("'").join(`'\\''`)}'`;
  const script =
    // A cap on the whole operation: `timeout` below cannot start until stdin closes, so a hook
    // whose stdin never closes would leave a Node runtime resident for the session's life.
    `setTimeout(()=>process.exit(0),2000).unref();` +
    `let b="";` +
    // A StringDecoder holds a partial multi-byte sequence across a read boundary; appending raw
    // chunks would turn a character split by one into U+FFFD. Not observed, kept anyway.
    `process.stdin.setEncoding("utf8");` +
    // Buffered past what will be sent, because the trim below needs whole valid JSON to shorten.
    `process.stdin.on("data",(c)=>{if(b.length<${String(HOOK_READ_LIMIT)})b+=c}).on("end",()=>{` +
    // Cut in the agent's own process, before the payload crosses the socket, or a long answer costs
    // that turn its status frame. ONE past the bound, so a reader's own cut fires and says so.
    `try{const p=JSON.parse(b);` +
    `for(const k of ["last_assistant_message","prompt"]){const v=p[k];` +
    `if(typeof v==="string")p[k]=Array.from(v).slice(0,${String(MAX_FIELD_CHARS + 1)}).join("")}` +
    `b=JSON.stringify(p)}catch(e){}` +
    // Still oversized means it was not JSON we could shorten. Dropping it is what already
    // happened, one layer later, as a 400.
    `if(b.length>${String(HOOK_MAX_BODY_BYTES)})return;` +
    `const r=require("http").request({` +
    `host:"127.0.0.1",port:${String(port)},` +
    `path:"${HOOK_MARKER}"+encodeURIComponent(process.env.AGENTDECK_SESSION_ID||""),` +
    `method:"POST",timeout:2000,headers:{` +
    `"X-Agentdeck-Secret":process.env.AGENTDECK_SECRET||"",` +
    `"Content-Type":"application/json"}},(res)=>{res.resume()});` +
    `r.on("error",()=>{});r.on("timeout",()=>{r.destroy()});r.end(b)})`;
  return (
    `[ -n "$AGENTDECK_SESSION_ID" ] || exit 0; ` +
    `${quoted} -e '${script}' >/dev/null 2>&1; exit 0`
  );
};

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

const ours = (port: number): HookEntry => ({
  hooks: [{ type: "command", command: hookCommand(port) }],
});

// Both halves, because the marker alone is a generic path segment and `mergeHookSettings` DELETES
// what it recognises: a stranger's guard hook would vanish silently at the next boot.
const isOurHook = (hook: unknown): boolean =>
  isRecord(hook) &&
  typeof hook["command"] === "string" &&
  hook["command"].includes(HOOK_MARKER) &&
  hook["command"].includes("AGENTDECK_SESSION_ID");

/**
 * Merge the fragment into whatever the settings file already holds, preserving every key it did not
 * write. Idempotent: our entries are removed and re-appended in place, so a second merge is a no-op.
 */
export const mergeHookSettings = (existing: unknown, port: number): Record<string, unknown> => {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  const hooksValue = root["hooks"];
  const hooks: Record<string, unknown> = isRecord(hooksValue) ? { ...hooksValue } : {};

  for (const event of INSTALLED_EVENTS) {
    const current = hooks[event];
    const entries: unknown[] = Array.isArray(current) ? current : [];
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (!isRecord(entry)) {
        // Not a shape we wrote and not one we understand. Someone else's, so it stays.
        kept.push(entry);
        continue;
      }
      const inner = entry["hooks"];
      if (!Array.isArray(inner)) {
        kept.push(entry);
        continue;
      }
      const remaining = (inner as unknown[]).filter((hook) => !isOurHook(hook));
      if (remaining.length === inner.length) kept.push(entry);
      else if (remaining.length > 0) kept.push({ ...entry, hooks: remaining });
      // An entry that was only ever ours disappears, to be re-appended below.
    }
    kept.push(ours(port));
    hooks[event] = kept;
  }

  root["hooks"] = hooks;
  return root;
};

export interface InstallResult {
  /** False when the file already said exactly this - the second run of an idempotent merge. */
  changed: boolean;
}

/**
 * Merge into the file at `path`, once, at server start - per session would be concurrent writes for
 * an identical result. Malformed JSON throws rather than overwriting a human's mid-way edit.
 */
export const installHookSettings = (path: string, port: number): InstallResult => {
  let existing: unknown = {};
  let before: string | undefined;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    // Absent is the first-run case, not an error.
  }
  if (before !== undefined && before.trim() !== "") existing = JSON.parse(before);

  const merged = mergeHookSettings(existing, port);
  const after = `${JSON.stringify(merged, undefined, 2)}\n`;
  if (after === before) return { changed: false };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  return { changed: true };
};
