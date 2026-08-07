# Audit

One section per iteration, appended by the `iterate` skill's final whole-codebase pass.

That pass runs **after** the last fix round, so its findings have had no chance to be fixed
inside the iteration. This file is therefore a ledger of what is open or deliberately accepted,
not a record of what was resolved. Findings closed during the iteration are noted with the commit
that closed them; anything else is still live.

---

## m0/toolchain - 2026-08-04

TypeScript, eslint, prettier and `node:test` on Node 22's type stripping, plus the suite that
proves the toolchain runs. No runtime dependencies added - the six-dependency budget is untouched,
and the test runner is the one Node ships rather than a seventh entry.

### Findings

- [medium] `docker-compose.yml` - **agentdeck is bind-mounted into its own container, so the files
  the host executes are agent-writable.** Failure: an agent rewrites `eslint.config.mjs`,
  a `package.json` script or the `Dockerfile`; the next host-side `pnpm lint` or
  `docker compose up --build` runs agent-authored code on the Mac with the human's identity -
  the identity plan 005's credential split exists to keep away from the agent.
  Status: documented and controlled by review discipline in `f685b44`; structurally reduced in
  `0e9d8a7`. Residual: review discipline is the control for the four tracked files, which is
  weaker than a boundary. Accepted, recorded in plan 005.

- [high] `node_modules/` **and** `.pnpm-store` **are gitignored, so the `git status` control above
  cannot see them.** Failure: an agent rewrites `node_modules/.bin/eslint` - a `/bin/sh` shim -
  and `git status` reports clean. The human takes the sanctioned host exception and executes it.
  Verified reachable: uid 1000 in the container can write both paths.
  Status: fixed in `0e9d8a7`. Both are now container-local volumes layered over the bind mount,
  so the tree the container executes is not the host's. Habit cannot cover a file review cannot
  see, so this half is structural rather than documented.

- [high] **The user's bearer token was to be written at the repository root, inside a bind mount
  every session can read.** Failure: an agent working in agentdeck meets it in an ordinary
  `ls -la` and it lands in a transcript on its way to a model API. In hostile hands it is
  `POST /api/sessions` in any mounted repo, `DELETE` on live sessions, and a WebSocket attach that
  reads and types into every other agent's terminal. Plan 002 draws exactly this line: a session
  secret can lie about one session, the user's token can start processes.
  Status: fixed in `0e9d8a7`. Moved to `AGENTDECK_TOKEN_FILE=/var/lib/agentdeck/token` on a
  container-local volume, outside every bind mount. Residual: same uid means this hides the token
  rather than isolating it. The only thing that isolates it is a distinct uid for agent sessions,
  which plan 005 now names and which is **not taken**.

- [medium] **The documented safe in-container toolchain path did not run.** Failure: `pnpm` was
  absent from the image, so `docker compose exec -T app pnpm lint` failed outright and every lint
  and test run fell back to the host exception - the one path the containment argument exists to
  avoid. The test passed because it grepped the README prose instead of running the command.
  Status: fixed in `0e9d8a7`. `corepack prepare pnpm@9.15.9` is in the image and the documented
  command carries `-w /workspace/agentdeck`. Verified by hand: `pnpm --version` returns 9.15.9 in
  the container and typecheck, lint and test all pass there.

- [high] **`pnpm-lock.yaml` is agent-writable and was installed on the host by the only documented
  install command.** Found by the final whole-codebase pass, and only visible there: it exists
  because this branch's new lockfile met `mise.toml`, which was already on `main`. Failure: an
  agent edits a `resolution: {tarball: ...}` entry or adds a devDependency with a postinstall;
  the human runs the documented `mise install && pnpm install` on the Mac; pnpm 9.15.9 - unlike
  pnpm 10 - does not gate dependency lifecycle scripts, so it executes with the human's full
  identity including `~/.ssh`. A thousand-line lockfile diff is exactly the diff nobody reads.
  The container-local `node_modules` volume protects the installed tree, not the input.
  Status: fixed on this branch. `mise.toml` now documents the in-container install;
  `pnpm-lock.yaml` is on the review list in the README, plan 005 and
  `src/containment.test.ts`'s `hostExecutedFiles`.

### Open after this iteration

Nothing blocking. One standing residual, carried forward rather than closed:

- **Same-uid.** The server and every agent session run as uid 1000, so file mode buys nothing
  between them. The token move hides it from a working-tree read; it does not isolate it. A
  distinct uid for agent sessions is recorded in plan 005 as the only real fix and has not been
  taken. Revisit when M1 writes the token for real.

---

## m0/ci - 2026-08-04

GitHub Actions running typecheck, lint and test on the runner directly, with corepack pinning
pnpm 9.15.9 to match the container. Does not build the arm64 image - nothing in CI would run it.

