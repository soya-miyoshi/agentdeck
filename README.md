# agentdeck

Run coding-agent sessions on the Mac, drive them from a phone.

One tab per repo. Each tab shows whether that agent is working, waiting for you, or
finished, and streams its live terminal output. No database, and nothing from the stream is ever
written down — scrollback lives in tmux for as long as tmux does. (Each agent's own state, its
transcripts and settings, live wherever that agent keeps them. That is the agent's business, not
ours.)

Status: **planning**. No code yet — see [`plans/`](plans/).

The name is a placeholder and cheap to change while the repo is empty. It deliberately
avoids "claude" in the product name (Anthropic's trademark guidance discourages that for
third-party tools).

## Why this exists rather than MulmoTerminal

MulmoTerminal already does the hard part — PTY sessions, tmux persistence, a phone client —
and we run it today. But it is 59,630 lines of TypeScript, 91 `/api/*` routes and 999 npm
packages, of which the parts these requirements need are the ~8,000-line session layer.
Everything else (collections, feeds, accounting, wiki, calendar sync, slide and diagram
rendering, an MCP broker) is code we do not use, do not maintain, and cannot review — which
is attack surface, not free functionality. Its packages also come from an upstream author we
have decided not to track.

The requirement set here is small enough to own completely. That is the point.

## Requirements

1. Multiple concurrent agent sessions, one per repository.
2. **More than one kind of agent, with none privileged.** Claude Code, Gemini, whatever comes
   next — side by side in one tab strip, any of them able to orchestrate other models from
   inside its own session. See [`plans/004-agent-profiles.md`](plans/004-agent-profiles.md).
3. Reach them from a phone, off the local network.
4. Tabbed UI: one tab per session.
5. Per-tab status: working / waiting for input / exited.
6. Per-tab live output stream.
7. No persistence requirement beyond the working day.
8. Infrastructure cost: zero.

## The shape of the answer

Requirement 6 is what decides the architecture. A live stream wants a socket, not a document
store — MulmoTerminal's phone client polls a Firestore document every 2 seconds, which costs a
read per poll and lags by up to that long. And requirement 6 means the stream never has to be
written down at all.

Tailscale already connects the phone to the Mac, so there is no relay problem left to solve.
Together that removes the entire cloud tier:

```
Phone (PWA)                        Mac (host)
┌───────────────┐          ┌────────────────────────────────────────────┐
│ tabs          │   WSS    │ tailscaled ─ tailscale serve               │
│ xterm.js      │◀────────▶│      │ loopback :port                      │
│ status dots   │  tailnet │      └─▶ agentdeck server                  │
└───────┬───────┘          │            ├ node-pty ─ tmux (own daemon)  │
        │                  │            ├ session registry              │
        │                  │            └ ring buffer (memory)          │
        │  optional: alerts while the app is closed                     │
        └──▶ Cloudflare Worker + VAPID (free tier)                      │
                           └────────────────────────────────────────────┘
                             one allowlist entry per repository worked in
```

**No database.** Scrollback lives in tmux, and a bounded in-memory ring buffer covers instant
repaint on reconnect. Redis, D1 and Firestore were all considered and are all unnecessary — see
[`plans/001-architecture.md`](plans/001-architecture.md).

**It runs on the Mac, as you.** There is no boundary between an agent session and the machine:
an agent that runs `rm -rf ~` or a poisoned `curl | sh` reaches the home directory, the SSH keys,
the browser profiles and every other repository. This was a container once, and
[`plans/005-containment.md`](plans/005-containment.md) is kept as the best account of what that
bought and what its removal costs. The remaining lever is the `cwd` allowlist — a short list of
the repositories actually worked in — and it decides where a session *starts*, not where it can
reach. A git remote is what protects the work.

