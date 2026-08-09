# 007 — The turn log

A per-session record of what was asked and what the agent finally answered, kept outside the
terminal, and readable from the phone as a list rather than by scrolling.

The mechanism was captured before this was written, from claude 2.1.226 on 2026-08-09, into
`src/fixtures/claude-turns.jsonl`. What that capture did and did not settle is the last section,
and it is the section to read before changing anything here.

## The problem this exists for

The scrollback is the wrong store for an answer, and every attempt to make it the right one has
cost something:

- **It is bounded by lines, not by turns.** `HISTORY_LINES` is 2000. One agent turn that reads a
  large file can spend that on tool output, and the answer above it is gone.
- **It is wrapped at a width that is not the reader's.** `capture-pane` returns history hard-wrapped
  at whatever the pane was when the text was written. Fixed on 2026-08-09 with `-J`, which joins a
  wrapped line so the client re-wraps at its own width — but that fix only works because the answer
  is prose. It is a repair, not a store.
- **It is ANSI, so it cannot be searched, and it cannot be copied cleanly.** The bytes that make
  the answer readable are the same bytes that make it unquotable.
- **Scrolling on a phone is a bad way to find a thing you already read.** This is the report that
  started it: the answer is up there somewhere, and getting to it is a drag gesture over a
  repainting TUI.

The answer to a turn is not terminal state. It is a discrete piece of text with a beginning, an
end, and a question it belongs to. Storing it as such is cheaper than making the terminal pretend.

## Where the text comes from

**The agent's own hook payload.** Claude Code's `Stop` hook carries the field already:

```jsonc
// src/fixtures/claude-turns.jsonl, captured from claude 2.1.226 on 2026-08-09
{
  "hook_event_name": "Stop",
  "session_id": "...",
  "prompt_id": "c0292d75-...",
  "last_assistant_message": "# What Is a PTY?\n\nA **PTY** (pseudo-terminal, ...",  // 3776 chars
  "transcript_path": "..."
}
```

and `UserPromptSubmit` carries the other half, with **the same `prompt_id`**:

```jsonc
{ "hook_event_name": "UserPromptSubmit", "prompt_id": "e3cdc62b-...", "prompt": "Create a file..." }
```

So a turn is `UserPromptSubmit` joined to `Stop` on `prompt_id`. That is an exact key the agent
supplies, not a correlation we invent from timestamps, and it is the reason this is a small
feature rather than a guessing game.

`POST /api/hooks/:sessionId` already receives both events and already authenticates them with the
session's own secret ([plan 002](002-wire-protocol.md)). `src/claude-hooks.ts` already parses them
and throws the payload away after deciding a state. Everything needed is arriving and being
discarded.

**Rejected: parsing the answer out of the PTY stream.** It is ANSI, it is redrawn, the agent may
be on the alternate screen, and the boundary between "the answer" and "the tool output above it"
exists only in the rendering. Plan 001 already refuses `screen` as a status mechanism for weaker
reasons than these.

**Rejected: reading `transcript_path` ourselves.** It is offered, and it holds more than the hook
does — every message, not just the last. But it is an undocumented on-disk format belonging to
another program, it moves, and reading it makes agentdeck a parser of Claude Code's internals
rather than a consumer of its stated API. The hook field is the agent's own statement about
itself, which is the same preference order plan 004 sets for `waiting`. If a turn log with tool
calls in it is ever wanted, that is when this decision gets re-opened, and it gets re-opened with
a capture in hand.

**Rejected: sqlite.** Both the obvious options are refused for their own reason. `better-sqlite3`
is a seventh runtime dependency against a budget CLAUDE.md declares spent. `node:sqlite` costs no
dependency but is experimental on the Node this repo pins (`>=22.18`; v22.23 locally), and a
warning-emitting experimental API is not what the persistence layer should be.

Underneath both is that the data does not want a database. It is append-only, one writer, a few KB
per turn, and the only query is "this session's turns, newest first". `001-architecture.md` states
"tmux is also the scrollback store. This is the single decision that removes the database from the
design", and that sentence stays true: this stores answers, not scrollback, and it stores them in
a file. The day the wanted query is "search every session for the turn where we decided X",
sqlite becomes the right answer and a JSONL file is a one-pass migration into it.

## What is stored, and where

One file per session, JSON Lines, one line per completed turn:

```
~/.agentdeck/turns/<sessionId>.jsonl
```

```ts
interface Turn {
  promptId: string;   // the agent's prompt_id; the join key and the de-duplication key
  askedAt: number;    // unix ms, when UserPromptSubmit arrived
  endedAt: number;    // unix ms, when Stop arrived
  prompt: string;     // truncated, see bounds
  answer: string;     // truncated, see bounds
}
```

`~/.agentdeck` rather than `~/.config`: the token and `agent-state` are already there, so this is
one state directory rather than two. Mode `0600` on the file, `0700` on the directory — it holds
the text of everything the agent said in every repository.

Session ids are a pure function of (absolute path, agent id) and stable across restarts
(plan 002), so the file survives a server restart and a reboot, and reattaches to the same session
by name with nothing written down to reconcile. This is the first thing agentdeck keeps that
outlives tmux, and that is a deliberate widening of the "the working day is the stated persistence
requirement" scope in plan 001 — stated here rather than left to be discovered.

**Bounds, all three of them, because the writer is a remote-ish caller.** A leaked session secret
could previously lie about one session's status; with this it can also write to disk. So:

- `prompt` and `answer` are truncated at **16384 code points each**, and the turn carries
  `truncated: true` when either was cut. Code points rather than bytes: a byte cut splits a
  multi-byte character, and the capture includes a Japanese answer.

  **The cut happens twice, and the second one is why the flag is honest.** The hook command cuts
  in the agent's own process, before the payload crosses the socket - without that a long answer
  produced a body the route refuses, so the turn lost its STATE as well as its text, and a long
  answer is exactly the turn this exists for. That cut is to the bound plus ONE character, so the
  store's own cut still fires and sets the flag. Cutting to exactly the bound made a truncated
  answer indistinguishable from a whole one, and the log called it complete; found by running it,
  not by a test.
- The file is trimmed to the **most recent 500 turns**, rewritten at that point rather than
  appended forever.
- A `Stop` whose `promptId` already has a line is **ignored**, not appended. `stop_hook_active` in
  the payload says a `Stop` can fire again for the same turn; a re-fire must not double the log.

A turn with no matching `UserPromptSubmit` (the server was restarted mid-turn, or the session was
started outside agentdeck) is written with `prompt: ""` rather than dropped. The answer is the part
that is hard to get back.

## How the phone reads it

One new route, no new WebSocket frame:

| Method | Path | Answers |
|---|---|---|
| `GET` | `/api/sessions/:id/turns` | `{ turns: Turn[], truncated: boolean }` — newest first |

Bearer token, like every other phone route. `?limit=` bounded server-side; the response is capped
by total bytes as well as by count, and `truncated` says the cap was hit.

**No `turn` frame on the socket, deliberately.** The client already learns when a session's state
changes, and a turn ending is a transition to `idle` it is already told about. Refetching this
route on that transition is one request per turn, on a tab the user is looking at, against a local
server. A push frame would be a second delivery path for the same fact, with its own ordering
question against the stream's `seq`, to save a request that costs nothing. If the refetch ever
proves visibly late, that is the evidence that changes this.

The UI is an overlay on the current tab: a list of turns, newest first, each showing its prompt as
the title and the answer's first lines beneath; tapping one opens the whole answer as selectable
text. It is not a terminal, so it wraps at the phone's width, scrolls like a page, and can be
copied.

## Which agents get one

`hook` is the only mechanism proposed here, so **an agent without a hook profile has no turn log**,
exactly as it has no `waiting` (plan 004). This is a supported configuration and not a defect: the
client shows no history affordance for that session rather than an empty list that looks broken.

That needs a field on the profile summary the client already receives:

```ts
interface AgentSummary {
  // ...
  logsTurns: boolean;   // this profile reports turn text; false means no history for its sessions
}
```

`shell` will be `false` and always was going to be — a shell has no turns.

## What the capture settled, and what it did not

The first draft of this document rested on one field seen once — `"Done."`, a two-word answer to a
trivial prompt, from claude 2.1.221 on 2026-08-04. That is not enough to build on, so three more
turns were captured from claude 2.1.226 on 2026-08-09, by pointing `--settings` at a throwaway file
whose `UserPromptSubmit` and `Stop` hooks appended their stdin to a log, and running real print-mode
sessions. The payloads are in `src/fixtures/claude-turns.jsonl` verbatim.

**Settled:**

- **A long answer arrives whole and in plain text.** 3776 characters of markdown — headings, bold,
  a fenced code block, a bulleted list, em dashes — as one `string`, with no ANSI and no
  truncation. This is the observation the whole feature needed.
- **Non-ASCII is intact.** A 216-character Japanese answer came back correct. Worth checking rather
  than assuming: the locale handling in `src/tmux.ts` exists because exactly that assumption was
  wrong once already, on a different path.
- **`prompt_id` pairs the two events exactly**, in every captured turn.
- **`last_assistant_message` is the final assistant text block, verbatim.** Confirmed against the
  transcript for the third turn: the model's last block was the literal text `<br>` and the field
  was `"<br>"`. It is the agent's own words, not a rendering and not a summary.
- **The payload gained a field between 2.1.221 and 2.1.226** (`effort`). The parser must ignore
  fields it does not know, which is what "observed, never guessed" means in practice for a payload
  that is still moving.

**Not settled, and handled defensively rather than assumed:**

- **A turn whose final block is a `tool_use` rather than text.** The attempt to force one failed —
  told to end on the tool call and say nothing, the model emitted `<br>` as its final text block,
  so a text block still existed. Claude Code turns appear to always end in text, but "appear to"
  is not an observation. The store therefore treats a missing, non-string, or empty
  `last_assistant_message` as **no turn to log**, and logs nothing rather than an empty entry.
- **An interrupted turn, and a turn that ended in an error.** Print mode dies to `SIGINT` before
  any `Stop` fires, so neither was captured. Same defensive handling covers them.
- **Compaction and `--resume`, and whether `prompt_id` survives either.** Not captured. The
  consequence if it does not is bounded and stated: a turn whose `Stop` carries an unseen
  `prompt_id` is written with an empty `prompt`, which is the same path as a server restart
  mid-turn, and the answer — the part that is hard to get back — is still stored.

Anything built past these bounds needs its own capture first.

## Amendments made elsewhere

- **001** — the persistence claim. "No database" stands and is restated as "no database, one
  append-only file per session"; the "the working day is the stated persistence requirement" scope
  gains the exception named above.
- **002** — the new route, the `Turn` shape, `logsTurns` on `AgentSummary`, and a sentence under
  `POST /api/hooks/:sessionId` saying what a leaked session secret can now do: write bounded text
  into that session's log. It still cannot start a process.
- **004** — `logsTurns` as a profile-derived property, and the statement that `hook` is the only
  mechanism that yields one.

## Residual, recorded rather than solved

Every answer the agent gave is now plaintext on disk, owned by the operator, in a directory any
process running as the operator can read. That is the same-uid residual plan 005 records, and this
adds material to it rather than changing its shape: an agent that can read `~/.agentdeck/token`
could always read the sessions' transcripts, which is where this text already lived. It is one
more copy, in a more convenient format, and it belongs in `audit.md` the day it ships.