Every finding this iteration is the same root cause seen from a new angle: **agentdeck is
bind-mounted into the container that runs agents**, so anything in the tree that the _host_ later
executes is agent-writable. Iteration 1 found `node_modules` and `pnpm-lock.yaml`. This one found
five more surfaces.

### Findings

- [high] `.git/config` and `.git/hooks/` **are agent-writable and untracked, so the prescribed
  `git status` / `git diff` review cannot see them - and `git diff` is itself the trigger.**
  Failure: an agent writes `[core] pager = sh -c '... | sh'` into `.git/config`; the human runs
  the mandated pre-build `git diff` and git executes it on the Mac. Or it writes
  `.git/hooks/pre-commit`, and the next commit this very pipeline makes fires it with `~/.ssh` in
  reach. Needs no `--build` and no host `pnpm` at all.
  Status: fixed in `0823b6e`. Both are on the review list in README, plan 005 and
  `hostExecutedFiles`; the review checklist gained `git config --local --list` and
  `ls -la .git/hooks`, which are the only two commands that can see them; and host git in the
  skill runs `-c core.pager=cat -c core.hooksPath=/dev/null`.

- [medium] `.github/workflows/` **was created by this branch and left off the review list, and a
  workflow declares its own `permissions`.** Failure: an agent adds `permissions: contents: write`
  plus a `run:` step; the human reviews exactly what the README lists, does not look at it, and
  pushes. Status: fixed in `0823b6e`, added to all three lists.

- [medium] **Enumerating filenames is the wrong shape where the host tool auto-discovers config.**
  Prettier imports every entry of its `plugins` array from any `.prettierrc*`; mise reads
  `.mise.toml`, `mise.local.toml` and `mise-tasks/`. The list named `eslint.config.mjs` and
  `mise.toml` only. Status: fixed in `0823b6e` - the list now names surfaces (`eslint.config.*`,
  `.prettierrc*`, `.mise*.toml`, `mise-tasks/`) and states that the enumerated set is a floor,
  not the whole review.

- [medium] **No `no-new-privileges` or `cap_drop`; the container kept 8 setuid-root binaries.**
  Status: fixed in `653068f`.

- [high, audit] **The skill claimed "every host git command is hardened" while only four were.**
  Every stage prompt ends with "Commit.", and those commits are host git run by a subagent, which
  no per-command flag in the skill reaches. The containment test asserted `uses.length >= 4` - a
  floor that certifies partial coverage as complete, which is the same failure mode as the
  four-file list it was written to police.
  Status: fixed on this branch. The instruction moved into the shared prompt every stage receives,
  which is the only layer that reaches a subagent's own commits, and the test now asserts that
  rather than counting call sites.

### Open after this iteration

- **The root cause is untouched.** Two iterations have now spent most of a high-effort security
  budget rediscovering variants of one decision. Plan 005 names both real fixes - a distinct uid
  for agent sessions, or not mounting agentdeck into itself - and neither is taken. Every
  remaining item pays this tax until one of them is.
- **Same-uid**, carried forward from `m0/toolchain`. Unchanged.
- **The verify pass echoed its input** instead of re-reading the code: it reported three findings
  as open that `fix:2` had already closed, confirmed by hand. The prompt needs to require quoting
  the current line it judged, not just a verdict.

### Process failure found while merging m0/ci

A fix agent created its own branch (`security/host-execution-surface-and-caps`) and committed
every security fix there instead of on `m0/ci`. The iteration then merged `m0/ci`, which held only
the coder and QA commits, printed MERGED, and passed its suite - because the suite had been run
before the branch switch. Both security rounds' work was absent from `main` while every signal
said the iteration had succeeded. Recovered by merging the stray branch; no work was lost.

Two controls added to the skill: the shared prompt now forbids stages from creating or switching
branches, and the after-workflow steps require checking `git branch --show-current` and the recent
branch list before merging, and re-running the suite on the branch actually being merged.

## m0/de-containerise - 2026-08-07

The container is gone; agentdeck runs on the Mac. This iteration made the documents say so. Plan
005 keeps its reasoning under a superseded header, plans 001/003/004/006, the README, `mise.toml`,
the `cwd` refusal and the port-clash message stopped describing an image, `scripts/healthcheck.mjs`
gained its `/api/health` half, and the in-image toolchain test was removed rather than left to
self-skip. `Dockerfile`, `docker-compose.yml` and `docker/` are retained on disk, unreferenced,
because how this is eventually deployed is deliberately open.

Security gate: two rounds, 6 then 4 findings, 4 and 2 actionable, all fixed; the verify pass
reported 0 still open. The findings below are the final whole-codebase audit, which by
construction has no fix round after it. **This branch is NOT merged.** Five of them are `high`,
two are verified by hand, and three of the five ask for decisions the item put out of scope.

### Findings

