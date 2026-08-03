# 005 — Running in a container

agentdeck runs in a container on the Mac (OrbStack, arm64). Repositories are bind-mounted in, so
an agent that misbehaves damages the container rather than the machine.

This is a good decision. It is also a partial one, and the parts it does not cover are worth
knowing before relying on it.

## What containment actually buys

**Protected:** everything outside the mounts. The home directory, SSH keys, browser profiles,
other repositories, keychain, system files, every other tool's config. An agent that runs
`rm -rf ~` or a poisoned `curl | sh` hits a container filesystem that can be rebuilt.

**Not protected: the mounted repositories — all of them, from any session.** They are writable by
definition; that is the point of mounting them. An agent can delete, rewrite, or quietly corrupt
the source it was given.

And it is not limited to the source it was given. **There is one container, and every session runs
inside it as the same user**, so an agent started in repo A can read and write repo B by path. Its
`cwd` is where it was pointed, not a boundary it is held inside. The same follows for everything
else in that filesystem: sibling agents' processes, `/proc/<pid>/environ` and therefore their hook
secrets and API keys (plan 002 says the same thing from the protocol's side), and the agent-state
volume with every session's transcripts in it.

**And the user's bearer token, unless it is deliberately placed.** The server runs as the same uid
as every session, so file mode buys nothing between them; what is left is not putting it where an
agent meets it by accident. At the root of agentdeck's own working tree it is in reach of an
ordinary `ls -la` or `grep -rn token .`, and that ends with the token in a transcript on its way to
a model API — and in the wrong hands it is POST /api/sessions in any mounted repo, DELETE on live
sessions, and a WebSocket attach that reads and types into every other agent's terminal. Plan 002
draws exactly this line: a session secret can lie about one session, the user's token can start
processes. **Decision: it lives at `AGENTDECK_TOKEN_FILE` (`/var/lib/agentdeck/token`) on a
container-local volume, outside every bind mount, and never at the root of a mounted repository.**
That hides it; it does not isolate it, because same-uid remains same-uid. The only thing that
isolates it is the distinct uid for agent sessions named below, which is still not taken.

So the honest claim is: **the blast radius is the union of the mount list**, and the container
boundary is around the *machine*, not around the work and not around a session. "If something
worrying happens it is just within the container" is true for the Mac and false for every
repository currently mounted.

**And one entry on that mount list is agentdeck itself**, which is the repository whose files the
*host* runs. `eslint.config.*` is loaded and evaluated as JavaScript by `eslint .`, and
`.prettierrc*` is the same hole one tool over — prettier 3 imports every entry of its `plugins`
array as JavaScript relative to the config file, so `"plugins": ["./scripts/fmt.mjs"]` is host
execution at the next `pnpm lint`; the
`package.json` scripts are strings handed to a shell; `Dockerfile` and `docker-compose.yml` are
executed by `docker compose up --build`. **So is `pnpm-lock.yaml`**, which is the least obvious of
them: pnpm 9 does not gate dependency lifecycle scripts the way pnpm 10 does, so a rewritten
`resolution: {tarball: ...}` entry or an added devDependency with a postinstall is host execution
at the next install — and a thousand-line lockfile diff is exactly the diff nobody reads. That is
why the documented install runs in the container (`mise.toml`) rather than on the Mac. So is everything under `node_modules` — `pnpm lint` runs
`node_modules/.bin/eslint`, a shell shim — and the `.pnpm-store` it is installed from. All of them
are writable by any session in the container, so
running the host toolchain, or rebuilding after an unreviewed agent edit, executes agent-authored
code on the Mac with the human's full identity — the identity the credential split below exists to
keep away from the agent. A mount line added to compose (`/var/run/docker.sock`, or `${HOME}`) is
the cheapest version of it: the next routine `docker compose up -d --build` is then root on the
host, which makes "never mount the Docker socket" a rule living in a file the agent it constrains
can edit.

**Several more host-execution surfaces are in the same mount and are easier to miss, because none
of them looks like a build file.** `src/**/*.test.ts` is what `pnpm test` hands to `node --test`,
which executes it as code — the suite already shells out (`execFileSync("/bin/sh", ...)`) and
already prepends `node_modules/.bin` to `PATH`, so one more shell-out added to an existing helper
is unremarkable in a diff nobody expects to contain an attack. `.mise*.toml` documents `mise install`
and mise executes `[env] _.source` and `[tasks]` entries on the host — note the glob, because mise
auto-discovers `mise.toml`, `.mise.toml`, `mise.local.toml`, `.config/mise/config.toml` and file
tasks under `mise-tasks/` or `.mise/tasks/`, so enumerating the one filename we happen to have
leaves the others unreviewed. `.github/workflows/` is executed by a GitHub runner rather than by
the Mac, and it is the one surface that **chooses its own privileges**: `permissions:` is declared
inside the very file being protected, so an agent that adds `contents: write` and a `run:` step has
a code-execution primitive on the runner, gated only by the `git push` this plan reserves for the
human — which makes reviewing the workflow the only thing bounding the token, and makes the
repository-level default workflow permission (set to read-only in GitHub settings) the only control
a file edit cannot widen. `.git/config` and `.git/hooks/` are executed by `git` itself: `[core]
pager`, an `[alias]` beginning `!`, or a `[diff] textconv` entry runs on the host the moment the
human types the prescribed `git diff`, which makes the review command its own trigger, and a
`post-checkout`, `pre-commit`, `post-merge` or `pre-push` hook fires on the branch, commit and
merge steps the iterate skill prescribes, with `~/.ssh` and the human's GitHub identity in reach —
exactly what the credential split below exists to keep away from the agent. And `.claude/` is not agent
data at all: it is instruction and configuration a Claude Code process running *on the Mac* loads
— `.claude/skills/*/SKILL.md`, `CLAUDE.md`, `.claude/settings.json` and its hooks. That last one
has the weakest trigger of anything on this list: it needs no `--build` and no host `pnpm` run,
only a human starting an agent session in this repo on the Mac. It is also the file that
prescribes this very review, so an agent that edits it can edit the gate that would catch it.

That path is closed by habit rather than by the boundary: develop and test inside the container,
never with the host toolchain (the README's Toolchain section states this as the workflow), and
require `git status` and `git diff` to be clean of unreviewed edits to `Dockerfile`,
`docker-compose.yml`, `package.json`, `pnpm-lock.yaml`, `eslint.config.*`, `.prettierrc*`,
`.mise*.toml`, `mise-tasks/`,
`src/**/*.test.ts`, `.claude/` and `.github/workflows/` before any `--build`, and before any host
toolchain run or agent
session taken as the exception. **That enumeration is a floor rather than the job**: every one of
these tools discovers its own config, so the exception requires reading every added or modified
file in the diff, and the list only says which ones may not be skimmed. Run the review itself as
`git -c core.pager=cat -c core.hooksPath=/dev/null …`, and the same for the `switch` and `merge`
steps, so git's own agent-writable execution surfaces are inert while the review that would catch
them runs. The better answer for the last of these is the one that moved the
bearer token out of the mount: keep the iterate skill in the host's `~/.claude/skills` so the
agent it constrains cannot write it. Until that is done, review is the only control.

**That review is blind to `node_modules` and `.pnpm-store`**, because both are gitignored: an agent
that rewrites `node_modules/.bin/eslint` leaves `git status` clean and the next host lint run
executes it. Habit cannot cover a file review cannot see, so this half is structural instead —
**`/workspace/agentdeck/node_modules` and `/workspace/agentdeck/.pnpm-store` are container-local
volumes layered over the bind mount**, so the tree the container executes is not the host's and an
agent editing it cannot reach the host toolchain at all. **It is blind to `.git/config` and
`.git/hooks/` for the same reason** — neither is tracked, so `git status` and `git diff` report
clean after an agent writes a pager alias or a `pre-push` hook — and those cannot be volumed away,
because the container needs the repository's git metadata. Two commands see them and belong in the
same checklist: `git config --local --list`, and `ls -la .git/hooks` (a live hook is anything
without a `.sample` suffix). The Performance section below wants the
same thing for an unrelated reason, which is why it is cheap. For the same reason **the container
needs pnpm in the image** (`corepack prepare pnpm@9.15.9 --activate`): a documented in-container
command that does not run makes the host exception the only path there is.

A stronger
boundary is a separate decision and would be recorded here: a distinct uid for agent sessions, or
not mounting agentdeck into itself.

Two things reduce the residual risk, and both are cheap:

- **Keep the mount list short.** One entry per repository actually worked in, never a parent
  directory containing all of them. This does not isolate a session from its siblings — nothing in
  this design does — but it is the only lever on the size of the union, and the difference between
  eight entries and `~/ghq` is the difference between the repos you are working on this month and
  every repo you have ever cloned. That list is also the `cwd` allowlist from plan 002 and the
  thing `GET /api/cwds` serves to the picker, so it is one list with three jobs.
- **Push often, or at least commit often.** A git remote is the real backup here; the container
  is not one. Anything uncommitted is inside the blast radius.

Mounting read-only is not an option — the agent's job is to edit code.

Per-session isolation would mean a container per session, which is the option rejected below for
reasons that still hold. It is written down twice on purpose: this is the property people assume
"containerised, one repository per session" already gives them.

## Credentials: the part that decides how much containment is left

Containment is only as good as what you hand to the container. Two secrets matter, and they have
different answers.

**Agent API credentials** must go in — the agent cannot work without them. Pass them as
environment variables from the host (plan 004 already specifies profiles list env NAMES, never
values). Scope them to the agent, and prefer a key you can rotate independently of anything else.

**Git push credentials should NOT go in.** This is the decision that preserves most of the value.
Mounting `~/.ssh` gives the agent your identity everywhere GitHub accepts that key — every repo,
every org, force-push included. That single mount undoes most of what the container was for.

Recommended split: **the agent commits, the human pushes.** Commits are local, reversible and
reviewable; pushing is the irreversible outward-facing step, and it happens from the host after
you have looked. If pushing from inside becomes genuinely necessary, use a per-repo deploy key
with write access to that repository only — never the personal key.

**Never mount the Docker socket.** `/var/run/docker.sock` in a container is root on the host in
one command. It shows up in convenience examples constantly and it makes the entire container
boundary decorative.

## What changes in the design

### tmux persistence weakens, and PID 1 decides how much

Plan 001 chose tmux so sessions survive the server process restarting. Inside a container that
still holds — but only because of a decision that has to be made deliberately, and whose default
is wrong.

**The Node server must not be PID 1.** With the obvious Dockerfile it is, and then the property
above is false in the case it exists for: the server crashes, PID 1 has exited, the container
stops, `restart: unless-stopped` recreates it, and tmux goes with it. Every session is lost to
the one event tmux was taken on to survive. Worse, it tests fine — `docker restart`, a redeploy,
a manual `kill` of a child process all behave as documented. Only a real crash reveals it, at the
moment it costs the most.

So PID 1 is a small init that starts the tmux server, then supervises the Node process and
restarts it in place when it dies. Two consequences worth stating: the init must reap zombies
(agents spawn plenty), and it must not restart Node so eagerly that a boot-time crash becomes a
loop — the same reluctance plan 006 asks of the watchdog, for the same reason.

A **container** restart still kills tmux and every session with it. The property is "survives a
crash or a redeploy of the app code", not "survives everything". Recreating the container is a
destructive act on running work.

Accepted rather than solved: the alternative is running tmux on the host and reaching in, which
punches a hole straight through the containment this plan exists for. State it in the README so a
`docker compose down` is never a surprise.

### The mount list is fixed at container creation, and that is the daily cost

"Keep the mount list short" and "the `cwd` allowlist is the mount list" are both right, and
together they have a consequence neither of them states: **bind mounts are declared when the
container is created.** Starting a session in a repository that was not mounted means editing
compose and recreating the container — which, by the section above, kills every session currently
running. The cheapest routine action in the product costs the most expensive one.

This is not a corner case. It is what happens the first time a new repo is cloned, which is
often, and it is exactly the situation where the phone is least able to help: there is no way to
add a mount from the phone at all.

Three ways out, and the third is tempting for the wrong reason:

- **Pre-declare the working set, and treat adding one as a scheduled restart.** The mount list is
  a short list of repos actually worked in; adding to it is a compose edit at a moment of your
  choosing, when nothing is mid-turn. Boring, honest, and cheap.
- **Mount the parent tree, keep the allowlist logical.** One mount, no restarts, and the union
  above grows from the repositories you work in to every repository you have. Since the union is
  already the honest blast radius, this is a difference of degree rather than of kind — which is
  precisely why it is tempting, and why the degree is worth defending.
- **One container per session.** This is the only option that makes the blast radius one
  repository, and it makes a restart destroy one session instead of all of them. It also requires
  the thing that creates sessions to be able to create containers, which means the Docker socket,
  which this plan refuses absolutely. It could be done with a host-side launcher that the server
  asks rather than a socket it holds — a real design, and a bigger one than anything else here.

**Decision: the first.** Pre-declared mount list, restarts scheduled by a human. The third is
written down because it is where this goes if the restart cost becomes intolerable, and because
rediscovering it as "we could just mount the Docker socket" is the failure mode.

### Where Tailscale runs

Two options, and the simpler one is right.

- **Host tailscaled, container publishes a port.** `tailscale serve` on the Mac proxies to the
  container's published port. The container needs no Tailscale, no tailnet identity, no
  `--privileged`, no `/dev/net/tun`.
- Tailscale inside the container: its own tailnet node, more isolation, materially more moving
  parts.

Take the first. Bind the published port to `127.0.0.1` only, so the container is reachable from
the host loopback and from nothing else; `tailscale serve` is then the single place where remote
exposure is decided, exactly as plan 001 intended.

### Container hygiene

- **Non-root user.** Whether its uid must *match* the host user is Linux-host advice: OrbStack maps
  ownership across VirtioFS itself, so files may come out correct regardless. Verify at M0 with one
  `touch` in a mounted repo rather than inheriting the folklore — but keep the non-root part, which
  is not folklore.
- **CPU and memory limits.** A runaway agent should degrade the container, not the laptop.
- **`no-new-privileges` and `cap_drop: [ALL]`.** Non-root above is worth exactly as much as the
  distance between the agent's uid and root, and the default is short: the base image ships
  setuid-root `su`, `mount`, `umount`, `chsh`, `chfn`, `gpasswd`, `newgrp` and `passwd`, and
  compose's default capability set keeps `CAP_DAC_OVERRIDE`, `CAP_SETUID`, `CAP_CHOWN`,
  `CAP_FOWNER` and `CAP_MKNOD`. An agent that reaches uid 0 that way reads and rewrites every
  bind-mounted repository regardless of file mode and writes root-owned files back through
  VirtioFS into the human's checkouts. It also pre-defeats the distinct uid for agent sessions
  named above, since a setuid path to root makes any uid split decorative. Nothing in this image
  needs a capability — tmux, node, git and curl all run unprivileged as `node` — so both are free.
- **The container's tmux is not the host's, and the plans cite the host's.** Debian bookworm
  ships **3.3a**; the host runs 3.7b, which is the version plans 001 and 002 name when they say
  "verified". The behaviours those plans depend on all predate 3.3a — `remain-on-exit`,
  `exit-empty`, `capture-pane -p -e -S`, `refresh-client -R`, `#{pane_dead_status}` — so nothing
  is known to be wrong. But a claim verified against 3.7b has not been verified against what
  actually runs, and the two defaults plan 002 pins down (`remain-on-exit off`,
  `window-size latest`) are exactly the kind of thing that moved between releases before. Re-check
  them inside the container at M1, or pin a newer tmux in the image and stop having two versions.
- **`exit-empty off` is required, not a preference.** The tmux server exits when it holds no
  sessions, so `start-server` at boot succeeds and the server is gone before anything can use it.
  It presents as a health check reporting "no server running" moments after the entrypoint logged
  that the server was up.
- **`node-pty` is the one native dependency, and its install is `node scripts/prebuild.js ||
  node-gyp rebuild`** (verified on 1.1.0). The `||` is the whole point: the day a prebuild is
  missing for the pinned base — a Node minor, an ABI bump, an arm64 gap — the image silently falls
  through to compiling, and fails only if the toolchain is absent. So build in a multi-stage image
  with `python3`, `make` and `g++` present in the builder and absent from the runtime. Pin the base
  image. This is an M0 decision; discovered at M3 it is a rebuild of the Dockerfile at the point
  where everything already depends on it.
- **No host `~/.claude` mount — but a dedicated host directory is fine, and is what we use.**
  The rule exists because `~/.claude` holds every project's transcripts, history and settings,
  which is far more than one containerised agent should see. A separate directory —
  `~/.claude-docker`, pointed at by `CLAUDE_CONFIG_DIR` — contains only what the container itself
  wrote, so the reason survives intact while the letter ("give it its own volume") does not.

  It is a **bind mount rather than a named volume**, and the difference is worth stating because
  an earlier draft of this plan said volume. `docker compose down` and image rebuilds are both
  routine here, and a named volume makes the stored login a casualty of either; a host directory
  keeps it, and stays readable when the question is "what did this thing actually write". The
  cost is that the credential sits in a plain file on the host rather than inside Docker's
  storage — which is where the host's own `~/.claude/.credentials.json` already sits, so it is
  not a new exposure.

  Consequence for [plan 004](004-agent-profiles.md): the agent-state store is now a directory a
  human also opens. The settings fragment merged in at container start must stay idempotent
  *and* must not clobber keys it did not write.
- **Do not mount the whole `~/ghq` tree** for the same reason: one session should see one
  repository.

### Performance

Bind mounts on macOS are the classic slow path. OrbStack's VirtioFS is substantially better than
the old Docker Desktop default, but heavy file I/O — a full `grep`, an install, a build — will
still be slower than native. Agents do a lot of that.

Two mitigations if it bites: keep `node_modules` and build output in container-local volumes
rather than on the bind mount, and mount one repository rather than a tree.

## Milestone placement

This is not a phase of its own. M0 ships the Dockerfile and compose file, and every later
milestone is developed and tested inside the container — retrofitting containment after the fact
means discovering the uid, mount and native-build problems at the end, all at once.

The credential split above (agent commits, human pushes) is a decision to make at M1, when
session creation and the mount list are first written.
