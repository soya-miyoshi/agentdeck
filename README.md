# agentdeck

Run coding-agent sessions on the Mac, drive them from a phone.

One tab per repo. Each tab shows whether that agent is working, waiting for you, or
finished, and streams its live terminal output. No database, and nothing from the stream is ever
written down — scrollback lives in tmux for as long as tmux does. (Each agent's own state, its
transcripts and settings, persists in a container volume. That is the agent's business, not ours.)

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
Phone (PWA)                 Mac (host)              Container
┌───────────────┐          ┌──────────────┐        ┌──────────────────────────┐
│ tabs          │   WSS    │ tailscaled   │  :port │ agentdeck server         │
│ xterm.js      │◀────────▶│ tailscale    │◀──────▶│  ├ node-pty ─ tmux       │
│ status dots   │  tailnet │  serve       │  loop- │  ├ session registry      │
└───────┬───────┘          └──────────────┘  back  │  └ ring buffer (memory)  │
        │                                          │        ▲                 │
        │  optional: alerts while the app is closed │        │ bind mount      │
        └──▶ Cloudflare Worker + VAPID (free tier)  └────────┼─────────────────┘
                                                    one mount per repository worked in
```

**No database.** Scrollback lives in tmux, and a bounded in-memory ring buffer covers instant
repaint on reconnect. Redis, D1 and Firestore were all considered and are all unnecessary — see
[`plans/001-architecture.md`](plans/001-architecture.md).

**Containerised**, so an agent that misbehaves damages a container rather than the Mac. The honest
limit: there is one container and the mounted repositories are writable by definition, so the blast
radius is **every mounted repository, from any session** — a session's `cwd` is where its agent was
pointed, not a wall it is held inside. The container protects the machine, not the work and not one
session from another; a git remote is what protects the work, and a short mount list is the only
lever on how much is in reach.

And agentdeck's own repository is on that mount list, which is the one entry whose contents the
host executes: `Dockerfile`, `docker-compose.yml`, the `package.json` scripts and
`eslint.config.mjs` are all agent-writable, so running the host toolchain or
`docker compose up --build` runs agent-authored code on the Mac, outside the container.

Two consequences worth knowing before relying on it: `docker compose down` kills every running
session, and adding a newly cloned repo means editing the mount list, which costs the same restart.
Both, along with why git push credentials stay outside the container, are in
[`plans/005-containment.md`](plans/005-containment.md).

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

**Run it in the container, never on the host.** `docker compose exec -T app pnpm lint`,
`... pnpm test`, `... pnpm typecheck`, with the repo at `/workspace/agentdeck`. `pnpm lint` or
`pnpm test` on the Mac is an explicit exception, not the default, because both execute files this
repository's own mount makes agent-writable — `eslint.config.mjs` is evaluated as JavaScript and
the `package.json` scripts are handed to a shell.

Before any `docker compose up --build`, and before any host toolchain run taken as that exception,
`git status` and `git diff` must be clean of unreviewed agent edits to `Dockerfile`,
`docker-compose.yml`, `package.json` and `eslint.config.mjs`. A line added to the mount list —
`/var/run/docker.sock`, or `${HOME}` — turns the next routine rebuild into root on the host.