- [high] src/tmux.ts:114 - The tmux server inherits the launching shell's whole environment, so
  plan 004's `env` name allowlist is decorative. `ensureServer()` runs `tmux start-server` as a
  child of the node process, so the server's global environment is whatever shell ran `pnpm start`;
  `-e` on `createOrAttach` adds to that rather than replacing it. Failure: every agent session gets
  `SSH_AUTH_SOCK`, and an agent with the forwarded ssh-agent can `git push --force` to every repo
  that key reaches - which is exactly the credential split plan 005 exists to enforce, and the
  README still points at that plan for it.
  **Verified by hand on this Mac**, and worse than reported: a pane spawned by that server saw
  both `SSH_AUTH_SOCK` and an arbitrary `SEKRIT` variable from the launching shell that no profile
  allowlisted. Status: FIXED in m0/host-boundary. Every tmux invocation, and so the server it
  starts, is given an environment built from `BASE_ENV_NAMES` in `src/tmux.ts`; `update-environment`
  is emptied so no attaching client can inject either. Re-verified by hand: with `SEKRIT_MARKER` in
  the launching shell, a pane started through `POST /api/sessions` has neither it nor
  `SSH_AUTH_SOCK`, and a real-tmux test in `src/tmux.test.ts` now runs that check.

- [high] src/hub.ts:55 - The cwd allowlist is now called the only boundary left, and does not bound
  the session set at all. `Hub.sync()` attaches to everything on the tmux socket by design, and the
  socket is `/tmp/tmux-<uid>/agentdeck`, reachable by every process running as the user. Failure:
  `tmux -L agentdeck new-session -d -c / -- /bin/sh` becomes a tab within one 2s sync, streamed to
  the phone and accepting input, with `CwdAllowlist.allows` never consulted. Status: FIXED in
  m0/host-boundary, the user having decided the allowlist IS a boundary. `Registry.list` filters to
  allowlisted cwds - one filter, so the session list and the hub cannot disagree - and `Hub.sync`
  attaches only to what it returns. The accepted cost (a hand-started session, and a session that
  outlives a restart, are not tabs) is written into plan 005's header, the README and
  `CwdAllowlist.refusal`.

- [high] src/tmux.ts:76 - Per-session hook secrets are one tmux command away from any same-uid
  process. `createOrAttach` passes `spawnEnv` as `-e NAME=VALUE`, and tmux stores it in the session
  environment. Failure: `tmux -L <socket> show-environment -t <session>` prints `AGENTDECK_SECRET`
  in full - no ptrace, no `/proc`. plans/002-wire-protocol.md:131 documents the leak as
  `/proc/<pid>/environ`, a Linux path macOS does not have, so the plan describes a mechanism this
  host lacks while the easier one goes unmentioned. **Verified by hand.** Status: FIXED in
  m0/host-boundary. `createOrAttach` unsets every `-e` variable from the session environment in the
  same chained invocation that forks the pane, so the agent keeps its secret and
  `show-environment -t` prints nothing; verified by hand and by a real-tmux test. Plan 002's
  paragraph now names what this host has - the tmux read, now closed, and same-uid debugger and
  file access, which are not.
  Reopened and closed again the same day: that fix left the same values in the tmux client's argv,
  which `ps` shows to every same-uid process even on a macOS that hides the environment - verified
  here with `ps -Ao args=`, so an agent polling `ps` could read the next session's secret and the
  operator's `ANTHROPIC_API_KEY` out of a `new-session` client that lives for milliseconds. No
  value is an argument now: they travel in the creating client's own environment and a momentary
  `update-environment` name list, set immediately before `new-session` and emptied immediately
  after in the same invocation, is what copies them into the session the pane is forked from.

- [high] README.md:195 - The documented replacement for the container-local `node_modules` volume
  cannot see what it claims to, and a test certifies it. `git status --ignored -- node_modules
.pnpm-store` emits one line naming the directory, never its contents, so a rewritten
  `node_modules/.bin/eslint` produces byte-identical output. src/containment.test.ts:121 asserts
  the string is present in the README, turning an ineffective control into a green check. Status:
  FIXED in m0/host-boundary. Nothing that reads the tree can do this job, so the control is
  replacing it: `rm -rf node_modules .pnpm-store && pnpm install --frozen-lockfile` from the
  lockfile reviewed in the same diff. The test is inverted - it now demonstrates the old command's
  blindness against a scratch repository and fails if the README prescribes it again.

- [high] plans/005-containment.md:130 - Host paths outside the repo became execution surfaces and
  the review checklist is still repo-scoped. `~/.gitconfig` (`--local` explicitly does not show it,
  and an `!alias` fires on the very `git diff` the checklist prescribes), `~/.claude/settings.json`
  and `~/.claude/skills/`, `~/Library/LaunchAgents/`. Plan 005 still recommends keeping the iterate
  skill in `~/.claude/skills` "so the agent it constrains cannot write it" - true only because of
  the container, and the superseded header does not retract it. Status: FIXED in m0/host-boundary.
  The header names all four host paths with the commands that can see them (`git config --global
--list`, `ls -la ~/.claude/skills ~/Library/LaunchAgents`, a diff of `~/.claude/settings.json`)
  and explicitly retracts the `~/.claude/skills` recommendation: on the Mac that directory is as
  writable to the agent as the repository, and moving the skill there moves it out of review.

