# 002 — Wire protocol

The contract between the Mac server and the phone client. Written before either side, so they
are built to the same shape rather than to guesses about each other — the approach that worked
for `mulmoterminal/pwa`, where the two halves were written in parallel and met cleanly.

This document is the authority. If an implementation needs a different shape, this file changes
first.

## HTTP

Every request from the phone carries `Authorization: Bearer <token>`. JSON in, JSON out. The one
route not called by the phone authenticates differently, for reasons given under it.

| Method | Path | Answers |
|---|---|---|
| `GET` | `/api/sessions` | `{ sessions: Session[] }` |
| `POST` | `/api/sessions` | `{ session: Session, warning?: string }` — body `{ cwd, agent }` |
| `DELETE` | `/api/sessions/:id` | `{ closed: true }` |
| `GET` | `/api/agents` | `{ agents: AgentSummary[] }` — the configured profiles |
| `GET` | `/api/cwds` | `{ cwds: Cwd[] }` — the directories a session may be started in |
| `GET` | `/api/health` | `{ ok: true, version }` |
| `POST` | `/api/hooks/:sessionId` | `{ ok: true }` — an agent reporting its own turn boundary |

```ts
interface Session {
  id: string;          // stable across restarts; derived from the tmux session name
  name: string;        // repo basename, what the tab shows
  cwd: string;         // absolute path on the Mac, matching a Cwd.path
  agent: string;       // profile id: "claude", "gemini", "shell", ... (plan 004)
  state: SessionState;
  startedAt: number;   // unix ms. Not to be confused with the stream `epoch` below
  exitCode?: number;   // present only when state is "exited"
}

type SessionState = "working" | "waiting" | "idle" | "exited";

interface AgentSummary {
  id: string;
  name: string;            // for the new-session picker
  available: boolean;      // its command resolves on PATH right now
  detectsWaiting: boolean; // profile has a working waiting mechanism; false means this agent
                           // reports only working/idle/exited (plan 004)
}

interface Cwd {
  path: string;            // absolute path on the Mac
  name: string;            // basename, what the picker shows
  sessions: string[];      // ids of live sessions already in this directory
}
```

**`GET /api/cwds` exists because the client cannot construct a valid `cwd` on its own.** The
allowlist is `AGENTDECK_MOUNTS` (plan 005) and is knowable only to the server; a phone user
typing an absolute path into a soft keyboard is not a design. The new-session picker is built from this route — pick a directory, pick an agent — and
`sessions` is what lets it show the two-agents-in-one-tree warning below *before* the session is
created rather than in the response to creating it.

**Session ids are derived from the tmux session name, and that name is not free-form.** tmux
rejects `.` and `:` in a session name, and a repo basename is not unique — two checkouts named
`web` under different parents are a collision, and a collision means `new-session -A` silently
attaches to somebody else's agent. So the name is
`<sanitised-basename>-<agent>-<short-hash-of-abs-path>`: the basename to keep `tmux ls` readable
by a human, the path hash to make it correct, the agent id because of the paragraph below. `name`
on the session is the unsanitised basename, because that is what the tab shows.

The id is a pure function of **(absolute path, agent id)**, which is what makes it stable across a
restart without anything being written down.

**The agent id is in the key, not decoration.** Keyed on the path alone, a second create in a
directory that already has a session would hit `new-session -A`, silently attach to the agent
already running there, and return a `Session` whose `agent` field was a lie — which would make
[plan 004](004-agent-profiles.md)'s "two agents in one working tree: warn, do not block"
unreachable in the exact case it was written for. With the agent in the key the two cases separate
cleanly:

- **Same `cwd`, different agent.** A second session is created. `warning` names the other live
  session in that directory, because two processes editing one working tree is worth saying out
  loud even when it is legitimate.
- **Same `cwd`, same agent.** `-A` attaches to the session already there and the response *is*
  that session, with `warning` saying so. This is the case plan 004's argument justifies least —
  a second identical agent in one tree is more likely a forgotten tab than an intention — and
  handing back the running one is the better failure.

**`exited` needs `remain-on-exit on`.** By default tmux destroys a session when its command exits
(verified: `remain-on-exit off` on tmux 3.7b), so an agent that finishes or crashes takes its own
tab with it and `exitCode` can never be reported at all. Sessions are created with the option on;
`state` comes from `#{pane_dead}` and the code from `#{pane_dead_status}`. A dead session is
reaped by `DELETE` or at server start, never on a timer — "exited 1" in the strip is the answer to
"did it finish, or did I lose it", and expiring it after five minutes puts the question back.