The blast radius therefore includes agentdeck's own repository, and that is the one whose contents
the host then executes: the `package.json` scripts, `pnpm-lock.yaml`
(pnpm 9 runs dependency lifecycle scripts, so a rewritten resolution entry is host execution at
the next install), any lint, format or toolchain config the host tool discovers for itself —
`eslint.config.*`, `.prettierrc*` (prettier imports every entry of its `plugins` array as
JavaScript), `.mise*.toml` and `mise-tasks/` (mise runs `[env] _.source` and `[tasks]` on the
host, and auto-discovers more filenames than the one we happen to have) —
`src/**/*.test.ts` (`pnpm test` hands them to `node --test`, which executes them, and
the suite already shells out), `.claude/`, `.github/workflows/`, `.git/config`, `.git/hooks/`
and everything under `node_modules` and `.pnpm-store` are all agent-writable, so running the
toolchain runs agent-authored code on the Mac with your identity. `.claude/` is the one with no
build step in front of it: `.claude/skills/*/SKILL.md`,
`CLAUDE.md` and `.claude/settings.json` are loaded by a Claude Code process running on the Mac, so
merely starting an agent session in this repo on the host is the trigger — and the iterate skill
is also what prescribes this review, so an agent that edits it edits its own gate. `.git/config`
and `.git/hooks/` have a weaker trigger still: `git` itself runs them, so `[core] pager`, an
`[alias]` with a `!` prefix or a `textconv` entry turns the review command into the payload, and
a `post-checkout` or `pre-push` hook fires on the ordinary branch-and-merge workflow with the
human's identity and `~/.ssh` in reach. `.github/workflows/` is executed by a GitHub runner and
declares its own `permissions:`, so reviewing the workflow before pushing is the only thing that
bounds the token it gets. `node_modules`, `.pnpm-store`, `.git/config` and `.git/hooks/` are the
ones review misses — none of them is tracked, so `git status` says
clean after an agent rewrites `node_modules/.bin/eslint` or `.git/hooks/pre-push`. All four are
covered by extra commands in the checklist below rather than by a boundary, which is weaker and is
stated as such.

The user's bearer token stays out of any directory a session is pointed at, for the same reason:
the root of a working tree — where an agent's `ls -la` or `grep -rn token .` meets it — is the one
place it must not be. It lives in `~/.agentdeck/token`, created 0600 on first run;
`AGENTDECK_TOKEN_FILE` moves it. **The server refuses to start if that path resolves inside an
allowlist entry**, which is the rule made executable rather than written down three times.

The allowlist is a boundary and not only a check on `POST /api/sessions`: agentdeck lists,
attaches to and streams the sessions whose directory is on it, and ignores everything else on the
tmux socket. That socket is `/tmp/tmux-<uid>/agentdeck` and every process running as you can write
it, so without this a `tmux -L agentdeck new-session -d -c / -- /bin/sh` typed by anything at all
becomes a tab your phone can type into.

Two consequences worth knowing, both deliberate. A session you start by hand under the agentdeck
tmux socket does **not** appear as a tab — agentdeck only knows a session's directory for the
sessions it started. And adding a newly cloned repo means adding it to the allowlist and
restarting the server: tmux keeps the processes alive across that restart, but their directory,
agent and waiting detection do not survive it — the registry holds cwd, agent and the per-session
hook secret in memory only — and since the directory is what the allowlist matches on, a surviving
session stops being listed and stops being streamed until it is recreated. The agent is still
there (`tmux -L agentdeck attach -t <id>`). Pick a moment, or recreate the sessions afterwards.
Why git push credentials stay away from the agent is in
[`plans/005-containment.md`](plans/005-containment.md).

## Environment

Every variable the server reads. All of them are optional; the row says what an unset one means.

| Variable | Default | Unset means |
| --- | --- | --- |
| `AGENTDECK_PORT` | `7777` | Loopback only either way; `tailscale serve` decides exposure. |
| `AGENTDECK_TOKEN_FILE` | `~/.agentdeck/token` | Generated 0600 on first run. Never inside an allowlist entry — the server refuses to start. |
| `AGENTDECK_MOUNTS` | empty | **No directory is startable.** Colon-separated absolute paths; exact match, never prefix. |
| `AGENTDECK_PROFILES` | none | No agents, so nothing to start. See `agents.example.json`. |
| `AGENTDECK_AGENT_STATE_DIR` | `~/.agentdeck/agent-state` | Hook settings land there, and an agent only reads them if its profile points it there. |
| `AGENTDECK_ORIGIN` | none | **The Origin check plan 001 describes is off**: `/api` and `/ws` accept any Origin, so any page the browser visits can drive the socket with a token it holds. Set it to the `https://<host>.ts.net` origin the phone loads. |
| `TMUX_SOCKET` | `agentdeck` | The `-L` name. Sessions are found on this socket and nowhere else. |

A session's own environment is **built, not inherited**: a pane gets `PATH`, `HOME`, `SHELL`,
`TERM`, `LANG`, `LC_ALL`, `TMPDIR`, `USER`, `LOGNAME`, plus whatever names that agent's profile
lists in `env`. Nothing else from the shell that ran `pnpm start` reaches it — `SSH_AUTH_SOCK`
above all, since a forwarded ssh-agent is `git push --force` to every repository that key reaches.

## Non-goals

Written down because "code we do not use" is the thing this repo exists to avoid. Each of
these is a feature MulmoTerminal has and we are deliberately not rebuilding:

- File browsing, editing, or diff viewing
- Git or GitHub integration (PR lists, issue work, worktrees)
- Content generation, slide/diagram rendering, wikis, collections, feeds
- Calendar, Drive, or any Google integration
- An MCP broker or plugin system
- Multi-user access, sharing, or any public exposure
- Persistence of terminal output beyond the tmux session's own lifetime
- A desktop UI — the desktop already has a terminal

If one of these turns out to be needed, it gets its own plan and its own argument first.

## Infrastructure

Almost none, by design. The main path touches no cloud service.

The one optional exception is push notification delivery while the app is closed, which needs
something with an internet address. If we build it, it is a single Cloudflare Worker plus KV,
declared as a stack in the `infra` repository like everything else — not configured by hand in
a dashboard.

## Toolchain

Node 22 and pnpm, pinned in `mise.toml`. pnpm because `infra` already uses it and because its
strict linking refuses phantom dependencies — a package can only import what it actually
declares, which is the property we want in a repo whose whole premise is a small, known
dependency set.

Target: **six runtime dependencies or fewer.** Currently planned — `node-pty`, `ws`, `vue`,
`@xterm/xterm`, `@xterm/addon-fit`, a QR encoder for getting the token onto the phone, and Vite as
a dev dependency. That is the budget spent; any addition needs a line in a plan saying why, and
[`plans/003-milestones.md`](plans/003-milestones.md) has the line for the sixth.

Everything runs on the Mac:

```
mise install
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

**Every one of those lines is a review gate, not a convenience.** Each executes files this
repository's own agents can write — `eslint.config.*` is evaluated as JavaScript, `.prettierrc*`
names plugin files prettier imports as JavaScript, the `package.json` scripts are handed to a
shell, `pnpm-lock.yaml` is resolved by a pnpm 9 that does not gate dependency lifecycle scripts,
`src/**/*.test.ts` is executed as code by `node --test`, and `node_modules/.bin` is prepended to
`PATH`. `scripts/` belongs in that list for a reason the lockfile caveat does not cover:
`package.json` declares `"postinstall": "node scripts/fix-node-pty-permissions.mjs"`, and pnpm
always runs the root project's own lifecycle scripts, so `pnpm install --frozen-lockfile` executes
a file in this tree whatever the lockfile says — and `scripts/healthcheck.mjs` and
`scripts/restart-survival.mjs` are run by hand besides. `mise install` is the same (`.mise*.toml` and `mise-tasks/` are agent-writable and mise
executes `[env] _.source` and `[tasks]`), and so is starting an agent session in this repo, which
loads `.claude/`. `git` in this repo is the same again, since it runs `.git/config` and
`.git/hooks/`. There used to be a container between all of that and the machine; there is not one
now, which makes the review below the only control rather than the second of two.

So before any of those commands,
`git status` and `git diff` must be clean of unreviewed agent edits to
`package.json`, `pnpm-lock.yaml`, `eslint.config.*`, `.prettierrc*`,
`.mise*.toml`, `mise-tasks/`, `src/**/*.test.ts`, `scripts/`, `.claude/` and
`.github/workflows/`. **That
list is a floor, not the whole job**: the host tools discover their own config, so the exception
requires reading every added or modified file in the diff, not only the named ones. The same
review is owed before starting an agent session in this repo,
which is the only trigger `.claude/` needs. That review is
blind to
`node_modules` and `.pnpm-store`, which are gitignored, and blind to `.git/config` and
`.git/hooks/` for the same reason, so three more commands belong in the same checklist:

```
rm -rf node_modules .pnpm-store && pnpm install --frozen-lockfile
git config --local --list
ls -la .git/hooks          # anything without a .sample suffix is a live hook
```

The first of those used to be `git status --ignored` over the two paths, which **cannot
see what it was there for**: `git status` collapses an ignored directory to a single line naming
the directory, so a rewritten `node_modules/.bin/eslint` produces byte-identical output.
`--ignored=matching` does list the files, but it lists all fifty thousand of them, which is not a
review either. Nothing that reads the tree can do this job, so the control is replacing the tree
instead of inspecting it: reinstall from the lockfile, having reviewed `pnpm-lock.yaml` itself in
the diff above, since pnpm 9 does not gate dependency lifecycle scripts.

Run the review itself with git's own execution turned off — `git -c core.pager=cat -c
core.hooksPath=/dev/null status`, and the same for `diff`, `switch` and `merge` — so the command
that inspects the repository is not the command that fires the payload. An entry added to the
allowlist — `${HOME}`, or the root of a tree holding credentials — is a session started somewhere
nobody chose.