- [medium] src/de-containerise.test.ts:52 - plan 002 is excluded from the swept document list with
  the comment "002 never described one". It describes one six times, in the load-bearing places:
  `Session.cwd` ("absolute path inside the container"), the allowlist definition, the refusal
  rationale, the hook route. Plan 002 is the wire contract. Status: FIXED in m0/host-boundary.
  Plan 002 is on the `decontainerised` list and no longer describes one.

- [medium] src/server.ts:94 - The token file's default is `/var/lib/agentdeck/token`, which no
  ordinary Mac user can create, so `pnpm start` fails on a clean host. **Confirmed by hand: the
  server refuses to start.** The one rule plan 005 says survives - never inside a tree a session is
  pointed at - is prose in three places and checked by no code. Status: FIXED in m0/host-boundary,
  the user having decided the home. The default is `~/.agentdeck/token`, created 0600 on first run,
  and `tokenInsideAllowlist` refuses to start when the path resolves at or inside an allowlist
  entry. Both verified by hand on a clean `~/.agentdeck`.

- [medium] src/server.ts:101 - `agentStateDir` falls back to `CLAUDE_CONFIG_DIR`, which in the
  container was a dedicated bind mount and on the Mac is the operator's live config. Failure:
  agentdeck merges its hook fragment into the settings file every Claude Code session on the
  machine reads, including sessions outside the allowlist, and rewrites it on every boot. The boot
  warning only fires when neither variable is set, so the silent-landing case is the unwarned one.
  Status: FIXED in m0/host-boundary. The fallback is `~/.agentdeck/agent-state`, a directory that is
  agentdeck's to write, and the warning now fires whenever `AGENTDECK_AGENT_STATE_DIR` itself is
  unset - which is the silent-landing case.

- [medium] plans/005-containment.md:8 - The superseded header enumerates filesystem reach but not
  `cpus`/`mem_limit`, `no-new-privileges`/`cap_drop`/non-root, or the container lifecycle as a
  persistence bound. A runaway agent now takes the laptop, which is an availability failure plan
  006's watchdog assumes cannot happen; and `~/Library/LaunchAgents` persistence is a category the
  container previously bounded. Status: ACCEPTED WITH A REASON in m0/host-boundary, which is what
  the user decided: all three are named in plan 005's header as unbounded. CPU and memory are
  carried by `m4/launchd-watchdog`, because the honest fix is a supervisor that can notice and act
  rather than a limit invented on this branch; the privilege drops have nothing left to drop, since
  the session already runs as the human; persistence via `~/Library/LaunchAgents` is unbounded and
  on the review list. **No CPU or memory limit was built, deliberately.**

- [low] .github/workflows/ci.yml:6 - Header still says CI is "the one place `pnpm install` runs
  outside the container", now false. Survived the sweep because it says `container` and the sweep
  greps `docker`. Status: FIXED in m0/host-boundary. The header now says the runner's install is
  the SAFE one and the Mac's is a review gate.

- [low] src/claude-hooks.ts:211 - src/ still describes a container in four places, and
  de-containerise.test.ts:151, named "nothing that runs describes a container", asserts only
  `/docker/i`. Status: FIXED in m0/host-boundary. The scan asserts `/\bcontainers?\b/i` over src/
  and scripts/ as well, and the four docstrings are rewritten. Test files are exempt from that half
  only - `containment.test.ts` has to name what the container used to cover in order to assert that
  nothing still credits it.

- [low] src/server.ts:126 - `AGENTDECK_ORIGIN` appears in no README section and no example env
  file, only a `console.error` on a process nothing supervises. Unset, `/api` and `/ws` accept any
  Origin, which is the state of every ordinary run. Status: FIXED in m0/host-boundary. The README
  has an Environment section listing every variable the server reads, what each default is, and
  what an unset one means - `AGENTDECK_ORIGIN`'s row says the Origin check is off.

### Found while verifying, not by the gate

The suite was RED on arrival at the merge step: 2 of 335 failing. `de-containerise.test.ts` scans
every tracked `*.test.ts` for skip/todo markers and `.dockerenv`, and scanned itself - its own
search regexes contain those literals. The QA and refactor stages both returned `ok: true`; the
commits that added the tripping prose (448623a, 7611b75) landed after the stage that ran green.
Fixed here by excluding the scanner from its own scan. The lesson is the skill's existing one: a
stage's `ok: true` is a claim about when it ran, not about the branch.