`state` is inferred (see plan 001). It is the field the tab UI exists to show, so it is on the
list response rather than something the client has to open a stream to learn — the tab strip
must be able to say "this one needs you" without attaching to every session at once.

`detectsWaiting: false` is a supported configuration, not a defect. The client shows that
agent's tab without a needs-you indicator rather than inventing one.

**The client names an agent, never a command.** `POST /api/sessions` takes a profile id and the
server owns what that profile executes. A remote client supplying a command line is remote code
execution with extra steps — the same reasoning that keeps paths out of the request. `cwd` is
validated against a configured allowlist, which is the **individual repositories chosen**, not
a root they sit under (plan 005) — and which, since 2026-08-07, also bounds the session set the
server will list and stream at all, not only what it will create. MulmoTerminal's
protocol doc calls the allowlist out as a standing rule, and it is right.

A `cwd` that is not on it is refused with a sentence naming what would have to change, because
that refusal is the one a person meets most often — a repository cloned since the server
started is not on the list, and cannot be until it is restarted.

`warning` is set whenever the new session's `cwd` already has a live session, in either of the two
shapes above — two agents in one working tree, which is allowed but worth surfacing, or the same
agent handed back rather than started twice (plan 004).

### `POST /api/hooks/:sessionId`

The inbound half of the `hook` mechanism in [plan 004](004-agent-profiles.md), and the only route
the phone never calls. The agent calls it over loopback; the body is
whatever that agent's hook payload is, parsed by the profile's handler rather than by the route,
and mapped to a `state` message on the socket.

It does **not** take the user's bearer token. That token is the phone's, and writing it into a
settings file that a coding agent reads by design hands the agent the key to every session on the
machine. Each session is instead spawned with its own random secret in its environment, which the
hook sends back and the route checks against that session id.

The asymmetry is the point: a leaked session secret can lie about one session's status, while the
user's token can start processes.

**What the secret is not is a wall between sessions.** Every session runs as the same user on
the same Mac, and this used to be written down as one agent reading another's
`/proc/<pid>/environ` — a path macOS does not have. Stating the mechanism this host actually has
matters, because the Linux one being absent reads like the hazard being absent:

- **What did exist, and was easier.** `tmux new-session -e NAME=VALUE` stores the variable in the
  tmux *session* environment, so `tmux -L <socket> show-environment -t <session>` printed every
  session's `AGENTDECK_SECRET`, and the agent API keys with it, to any process running as this
  user. No debugger, no privileged call. Closed on 2026-08-07: `src/tmux.ts` unsets those
  variables from the session environment in the same invocation that forks the pane, which leaves
  the value with the agent and takes it from the reader.
- **What that first fix left behind, and is also closed.** Removing a value from the session
  environment did nothing about the `-e NAME=VALUE` still sitting in the tmux client's *argv*, and
  macOS hides another process's environment from `ps` while showing it every process's argv —
  verified here, `ps -Ao args=` printed a sibling's full command line. An agent sampling `ps` in a
  loop needed only the tens of milliseconds a `new-session` client lives to read the next session's
  secret and the operator's API key. Closed the same day: no value is passed as an argument at
  all. They travel in the creating client's own environment, and a `update-environment` name list —
  set immediately before `new-session` and emptied immediately after, in the same invocation — is
  what copies them into the session tmux then forks the pane from.
- **What still exists.** Same uid means one agent can attach a debugger to another agent's
  process, and can read every file this user owns — the other sessions' transcripts, and whatever
  credentials are on disk. macOS will not show another process's environment to `ps`, which makes
  this harder than `cat /proc/<pid>/environ`; it does not make it a boundary. It also says nothing
  about argv, which `ps` does show — hence the bullet above.

So the secret bounds what a *remote* caller can do with a stolen one; it bounds nothing between
two agents on the same machine, and plan 005 is explicit about why no such boundary exists.

## WebSocket

One connection, multiplexed over all attached sessions. Not one socket per tab: phones
background aggressively, and re-establishing N sockets on wake is N chances to fail.

Client to server:

```ts
{ t: "attach", sessionId, cols, rows, haveEpoch?, haveSeq? }  // where I got to last time
{ t: "detach", sessionId }
{ t: "input",  sessionId, data }          // raw bytes the user typed
{ t: "resize", sessionId, cols, rows }
{ t: "resync", sessionId, haveEpoch, haveSeq } // I saw a gap, send me a snapshot
```

Server to client:

