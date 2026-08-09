# 004 — Agent profiles

Any agent CLI can be a session. There is no privileged one: Claude Code, Gemini, Codex, a local
setup — whichever suits the task gets its own tab, and any of them may orchestrate others from
inside its own session.

## Two axes, and only one costs anything

**A session's agent** — the CLI running under the PTY. This is what a tab is. It is a first-class
concept: `agent` on the session, a profile per CLI, a picker when creating one.

**What that agent calls** — sub-models it invokes itself: a shell out to `gemini -p "..."`, a
local model over Ollama, an MCP tool. **agentdeck neither knows nor cares.** Those calls happen
inside the session's PTY, so their output is that session's output — it streams over the existing
socket, lands in the existing ring buffer, and touches nothing in the session model.

That distinction is what keeps this small. Orchestration is an agent's business, not the
multiplexer's, whichever agent is doing it.

Status inference is unaffected for the same reason: the signal comes from **the agent that owns
the PTY** — its hooks, its event log, its screen. A sub-model taking two minutes to answer reads
as `working` for two minutes, which is correct regardless of who called it.

One useful interaction: an orchestrating agent hits permission prompts more often than one working
alone, because every sub-model call is a command invocation. Those prompts are exactly the
`waiting` state, and answering them from the phone is what this tool is for.

## Profiles

Declarative, so adding a CLI is config rather than a code change:

```jsonc
// ~/.config/agentdeck/agents.json
{
  "claude": {
    "name": "Claude Code",
    "command": "claude",
    "waiting": {
      "via": "hook",
      "settings": "claude-hooks.json"   // fragment merged into the agent-state volume
    }
  },
  // Shape only, not a shipped profile: codex is not installed here, so the glob and the
  // parser below are exactly the kind of thing the next section refuses to guess at.
  "codex": {
    "name": "Codex",
    "command": "codex",
    "waiting": {
      "via": "log",                     // tail the record the agent already writes
      "path": "<the rollout it writes, observed>"
    }
  },
  "gemini": {
    "name": "Gemini CLI",
    "command": "gemini",
    "env": ["GEMINI_API_KEY"]
    // no waiting mechanism: not installed, so nothing has been observed
  },
  "shell": {
    "name": "Shell",
    "command": "/bin/zsh",
    "args": ["-l"]
  }
}
```

### `waiting` is a mechanism, not a regex

Each CLI announces itself differently, and one of the ways is much better than the others. The
profile names which one applies, in this order of preference:

| `via` | What it is | Cost |
|---|---|---|
| `hook` | The agent calls us on its own turn boundaries | A settings fragment to install, one route |
| `log` | The agent writes an event record; we tail it | A path and a parser per agent |
| `screen` | We match the rendered prompt from `capture-pane` | Breaks silently; see plan 001 |
| absent | No `waiting` for this agent | Nothing |

`hook` is first because it is the agent's own statement about itself rather than our inference
from its pixels — it cannot drift out of sync with a redesigned TUI, it costs no polling, and it
arrives at the transition instead of up to a poll interval after it. Claude Code's `Notification`
hook in particular fires precisely when the agent is blocked on a person, which is the state this
whole tool exists to surface, and the one a push notification would eventually carry
([plan 003](003-milestones.md), M5).

`screen` is supported and documented, because some CLI will have neither of the others and a weak
signal beats none. It is not the default and it is not what `claude` uses. Its rules — match the
rendered screen and never the raw pty stream, scan rows rather than testing the last one, treat a
caret as necessary but not sufficient — are in [plan 001](001-architecture.md), together with the
evidence for why they are not negotiable.

### Rules

- **Absent `waiting` is a supported configuration, not a half-finished one.** That agent reports
  `working` / `idle` / `exited` and never claims `waiting`. Fewer states, never a wrong one.
- **A hook installs into agentdeck's own agent-state directory, not blindly into the user's
  `~/.claude`.** The directory is named by `AGENTDECK_AGENT_STATE_DIR`, falling back to
  `CLAUDE_CONFIG_DIR`, and the hook points at the server on loopback. Whichever it is, it is a
  directory a human also opens and edits, so the merge must preserve keys it did not write rather
  than rewriting the file wholesale. If neither variable is set the fragment lands where the agent
  will not read it, and a tab that promises `detectsWaiting` and never delivers it is the one
  output this design refuses — so the server says so at boot rather than letting it be discovered
  by waiting for a prompt that never lights up.
- **The merge happens once, at server start, not once per session.** One agent-state directory
  means one settings file, shared by every session of that agent — so "merge at session start" is
  concurrent writes to a file each of them is also reading, for a result that is identical every
  time. Merge idempotently at boot. What genuinely varies per session is the session id and the
  secret, and those arrive through the environment, which is per process and needs no coordination
  at all.
- **The hook command needs something that can make an HTTP request.** `curl`, or `node -e`. On the
  Mac both are already present, which is the one thing running on the host makes simpler rather
  than harder.
- **A hook must carry the session id it belongs to**, injected as an environment variable at
  spawn. Two sessions of the same agent are otherwise indistinguishable at
  the receiving route, and attributing one repo's `waiting` to another repo's tab is a wrong
  state, which is the one outcome this design refuses.