### Closed by m0/host-boundary

Every finding above is marked FIXED or ACCEPTED WITH A REASON. Three of them were the user's
decisions rather than the auditor's, taken on 2026-08-07 and recorded in plan 005's superseded
header: the token's home is `~/.agentdeck/token` with a start-time refusal; the cwd allowlist is a
boundary and bounds the session set; and the container's resource and persistence reach is named as
unbounded rather than rebuilt, with the resource half carried by `m4/launchd-watchdog`.

What is still open, unchanged and carried forward: **same-uid**. The server and every session run
as the human, so one agent can attach a debugger to another and read every file that user owns.
Placement, the environment allowlist and the tmux fix take away the easy reads; none of them is a
boundary. A distinct uid for agent sessions remains the only real fix and remains untaken.

## m0/host-boundary - review of the fixes above - 2026-08-07

Two findings against the branch that closed the section above. Both are about the same thing: a
claim that was true of the mechanism it was written for and not of the residue beside it.

- [medium] src/tmux.ts:148 - The values taken out of the tmux SESSION environment were still in the
  tmux CLIENT's argv, and macOS shows every process's argv to every process this user runs even
  though it hides the environment - verified here with `ps -Ao args=`, which printed a sibling's
  full command line. Failure: an agent sampling `ps` in a loop catches the `new-session` client
  created for the next session and reads its `AGENTDECK_SECRET` and the operator's
  `ANTHROPIC_API_KEY`, which is the one credential plan 004 keeps out of every file. Status: FIXED
  in m0/host-boundary. No value is passed as an argument. They travel in the creating client's own
  environment, and an `update-environment` name list set immediately before `new-session` and
  emptied immediately after - in the same invocation, so the next client cannot be caught by it -
  is what copies them into the session the pane is forked from. Covered by a test that scans every
  argument of every call for a value, and by the existing real-tmux test for the pane's half.

- [medium] README.md:142 - "Built, not inherited" bounds what a pane INHERITS and not what its own
  shell puts back. `HOME` must be on `BASE_ENV_NAMES`, and the shipped `agents.example.json` ran
  `/bin/zsh -l` - a login shell, which sources `/etc/zprofile`, `~/.zprofile`, `~/.zshrc` and
  `~/.zlogin`. Failure: the `export SSH_AUTH_SOCK=...` that 1Password and `ssh-agent` both document
  puts the forwarded agent back in every session, which is exactly the `git push --force`
  capability the README says is gone; Claude Code is the same shape, since it execs a snapshot of
  those rc files. Status: FIXED as far as it can be. The example profile no longer passes `-l`, and
  the README and plan 005 now say that keeping a credential out of a session means keeping it out
  of the dotfiles `HOME` points at. A real-tmux test spawns a login shell against a temporary
  `ZDOTDIR` and asserts the variable does come back, so the documented residue is checked rather
  than asserted. Not closed, because it cannot be: a profile that starts a login shell, or an agent
  that reads rc files itself, re-establishes whatever those files export. The only real fix is the
  one already open - a distinct uid, with its own home.

---

## m0/host-boundary - final whole-codebase pass - 2026-08-07

The item that took the twelve findings of `m0/de-containerise` and the two decisions it deferred.
All twelve are marked FIXED or ACCEPTED WITH A REASON in the section above. The token now defaults
to `~/.agentdeck/token` created 0600, and the server refuses to start if that path resolves inside
an allowlist entry; the `cwd` allowlist became a boundary rather than a check on
`POST /api/sessions`. Both were the user's call, taken on 2026-08-07.

The audit below runs after the last fix round and so has no fix round of its own. Two of its
findings were nevertheless fixed on this branch before the merge - the `high`, because the branch
must not ship a claim it does not keep, and one `medium`, because the branch introduced it. The
rest are recorded and open.

### Findings

- [high] src/tmux.ts:262 - "A session's environment is built, not inherited" failed open, silently,
  on any tmux server agentdeck did not start, and the comment saying it could not be fixed was
  wrong. `start-server` is a no-op against a socket that already holds a live server, so only the
  CLIENT half of the environment was ours; the pane inherits the server's global environment, which
  is whatever shell started it. The trigger is prescribed by our own text: `CwdAllowlist.refusal()`
  and the README both tell the operator to `tmux -L agentdeck attach` to reach an orphaned session,
  and attaching starts a server. `exit-empty off` then keeps it alive indefinitely. Failure:
  every session created afterwards gets the forwarded ssh-agent, which plan 005 prices as
  `git push --force` to every repository that key reaches. **Verified by hand on tmux 3.7b, and
  worse than the branch assumed: emptying `update-environment` makes it worse rather than better,
  because tmux's own default list names `SSH_AUTH_SOCK` and was overwriting it from our clean
  client by accident.** With the list emptied and a dirty pre-existing server, a pane created
  exactly as `createOrAttach` builds it saw both a marker variable and the agent socket.
  Status: FIXED in 6500400. `ensureServer` sweeps every global not on `BASE_ENV_NAMES` with
  `set-environment -g -u` and logs what it cleared; `PWD` is skipped because tmux sets it on a
  server we started ourselves. Covered by a real-tmux test that fails without the fix.