```ts
{ t: "snapshot", sessionId, epoch, seq, history?, data } // scrollback, then a live repaint
{ t: "chunk",    sessionId, epoch, seq, data }           // incremental output
{ t: "state",    sessionId, state, exitCode? }
{ t: "sessions", sessions }               // list changed: created, exited, renamed
{ t: "error",    sessionId?, message }    // written for a person to read
```

### Rules

**`seq` is a per-session cumulative BYTE COUNT, not a message counter.** A chunk's `seq` is the
count of bytes the session had produced through the end of that chunk. This is the definition
that makes the one question the protocol has to answer answerable: whether the ring buffer still
covers a client at `haveSeq` is arithmetic on `headSeq - buffer.byteLength` and nothing else. (The
exact test is below; it has a second bound the obvious version is missing.) A message counter
cannot answer the question at all without keeping every chunk boundary forever, which is a second
buffer holding the same bytes.

**`seq` is only meaningful inside an `epoch`, and the two always travel together.** The counter
lives in memory; session ids deliberately do not. After a server restart the session is still
alive with the same id, the client still holds a `haveSeq` in the millions, and the server's
`headSeq` has gone back to zero — at which point the coverage test above says "covered" for a
client that is far ahead of anything the server holds, the server sends chunks, and the client
discards every one of them as already seen. The tab paints nothing, forever, while the socket, the
session list and the status field all look correct. That is the failure this protocol is least
able to notice and the client is least able to explain.

So the server stamps each session with a random `epoch` for the lifetime of the process. Rules:

- Every `snapshot` and `chunk` carries it. An `attach` may carry `haveEpoch` and `haveSeq`.
- A missing or mismatched `haveEpoch` is an unconditional snapshot. No coverage test is run,
  because the numbers being compared are not in the same space.
- Within an epoch the test is two-sided: `headSeq >= haveSeq >= headSeq - buffer.byteLength`. The
  upper bound is redundant once epochs are correct, which is why it is there — it is the assertion
  that fails loudly if they are ever not.

The client tracks the last `seq` it rendered; on a gap it sends `resync` rather than rendering a
hole. A terminal that silently drops bytes is worse than one that flickers — the missing bytes
are usually the escape sequence that would have reset the colour.

**A snapshot supersedes everything before it.** On receiving one, the client clears and repaints.
This is what makes reconnect uneventful.

**A cold snapshot is two different things, because scrollback and the live screen are two
different problems.** When the ring buffer does not cover a client:

```ts
{ t: "snapshot", sessionId, epoch, seq, history?, data }
```

- `history` is `capture-pane -p -e -S -<n> -E -1` — the lines that have already scrolled off the
  pane. The client writes it first, unparsed. Absent when there are none.
- `data` is the live screen, produced by `refresh-client -R`, which makes tmux repaint into the
  stream the server is already reading. Same bytes, same format, same counter, so `seq` is simply
  the count after the repaint's last byte and the client discards any chunk at or below it.

An earlier draft used `capture-pane` for both. It is the right tool for the first and the wrong
tool for the second, twice over:

- **It returns lines, not terminal state.** Cursor position, alternate-screen mode, scroll region,
  bracketed-paste and application-keypad modes, and any partially drawn line are all absent from
  `-p -e`. For lines that have already scrolled away none of that matters — they are text now, and
  will never be drawn on again. For the screen the agent is still drawing on, all of it matters:
  paint that into xterm.js and the client is diverged from the pane, with every subsequent chunk
  rendering against the wrong state. Same "the stream is not the screen" hazard as plan 001, met
  from the other side.
- **The `seq` it should carry is unanswerable.** tmux updates its pane model when the agent writes
  and forwards to attached clients on the next redraw, so a capture is *ahead* of `headSeq`, not
  behind it. The earlier draft claimed the opposite and called it the safe direction; it is the
  direction it names as unsafe in the same sentence. The repaint has no such problem: it *is* the
  stream, so its position in it is not a question.

In alternate-screen mode `history` is absent, because there is no scrollback to capture. That is
correct rather than degraded — a full-screen TUI has no history to show.

`capture-pane` keeps one other job: reading the rendered screen for a `screen` waiting mechanism
(plan 004), where lines of text is precisely what is wanted.

**The socket is pinged, because mobile TCP goes half-open.** A phone that loses signal mid-stream
leaves a connection that is dead at both ends and closed at neither; nothing below arrives, nothing
errors, and the strip shows a status frozen at whatever it last said. That is a confidently wrong
status, which is the one output this design refuses — and the reconnection ladder below never runs,
because from the client's side nothing has gone wrong. The server pings every 15 seconds and closes
a connection that has not ponged within 30; a client that has seen no traffic for two intervals
reconnects rather than waiting to be told.

