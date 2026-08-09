import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { SessionState } from "./tmux.ts";

/**
 * Body limit for `POST /api/hooks/:id`, larger than every other route's.
 *
 * A hook payload carries the turn's text whether or not anything here reads it, and the fields are
 * already cut to `MAX_FIELD_CHARS` code points by the hook command before it sends. Two of those
 * at three bytes per character is the size this has to clear, and it is the reason the number is
 * not the 64KB the rest of the API uses. Bounded above by the route's own rate limit either way.
 */
export const HOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Where the hook command cuts the payload's two long fields, in code points rather than bytes.
 *
 * Nothing reads that text since the turn log was removed, but the agent still sends it, so this is
 * what keeps a long answer from producing a body the route refuses - and a refused body loses the
 * STATUS frame for that turn, which is the half still wanted. Code points because a byte cut
 * splits a multi-byte character; the number is chosen so two such fields fit inside the limit
 * above at three bytes per character.
 */
export const MAX_FIELD_CHARS = 16 * 1024;

/** What the hook command buffers before giving up: enough to parse and trim a large payload. */
const HOOK_READ_LIMIT = 1024 * 1024;

// Claude Code's hooks, mapped to session states, and the settings fragment that installs them.
//
// This is the `hook` mechanism of plan 004: the agent's own statement about itself, rather than
// our inference from its pixels. It cannot drift out of sync with a redesigned TUI, it costs no
// polling, and it arrives at the transition instead of up to a poll interval later.
//
// EVERY event name and payload field named below was OBSERVED, not documented or remembered.
// Captured from claude 2.1.221 on 2026-08-04 by pointing `--settings` at a throwaway file whose
// hooks appended their stdin to a log, and driving a real session: a print-mode run that wrote a
// file, then an interactive tmux session that hit a permission prompt, ran an Explore subagent,
// and was left idle. The payloads are committed verbatim in `fixtures/claude-hooks.jsonl` and the
// tests map that file rather than anything hand-written.
//
// What the capture showed, and did not:
//
//   Two `notification_type` values exist in that version: `permission_prompt` and `idle_prompt`.
//   Both mean a person is needed. NO informational `Notification` subtype was seen at all - the
//   subagent case that bit MulmoTerminal arrived here as its own `SubagentStop` EVENT, mid-turn,
//   with the parent turn still running. So it is denied at the event layer below, and the
//   informational-subtype denylist ships EMPTY rather than populated with a string nobody here
//   has seen (plan 004: mechanisms are observed, never guessed).

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
 * `Notification` subtypes that are announcements rather than requests for a person.
 *
 * Empty, deliberately. MulmoTerminal's expensive finding was that a subagent completing fired the
 * same `Notification` as a blocked turn, so every finished subagent lit a cell, beeped and pushed
 * once per subagent. In claude 2.1.221 that signal is a separate event, so there is nothing
 * observed to put here. An entry is added the day a payload carrying it is captured.
 */
export const INFORMATIONAL_NOTIFICATION_TYPES: ReadonlySet<string> = new Set<string>();

/**
 * Events observed to fire mid-turn while the parent turn continues.
 *
 * `SubagentStop` is the whole of MulmoTerminal's bug seen at the layer this version puts it: a
 * subagent finishing is something ending, not somebody being needed, and treating it as `waiting`
 * flags a tab whose agent is still working.
 */