- [medium] src/registry.ts:166 - `reap()` became unreachable at boot, so a dead session left by a
  previous run stayed on the socket forever and the next create reported it as live. Second-order
  effect of gating `list()` on the allowlist and on `#meta`, which is memory only: after a restart
  `list()` cannot see a session this process created before, and `reap()` filters through `list()`.
  `remain-on-exit on` keeps the corpse. Failure: `sessionId(cwd, agent)` is pure, so the next
  `POST /api/sessions` for that repo hits it, tmux reports `attached`, and the phone gets a 201
  carrying "a claude session was already running in <cwd>; you are attached to it rather than to a
  new one" - false - plus a tab pinned at `exited` with no agent started, which the user must close
  before the agent will start. Status: FIXED in b7cdbca. `create()` kills a dead session under its
  own id first, scoped to a cwd already allowlisted and a pane tmux reports dead. Reaping against
  the unfiltered list was the other option and was not taken: it would widen what this process
  kills to sessions it never started.

- [medium] src/server.ts:71 - The bearer token moved to a user-writable, guessable path and
  `loadToken` adopts whatever it finds there. `readFileSync` returns any non-empty content as the
  token, with no ownership, mode or symlink check; the 0600 is applied only on the write path.
  Failure: an agent session - which plan 005 treats as capable of running a poisoned `curl | sh` -
  knows the exact path and can pre-create `~/.agentdeck/token` with a value it chose, or symlink it
  somewhere, and the next boot adopts it. Status: OPEN. Same-uid is the standing residual this
  whole file keeps returning to, and the honest fix is the distinct uid recorded in plan 005, not a
  mode check that the same uid can undo. Revisit with M1.

- [medium] src/server.ts:41 - The token's default sits in the PARENT of the directory agents are
  pointed at (`~/.agentdeck/token` beside `~/.agentdeck/agent-state`), and nothing checks that
  relationship. Status: OPEN. The refusal covers allowlist entries, which is the case the rule was
  written for; this is a second one it does not name.

- [medium] src/server.ts:57 - `tokenInsideAllowlist` is symlink-blind and fails open. Failure: an
  allowlist entry reachable by a symlinked path defeats the containment check that is the item's
  own done-when. Status: OPEN.

- [medium] src/server.ts:236 - The agent-state directory receives a hooks file, the same class of
  execution surface the profiles file was just guarded for, and gets no containment check at all.
  Status: OPEN.

- [low] src/tmux.ts:180 - The momentary global `update-environment` is a server-wide window, and
  its cleanup on the failure path is best-effort. Status: OPEN, and narrower than what it replaced.

- [low] src/registry.ts:128 - The session boundary is (remembered name + tmux-reported path) and
  both halves are computable by any process running as this user. Stated as such in the code.
  Status: ACCEPTED. It is a filter on where a session is, not a claim that agentdeck started it.

- [low] src/http.ts:211 - The 500 handler logs the whole error object, which for a `capture-pane`
  failure carries scrollback - the one thing this design says is never written down. Status: OPEN.

- [low] src/server.ts:105 - `probeTmux` is the one tmux invocation that bypasses `Tmux` and its
  built environment. Status: OPEN; it starts no session.

- [low] src/registry.ts:45 - `#meta` retains per-session hook secrets for sessions that left the
  socket by any route other than `close()`. Status: OPEN.

- [low] src/tmux.ts:368 - `Tmux.refresh` and `Tmux.resize` have no non-test callers and were
  carried through the target hardening. Status: OPEN; M2 is their caller.

- [low] README.md:133 - Recorded, not introduced: `AGENTDECK_ORIGIN` is unset by default, so the
  Origin check is off and `/api/health` answers unauthenticated to the tailnet behind
  `tailscale serve`. This branch is the one that finally wrote it into the README and a boot
  warning. Status: ACCEPTED for now. The boot warning goes to stderr on a process with no decided
  log destination, so on a launchd run nobody sees it - `m4/launchd-watchdog` is where that lands.

### Open after this iteration

- **Same-uid**, again and unchanged. Three of the mediums above (`src/server.ts:71`, `:41`, `:57`)
  are the same fact wearing different hats: the token is a file, and every agent runs as the user
  who owns it. Plan 005 records a distinct uid for agent sessions as the only real fix. Not taken.
- **The allowlist is a filter on where a session is**, not proof agentdeck started it. A same-uid
  process still owns the socket.

---

## m0/supervisor-crash-test - final whole-codebase pass - 2026-08-07