- **The denylist applies at the layer it was learned at, and not above it.** MulmoTerminal's
  finding was about the *subtypes* of one event: an unrecognised `notification_type` inside a
  `Notification` is treated as actionable, because agents add subtypes over time and the two
  failure modes are not equal — a spurious "needs you" is an annoyance, a swallowed one is the
  feature not working, with no way for a person to discover a stuck session otherwise.

  An unrecognised **event name** is different and gets the opposite rule: log it, change no state.
  Generalising the denylist upward means the next `PreCompact` or `SessionStart` that Claude Code
  adds lights the strip as "needs you" — a state that is not merely uninformative but wrong, which
  contradicts "fewer states, never a wrong one" and would fail plan 003's own M3 criterion about
  subagents. An event we have never observed is by definition one we have not established the
  meaning of, and plan 004's whole argument is that meaning is observed rather than assumed.
- **`env` lists variable NAMES, never values.** The server passes them through from its own
  environment. No API key is ever written into this file, so it is safe to read and to commit an
  example of.
- **`command` resolves against `PATH` at spawn time.** A missing binary is a clear refusal when
  the session is created, not a tab that dies a second after opening. `GET /api/agents` reports
  `available` so the picker can grey it out rather than offering a session that cannot start.
- **A broken `waiting` mechanism disables the mechanism, not the profile** — a malformed regex, a
  missing log path, a settings fragment that will not merge. Log the reason, drop that agent to
  `working` / `idle` / `exited`, and keep it startable. One bad edit must not take down the
  server for every agent, and it must not take away sessions to fix a status field.
- **The client names a profile id, never a command line.** The server owns what runs. A remote
  client supplying a command is remote code execution with extra steps.

## Mechanisms are observed, never guessed

Not from documentation, not from memory, not from what a hook payload or a prompt "should" look
like. Drive the real agent, record what it actually emitted as a fixture, write the handler
against that, commit both.

This holds for every tier and it bites hardest at the top. A hook is more reliable than a screen
match but it is not self-evident: which events fire, in what order, and which of them mean "a
person is needed" rather than "something finished" are all empirical. MulmoTerminal found that
out the expensive way — a subagent completing fires the same `Notification` event as a blocked
turn, so every finished subagent lit up a cell, beeped, and pushed, mid-turn, once per subagent.
The fix was to read the payload's `notification_type` and exclude the informational ones, and the
comment recording it is explicit that this was measured rather than assumed.

### Observed on claude 2.1.221, and it moved the layer

The rule above survives; the level it applies at does not, and this is exactly why plan 004 says
observe rather than assume.

Eleven payloads were captured by driving a real claude — a `-p` run, and an interactive session
put through a permission prompt, an Explore subagent and ninety seconds idle. They are committed
verbatim at `src/fixtures/claude-hooks.jsonl` and the tests read that file rather than
hand-written JSON.

**This version emits no informational `Notification` subtype at all.** Only two
`notification_type` values appeared, `permission_prompt` and `idle_prompt`, and both mean a person
is needed. MulmoTerminal's expensive finding — a finished subagent lighting a cell mid-turn —
arrives here as its own **event**, `SubagentStop`, carrying `agent_type` while the parent turn
continues.

So the denylist ships **empty** rather than populated with a string nobody has observed, and the
subagent case is denied at the event layer where this version actually puts it. The mechanism that
would hold such a subtype is still there and still tested through an injectable set, so the day
one is captured it is a one-line edit. Writing a plausible-looking subtype name in now would be
the guess this section exists to forbid, and it would look identical to knowledge.

**Consequence for the build:** a mechanism can only be written for an installed agent. Today that
is `claude` alone. Every other profile ships without one and gains it the day that CLI is present
and can be driven — a config edit plus a fixture plus, for `log`, a small parser. Not a change to
the session model.

This is a sequencing constraint, not a design preference. The architecture privileges no agent;
the data just is not there yet for the ones that are not present.

## Two agents in one working tree

Running an implementer and a reviewer in the same directory at once means two processes editing
the same files, producing conflicts neither understands, discovered later. MulmoTerminal forbids
it outright ("one working tree runs one agent"), but enforcing that needs git worktree management,
which the README lists as a non-goal.

**Decision, as first written: warn, do not block.** `POST /api/sessions` returned a `warning`
naming the other live session in that `cwd`. A read-only reviewer alongside a writer is legitimate,
and the tool cannot tell which case it is looking at — refusing would be guessing, silence would be
negligent.

**Revised 2026-08-09, by Soya, after using it: the neighbour warning is removed.** The sentence
above was written about two *agents*. In practice the neighbour is almost always the `shell`
profile — the operator's own terminal in the repository they are working in — which is one process
editing files, not two, and is exactly the case the last paragraph of this section already
exempted. A warning that fires mostly on the legitimate case teaches the person to dismiss it, and
a warning that is dismissed by habit is worse than none: it is still there when it matters and is
no longer read. What remains is `GET /api/cwds`, which reports the live sessions per directory, so
the collision is visible in the picker **at the moment of choosing** — which is when it can still
change the decision — rather than in the response to a session that has already started.

`POST /api/sessions` now sets `warning` in one case only: the same agent asked for twice in one
`cwd`, where the caller is handed the session already running instead of a new one. That warning
is not advice, it is the response saying it did not do what was asked.

**The agent is still in the session id** (plan 002), and for the same reason. Keyed on the path
alone, the second create would land on the same tmux session name, `new-session -A` would attach
to the agent already running there, and the caller would get back a session claiming to be an
agent it is not. Removing the warning does not make a wrong `agent` field acceptable.

Two sessions of the **same** agent in one tree still collide, deliberately. That is the case this
section's argument justifies least — a reviewer and an implementer are different agents, while two
identical ones in one tree is more often a forgotten tab — and handing back the session already
running is the better failure.

Note this applies only to two **sessions** sharing a tree. An agent calling a sub-model is one
process editing files, not two, and needs no warning.