const INFORMATIONAL_EVENTS: ReadonlySet<string> = new Set(["SubagentStop"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Map one hook payload to a state.
 *
 * The denylist applies at the layer it was learned at and NOT above it, which is the one rule in
 * this file worth arguing about:
 *
 *   An unrecognised `notification_type` INSIDE a `Notification` is ACTIONABLE. Agents add
 *   subtypes over time and the two failure modes are not equal - a spurious "needs you" is an
 *   annoyance, a swallowed one is the feature not working, with no way for a person to discover
 *   a stuck session.
 *
 *   An unrecognised EVENT NAME gets the opposite treatment: log it, change no state. Generalising
 *   the denylist upward means the next `PreCompact` or `SessionStart` that Claude Code ships
 *   lights the strip as "needs you" - not merely uninformative but wrong, which contradicts
 *   "fewer states, never a wrong one". An event never observed is by definition one whose meaning
 *   has not been established.
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
 * How agentdeck's own hook entries are recognised on a later merge.
 *
 * The URL path prefix rather than the whole command, so changing the port, the transport or the
 * flags still replaces the previous entry instead of leaving a stale one beside it. It also still
 * matches the older curl form, whose URL contained this prefix too.
 */
export const HOOK_MARKER = "/api/hooks/";

/**
 * The one line that runs per event.
 *
 * Two properties it must have. It exits 0 whatever happens: a hook that fails loudly would make
 * a status server the agent's problem, and a status field is never worth a blocked turn. And it
 * does nothing at all when `AGENTDECK_SESSION_ID` is unset, which is the case for every claude a
 * human runs in a plain terminal that happens to share the settings file.
 *
 * The session id and secret arrive through the environment because that is per process and needs
 * no coordination - the file itself is shared by every session of this agent (plan 004).
 *
 * The transport is `node -e` rather than curl, and that is the whole point of this shape. A shell
 * expands "$AGENTDECK_SECRET" BEFORE exec, so a curl form puts the literal secret in argv, and
 * argv - unlike the environment - is readable from any process running as this user
 * (`ps -Ao args=`). A hook fires dozens of times a turn, so that would broadcast the secret
 * continuously for the life of the session. Node reads it out of its own environment instead, so
 * no value ever reaches an argument.
 *
 * The interpreter is written out as the ABSOLUTE path of the node this server is running on, not
 * the bare name `node`. The curl form it replaced needed no PATH beyond `/usr/bin`; a bare `node`
 * does, and a session started from launchd or any at-boot wrapper gets a minimal PATH with no
 * Homebrew/mise/nvm node on it. Every hook would then die with `node: command not found`, the
 * trailing `exit 0` would swallow it, and the strip would silently stop reporting waiting sessions.
 * `installHookSettings` rewrites the file at every boot, so a moved or rebuilt node self-heals on
 * the next start.
 */
export const hookCommand = (port: number, interpreter: string = process.execPath): string => {
  if (!interpreter.startsWith("/")) {
    throw new Error(`hook interpreter must be an absolute path, got ${interpreter}`);
  }
  const quoted = `'${interpreter.split("'").join(`'\\''`)}'`;
  const script =
    // curl had `-m 2`, a cap on the whole operation. `timeout` below is only a socket-inactivity
    // timer and cannot even start until stdin closes, so without this a hook whose stdin is never
    // closed leaves a Node runtime resident for the life of the session, buffering as it goes.
    `setTimeout(()=>process.exit(0),2000).unref();` +
    `let b="";` +
    // A StringDecoder holds a partial multi-byte sequence across a read boundary; appending raw
    // chunks decodes each one alone, and a character split by the boundary becomes U+FFFD. NOT
    // observed here - a 90KB Japanese payload came through both ways intact, because it takes the
    // boundary landing inside a character - and kept anyway: payloads only became big enough to
    // be chunked at all when they started carrying a turn's text, and the corruption it prevents
    // is silent and permanent once written.
    `process.stdin.setEncoding("utf8");` +
    // Buffered well past what will be sent, because the trim below needs the whole payload to be
    // valid JSON before it can shorten it. Anything past this is a payload nothing will accept.
    `process.stdin.on("data",(c)=>{if(b.length<${String(HOOK_READ_LIMIT)})b+=c}).on("end",()=>{` +
    // The two long fields are cut HERE, in the agent's own process, before the payload crosses
    // the socket. Without it a turn with a long answer produced a body the route refuses, so the
    // status frame for that turn was lost as well as its text - and a long answer is exactly the
    // turn the log exists for. Code points, not bytes: a byte cut halves a multi-byte character.
    //
    // ONE character past the store's own bound, deliberately. Cutting to exactly the bound here
    // would hand the store a field it cannot tell from a complete one, and the log would call a
    // truncated answer whole. One over means the store's own cut fires and sets `truncated`.
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

// Both halves, because the marker alone is a generic path segment. It was
// `/api/hooks/$AGENTDECK_SESSION_ID` before the command grew a node script and the interpolation
// moved inside it; widening it to `/api/hooks/` made this a substring test that matches any hook
// posting to any local service with that path. `mergeHookSettings` deletes what it recognises as
// ours and installHookSettings re-runs at every boot, so a stranger's PreToolUse guard hook would
// vanish silently - a security downgrade performed by the one component that promises not to
// touch other people's entries. Every form we have ever emitted contains both strings.
const isOurHook = (hook: unknown): boolean =>
  isRecord(hook) &&
  typeof hook["command"] === "string" &&
  hook["command"].includes(HOOK_MARKER) &&
  hook["command"].includes("AGENTDECK_SESSION_ID");

/**
 * Merge the fragment into whatever the settings file already holds.
 *
 * A human also edits this file, so it preserves every key it did not write - including hooks by
 * someone else on the same event, and settings that have nothing to do with hooks. Idempotent by
 * construction: our own entries are removed and re-appended in the same place, so a second merge
 * of the same input produces byte-identical output.
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
 * Merge into the file at `path`, once, at server start.
 *
 * One agent-state directory means one settings file shared by every session of that agent, so
 * merging per session would be concurrent writes for a result that is identical every time
 * (plan 004).
 *
 * Malformed JSON throws rather than being overwritten: the file belongs to a human too, and
 * silently replacing their broken edit with our fragment loses whatever they were mid-way
 * through. The caller logs it and drops the mechanism, never the profile.
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