The crash test, not a supervisor: `src/supervisor-crash.test.ts` kills the node process and asserts
that tmux sessions created beforehand are alive with the same ids afterwards, and that nothing
restarted the server. Plan 003 carries the same sentence. The item's own "known gap" prose was
stale and was corrected rather than certified: since `m0/host-boundary` gated `Registry.list()` on
`#meta` as well as the allowlist, a session that outlives the server is not listed AT ALL, rather
than listed under its raw id.

Two of the audit's findings were regressions this branch introduced with the `curl` -> `node -e`
change and are fixed here. The rest are recorded and open.

### Findings

- [medium] src/claude-hooks.ts:134 - Widening `HOOK_MARKER` to the generic `/api/hooks/` turned
  `isOurHook` into a substring test that matches strangers. `mergeHookSettings` promises to
  preserve hooks it did not write and `installHookSettings` re-runs at every boot, so an operator's
  own guard hook posting to any local service with `/api/hooks/` in its path would be deleted
  silently, with no log line. A deleted deny/guard hook is a security downgrade performed by the
  component whose contract is not to touch other people's entries. Status: FIXED on this branch.
  `isOurHook` now requires both `/api/hooks/` and `AGENTDECK_SESSION_ID`, which every form we have
  emitted contains, so the upgrade path is kept. Covered by a test that fails without it.

- [medium] src/claude-hooks.ts:167 - `curl -m 2` was a cap on the whole operation; the node form
  lost it. `http.request` is only constructed inside the stdin `end` handler, so `timeout: 2000` -
  itself only a socket-inactivity timer - cannot start until stdin closes, and nothing bounds the
  stdin read or the `b += c` buffer. A hook whose stdin is inherited and never closed leaves a Node
  runtime resident for the life of the session, accumulating the payload in heap. Status: FIXED on
  this branch: an unref'd 2s `setTimeout(...process.exit(0))` as the first statement, and the
  buffer stops appending past 64KB, which is the body size the server refuses anyway.

- [medium] src/server.ts:131 - `AGENTDECK_AGENT_STATE_DIR` gets none of the allowlist-containment
  guard applied to the token and profiles files, though `installHookSettings` writes a file there
  whose `command` strings the agent runs through a shell on every tool call, and `mergeHookSettings`
  deliberately preserves entries it does not recognise. Point it at a repository on
  `AGENTDECK_MOUNTS` and an agent's ordinary write of one hooks entry becomes host execution on its
  next tool call and every later session, surviving reboots, with no review gate covering the file.
  Status: OPEN. Three lines to fix and it makes the rule the code already states apply to the third
  file of three; not taken here because it is `m0/host-boundary`'s rule and belongs with its
  siblings, and this branch is a measurement.

- [medium] src/server.ts:142 - The documented way to make the hook fire swaps the operator's whole
  Claude config. `CLAUDE_CONFIG_DIR` replaces the directory, not just the hooks fragment, so
  `permissions.deny`, allowed-tools and the operator's own hooks stop applying to every agentdeck
  session - on a machine the README already describes as having no boundary between an agent and
  the home directory. The obvious workaround, pointing `AGENTDECK_AGENT_STATE_DIR` at `~/.claude`,
  is what hands the merge above the live settings file. Neither consequence is stated anywhere.
  Status: OPEN, and it is a documentation debt with a security shape.

- [medium] src/claude-hooks.ts:171 - The hook client authenticates to nobody: it posts to
  127.0.0.1 on a fixed port with no check on what is listening. This branch is the one that
  establishes the window - nothing restarts the server, so the port is free for as long as the
  crash lasts - and any same-uid process that takes it harvests prompts, tool inputs and the
  per-session secret. Status: OPEN. The honest fix is the same-uid one this file keeps returning
  to; a shared secret in the other direction would narrow it.

### Open after this iteration

- **`POST /api/sessions` answers 500 on a real server run** and leaves the session it created
  orphaned on the socket. Found by hand during verification of this branch, reproduced on `main`,
  so it arrived with `m0/host-boundary`. Filed as `m0/create-500` with the reproduction and what is
  known: `Registry.list()` receives the entire unsplit `list-sessions` line as the entry id, so
  `#meta` misses. Not root-caused. **This blocks M1 in practice** - the endpoint M1 is built on
  does not work outside the fake-tmux tests.
- **Same-uid**, unchanged.

---

## m0/create-500 - final whole-codebase pass - 2026-08-08