**Resize is the smallest attached client's, not the newest.** One tmux client backs N browser
clients, so an `attach` or `resize` from a phone that was just unlocked would otherwise reflow
somebody else's tab under them. The server keeps the dimensions each client last reported and
sizes the pane to the minimum. A client detaching releases its constraint; the pane grows back;
with no clients attached the pane keeps the last size anyone asked for.

This is our arithmetic, not tmux's — there is only ever one real tmux client here, and tmux's own
default is the opposite (`window-size latest`, verified on 3.7b; it was smallest before 2.9). The
argument is that the two ways of being wrong are not equal: a pane smaller than the viewport wastes
screen and is obvious, while a pane wider than the viewport wraps every line and is unreadable, and
only the first is recoverable by looking at it.

**Input is never echoed back specially.** It returns as ordinary output, because that is what the
PTY does. The client must not optimistically render typed characters — the agent may be in a
mode that transforms or refuses them.

**`state` is pushed, not polled.** The tab strip updates from these messages. Polling would
reintroduce the latency this design exists to remove.

**Errors are sentences.** The server writes `message` for a person; the client renders it
verbatim. Rewording a refusal on the client loses the advice it contained.

## Reconnection

The phone's socket will drop constantly — network changes, screen sleep, backgrounding. This is
the normal case, not an error path.

1. Client reconnects with exponential backoff, capped low (a few seconds) — the user is usually
   looking at the screen when it happens.
2. On open, it re-sends `attach` for every visible tab with its last `epoch` and `seq`.
3. Server replies with `chunk`s if the epoch matches and the ring buffer still covers that point,
   otherwise a `snapshot`. A server that restarted while the phone was asleep fails the epoch
   test, which is the common case and the one that has to be uneventful.
4. Tabs show a "reconnecting" affordance only after the first retry fails, so a normal
   half-second reconnect does not flash UI at the user.

**A restarted server does not reach step 3 today, and the client cannot make it.** The epoch rule
above is what makes a restart uneventful once the server still has the session — and since
`m0/host-boundary` gated `Registry.list()` on the registry's in-memory `#meta`, a session that
outlived the server process is not listed at all, so the re-attach is answered
`no session <id>` and the tab is stranded with a live agent behind it. Measured, against a real
server process killed and restarted under a real client, in `src/client/end-to-end.test.ts`.
Recreating the session — `new-session -A`, so the same live process — hands the registry its
metadata back, and from there the epoch half does exactly what this section says: the client's
stored `seq` is in a space that no longer exists, the server sends an unconditional snapshot in a
new epoch, and the tab repaints. Nothing on the client can substitute for that recreate; making a
restart recover by itself is the metadata gap recorded under `m0/supervisor-crash-test`, not a
reconnection change.

**A rejected token is not a network failure and must not be retried as one.** A `401`, or a
socket the server closes at the handshake, means the token has been rotated — the client stops
backing off, drops what it has stored, and shows the paste field with a sentence saying so
(plan 001, authentication). Backing off forever against a server that is answering correctly is
the worst version of this: it looks exactly like being out of range.

**A `403` is neither of those, and gets its own sentence.** A server started with
`AGENTDECK_ORIGIN` set to an address the page was not opened from refuses every `/api` call and
the socket upgrade alike, and the upgrade's status never reaches a browser — so the probe over
HTTP is the only place the difference is visible. Read as "not a 401, so the token is good", it
becomes "must be the network" and the ladder runs forever over a configuration mistake. So the
probe answers three things rather than two — good, token rejected, origin refused — and the third
stops the ladder and says what has to change, without dropping the stored token: the token is not
what is wrong, and asking for a new one would send the user after the wrong thing.

## What is deliberately absent

- **No scrollback pagination.** The client gets what the ring buffer holds, or one fixed depth of
  `history` on a cold snapshot. If reading further back is ever needed, that is a plan, not an
  ad-hoc parameter.
- **No file, git, or repository operations.** See the non-goals in the README.
- **No message persistence.** Nothing in this protocol is written to disk on either side.
- **No multi-client coordination beyond the size rule above.** Two phones attached to one session
  both see the output and both can type, exactly as two `tmux attach` clients would. No locking,
  no presence. Size is the one thing they cannot each have their own of, because the pane has
  only one, which is why it gets a rule and nothing else does.