**Root cause, and it was not any of the four the item guessed at.** A tmux CLIENT whose locale does
not say UTF-8 is not a UTF-8 client to tmux, and tmux sanitises the output of commands it prints to
one: every byte it considers non-printable is replaced with `_`. `list()` separates its fields with
U+001F, so under `env -i` - no LANG, no LC*\* , which is exactly what launchd gives it -
`list-sessions -F` came back as `name_0\_\_1786113059*/path`, `line.split(SEP)`yielded ONE field,
and every session parsed with the whole line as its id. Measured on tmux 3.7b with`od -c`: no
locale gives `f o o \_ 0`, `LC_CTYPE=UTF-8`gives`f o o 037 0`. That is why the same call worked
from a shell, which had LANG, and failed from the server. `baseEnv`now defaults`LC_CTYPE`when
the effective locale - POSIX precedence, LC_ALL then LC_CTYPE then LANG - is not UTF-8, and drops a
non-UTF-8`LC_ALL`rather than be overridden by it.`capture-pane -p` was checked the same way and
is not affected.

Verified by hand after the fix, with the exact reproduction from the item: `POST /api/sessions`
returns **201**, `GET /api/sessions` lists it, and the log is clean.

Both of the audit's `high`s are fixed on this branch, and one `medium`, because it was a regression
this branch introduced.

### Findings

- [high] src/server.ts:254 - Whichever tmux client starts a server donates its whole environment to
  that server's GLOBAL environment, and the create chain runs with `AGENTDECK_SECRET` and every
  profile API key in its environment by design. The per-session unsets at the end of that chain
  clear the SESSION environment and do nothing about the global one. `ensureServer` ran once at
  boot, which sufficed only while the tmux server could not outlive the node process - and a server
  that dies with its last session and is restarted by a create gets no `exit-empty off` and no
  sweep. **Verified by hand on tmux 3.7b: emit that exact chain against a socket with no server and
  `show-environment -g` prints the secret and the API key while the session environment is clean; a
  pane forked afterwards sees both.** Status: FIXED in 7e5eded. `createOrAttach` calls
  `ensureServer` first, which passes no `extra`, so the server is always started by a client holding
  nothing but `baseEnv()`. Covered by a real-tmux test that fails without the fix.

- [high] src/ws.ts:100 - The third fire-and-forget site, left behind when the two `hub.sync()` calls
  were hardened. `handleMessage` reaches `capture-pane` through the snapshot an attach builds, and
  `Tmux` rethrows anything that is not a missing session or an empty server, so one failing capture
  was an unhandled rejection - which exits Node, on a process nothing restarts. `execFile`'s 1MB
  default made it reachable on purpose: 2000 lines of `capture-pane -e` is agent-sized output, so a
  session that wants to can kill the server for every attached phone. Status: FIXED in 7e5eded.
  Caught and reported to the client; `maxBuffer` sized for the capture. The test asserts the socket
  survives and the client is told. Honest note on evidence: removing the fix hangs the test runner
  rather than producing a clean red, which is consistent with the rejection killing the process but
  is not a failing assertion.

- [medium] src/registry.ts:148 - `#undoCreate` killed on a warrant computed before the create.
  `attached === false` comes from a `has()` that ran BEFORE `new-session -A`, and the session name
  is computable offline by anything running as this user, so a session put under that name inside
  the window was killed by a request that did not create it. The half needing no attacker: a
  transient failure of the post-create `list()` killed the agent just started, where before this
  branch it survived and a retry adopted it. Status: FIXED in d766db3. The kill is conditional on
  tmux still reporting the session at the cwd this call passed, started no earlier than this call,
  confirmed with `display-message` rather than the `list()` that just failed. Cannot confirm means
  do not act.

- [medium] src/tmux.ts:424 - A newline in `#{session_path}` truncates the parsed path. Status:
  OPEN. It fails closed - a truncated path does not match an allowlist entry, so the session is
  dropped rather than admitted - but the failure mode is a session that silently never appears.

- [low] src/server.ts:105 - `/api/health` reports 200 for exactly the failure this branch added a
  throw for, because `probeTmux` does not use `baseEnv` and so has its own locale. Status: OPEN,
  and it means the health check cannot see the class of bug this item was about.

- [low] src/registry.ts:149 - `#undoCreate` forgets the session even when the kill fails, leaving a
  running agent the API can neither list nor stop. Status: OPEN, and now more likely by design,
  since the narrowed undo deliberately declines to kill what it cannot confirm.

- [low] src/tmux.ts:51 - `BASE_ENV_NAMES` is two lists in one: adding `LC_CTYPE` for the
  environment we build also exempted it from the inherited-globals sweep. Status: OPEN.

- [low] src/tmux.ts:169 - A profile's `env` name list overrides the locale hardening for the create
  invocation. Status: OPEN.

- [low] src/hub.ts:189 - Swallowed sync errors make the frozen-PTY case silent and permanent.
  Status: OPEN, and it is the cost of not exiting the process on a tmux failure.

### Open after this iteration

- **`/api/health` cannot see this class of failure** (`probeTmux` bypasses `baseEnv`). The one
  probe `m4/launchd-watchdog` will restart on is blind to the bug that broke every create.
- **Same-uid**, unchanged.
