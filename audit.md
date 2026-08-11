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

---

## m2/snapshot - final whole-codebase pass - 2026-08-08

`data` is now a `refresh-client -R` repaint rather than the ring buffer's contents, so a first
attach to a long-idle session paints the live screen instead of whatever output happened to be in
the buffer. Demonstrated by hand against a real session idle since before the attach, and with
`#{alternate_on}` at 1 the `history` key is absent from the frame.

Three of the audit's findings were introduced by this branch and are fixed here. The audit's own
question - what this change makes reachable in combination with code it did not touch - is what
found them, and two are only dangerous because of properties this branch added.

### Findings

- [medium] src/ws.ts:152 - The attach handler raced its own snapshot. The forwarding listener was
  registered before the snapshot was built, and the repaint's bytes come back through that same
  stream, so chunks reached a client that had no position yet. That client answers a chunk with
  `resync`, and for any session past the buffer's capacity `covers()` is false, so the server ran a
  SECOND full snapshot - another capture-pane, another refresh-client, another collection window -
  on every cold attach, the most common path in the product. With a persistently failing repaint it
  is worse: the position never becomes defined, so every chunk the agent emits produces another
  resync and another failing snapshot. **Verified by hand against the real server: three chunk
  frames arrived ahead of the snapshot; after the fix, none do.** Status: FIXED in b24a8e4. The
  listener queues until the snapshot is away, then flushes only what the snapshot does not already
  reflect.

- [medium] src/tmux.ts:557 - `repaint` resolves the session to EVERY attached client tty and awaits
  one `refresh-client` per tty, sequentially, while `Hub.repaint` started its 1000ms cap before
  those spawns. The agent in a pane owns a shell on the same uid as `/tmp/tmux-<uid>/agentdeck`, so
  it can attach as many clients as it likes; every snapshot then blew the cap before a byte was
  collected and threw, and the tab showed NOTHING - permanently, for that session, for every phone,
  while the session list and the state field still looked correct. Status: PARTLY FIXED in b24a8e4.
  The cap now starts after the tmux calls, so it measures collection rather than spawn, and an
  empty collection degrades to the buffer's contents - a stale screen rather than no screen - with
  a log line. **The root of it is still OPEN:** repaint should refresh only the client this server
  owns, whose tty is knowable, rather than every client tmux lists. Refreshing foreign clients buys
  nothing and is what makes the amplification possible.

- [medium] src/hub.ts:158 - The cold-snapshot path became a 4x fork amplifier with no bound on
  concurrent repaints: every ws frame is handled fire-and-forget with no rate limit, no per-client
  in-flight cap and no per-session serialisation, and `resync` reaches the snapshot path without
  the client being attached. One repeating client held thousands of listeners and hundreds of MB
  and forked tmux as fast as the event loop allowed, on a process nothing restarts. Status: PARTLY
  FIXED in b24a8e4 - repaints for one session share one in-flight promise, which removes the
  multiplication per session. **OPEN:** there is still no per-socket rate limit, and `input` and
  `resize` have the same fire-and-forget shape.

- [low] src/hub.ts:134 - `isAlternateScreen` reaches tmux without the `#ptys` gate its sibling
  `repaint` has, so it answers about a session this server holds no pty for. It leaks only a
  boolean. Status: OPEN.

### Open after this iteration

- **The repaint targets every client, not ours.** Named above; it is the cause the partial fixes
  work around rather than remove.
- **No rate limit on the ws message path.** `m2/reconnect` is the item that will make clients
  retry automatically, so the bound wants to exist before that lands rather than after.
- **Same-uid**, unchanged.

---

## m2/resync-ping - final whole-codebase pass - 2026-08-08

The ping is now tested against a genuinely half-open connection: `src/half-open.test.ts` puts a TCP
proxy between the ws client and the server and stops forwarding in both directions without closing
either side, which is the failure the ping exists for and the one a close, a destroy or an error
cannot model. The test says in its own comment what the proxy does NOT model - a real radio drop
also stops the server's writes from being acknowledged, and here the proxy accepts them - so the
limit of the evidence is on the record beside it. The comparative half of the done-when is in the
assertion rather than in prose: the ping notices before a status that stopped changing could.

The audit's `high` was introduced by this branch and is fixed here. Two mediums are open, and one
of them breaks an ordinary user action.

### Findings

- [high] src/ws.ts:279 - A coalesced snapshot build cached rejections as well as successes, so one
  client's failure became every joining client's failure - and the attach path treats a failed
  snapshot as a reason to detach. The victim is left detached server-side with its socket still
  OPEN and `status` still reading "open", and the shipped client sends `attach` only on pane mount
  and on reconnect, so an `error` frame just appends a banner: that tab shows a stale screen for
  the life of the process while the strip keeps reporting state from the registry. `applySize`
  after the forced detach also reflows the remaining clients' panes mid-session. Verified by the
  gate with a two-socket harness: one repaint call, two failures, `stream.clients` left empty.
  Status: FIXED in 57ad3b8. Sharing the success is the point of coalescing; a joiner that inherits
  a rejection now makes its own attempt, and the attach catch undoes only what that invocation
  registered.

- [medium] src/ws.ts:101 - **`maxPayload` at 64 KB kills the socket on an ordinary paste.** It
  applies to `input` frames, and xterm's `onData` delivers a paste as ONE event, so a pasted diff
  or stack trace is one frame. Verified by the gate: a 70 KB paste yields close 1009 with
  `sendInput` never called. The application-level error frame cannot fire, because `ws` rejects at
  the receiver before `message` - so the client sees a bare close, cannot tell it from a phone in a
  lift, runs the backoff ladder, reconnects and re-attaches every tab, each re-attach a cold
  snapshot with a real capture-pane. The paste is gone with no explanation, so the user pastes
  again. The effective limit is well below 64 KB of plaintext because `data` is JSON-stringified
  and control bytes inflate 2-6x, putting a 15-30 KB log paste over the line. Status: **OPEN, and
  it is a shipped defect rather than a hardening gap.** Not fixed here because the two ways out are
  a design choice rather than a correction: raise the socket's `maxPayload` and bound `input` at
  the application layer so an over-size frame gets an `error` naming the limit and keeps the
  socket, or chunk large pastes client-side below the cap. The second wants the client work in
  `m2/client-minimal`.

- [medium] src/ws.ts:370 - The 15s snapshot bound abandons a build it cannot cancel. `Tmux.#exec`
  passes no execFile `timeout` and a 16 MB `maxBuffer`, so with tmux wedged each eviction lets the
  next attach start a fresh child that never exits - one accumulating spawn per 15s per session, on
  a process nothing restarts. `Hub.#repaintOnce` also leaks its `onChunk` listener permanently in
  that state, because `off()` sits in a `finally` after an await that never returns, and
  `Hub.#repaints` pins the dead promise so every later build joins it. Status: OPEN. The fix named
  by the gate is the right one and is small - pass `timeout` to execFile in `Tmux.#exec`, which
  `probeTmux` already does - but it changes the failure mode of every tmux call on the branch that
  just hardened them, so it wants its own item rather than a late edit here.

### Open after this iteration

- **A paste can close the transport.** Named above. It is the first thing a person will hit that
  this file describes as known.
- **No execFile timeout on the tmux path**, so a wedged tmux accumulates children.
- **The repaint still targets every client**, carried from `m2/snapshot`.
- **Same-uid**, unchanged.

---

## m2/client-minimal - final whole-codebase pass - 2026-08-08

The client existed; the gap was evidence and a shipped defect. `src/client/end-to-end.test.ts`
drives the real client modules - `browserSocket`, `Connection`, `stream-position` - against a
spawned `src/server.ts`, the real tmux binary, a real pty and a real `/bin/sh` over a real
WebSocket, and names the two pieces it cannot cover without a DOM. The README carries the manual
recipe beside it.

The paste defect carried over from `m2/resync-ping` is fixed by chunking client-side: the client
never sends a frame the receiver would refuse, so an ordinary paste no longer closes the transport.

Six of the audit's findings were introduced by this branch. Five are fixed here; the sixth is a
property of a path this branch made reachable rather than of code it wrote.

### Findings

- [medium] src/client/connection.ts:236 - `input()` stopped going through `#send` and lost the rule
  `#send` documents: input typed while disconnected is DROPPED. The queue survived from the socket
  close to the next open - a token check with no timeout plus a backoff delay, unbounded on a
  backgrounded tab where timers are throttled - and was then written to the pty at once. A "y"
  answering a question no longer on screen; two fragments of a command line concatenated into one
  nobody typed. README.md tells the user to exercise exactly this path. Status: FIXED. Holding
  across the CONNECTING window is what `#canSend` was written for and still happens; holding across
  a reconnect does not, and the user is told what was dropped. Test fails without the fix.

- [medium] src/client/connection.ts:313 - `#releasedGroups` only emptied when the queue fully
  drained, and the producer is not the keyboard: xterm emits `onData` for the replies it owes to
  escape sequences the AGENT wrote, which is the case `MAX_PENDING_INPUT_BYTES` exists for. A loop
  on `printf '\e[6n'` added ~300k ids a second that were never removed, so the byte bound held at
  8 MiB while the Set ate the tab - the outcome the bound was added to prevent, reached by the same
  input. Status: FIXED. It is a set of session ids now, which is all the warning ever read, and the
  per-call group bookkeeping is gone rather than left written-but-unread.

- [medium] src/client/connection.ts:280 - `#overflowed` was cleared only on close, so it was once
  per SOCKET rather than the once per overflow its message claims. A queue that overflowed, drained
  and overflowed again dropped input in silence, and what is dropped is the tail of what is in
  flight while everything queued after it is still sent - so the pty receives a hole and then
  resumes. Status: FIXED, cleared when the queue drains. Test fails without the fix.

- [medium] README.md:179 - The documented dev flow stored the bearer token in `localStorage` under
  Vite's default `http://localhost:5173`, an origin shared with every other Vite project on the
  machine - and that token starts sessions in every allowed repository, kills live ones and
  attaches to every other agent's terminal. Status: FIXED. The dev server is pinned to 7778 with
  `strictPort`, and the README says why.

- [medium] README.md:173 - The documented dev flow cannot work with `AGENTDECK_ORIGIN` set. The
  proxy leaves the browser's `Origin` intact, so a server configured with the tailnet origin
  answers 403 to the upgrade and to every `/api` call; `verifyToken` treats anything that is not a
  401 as a good token, so the client reads it as a network failure and reconnects forever. Status:
  FIXED in the README. **The client half is OPEN:** `api.ts` should raise 403 as its own condition
  rather than folding it into "token still good".

- [medium] src/pty.ts:74 - An ordinary supported paste now sustains ~2.4 MB/s into a write path
  with no backpressure at any layer. Status: OPEN. This is not code this branch wrote - it is the
  path chunking made reachable at that rate, because before it the socket simply closed. It wants
  measuring before it is designed for.

- [low] src/client/connection.ts:332, :71, :83 and src/client/end-to-end.test.ts:121 - a
  pathological session id makes the frame `room` negative; the window budget counts only input
  frames, so attach/resize/resync can still exceed the server's; `MAX_PENDING_INPUT_BYTES`
  undercounts retention because queued pieces are substrings that keep the whole paste alive; the
  e2e cleanup is SIGKILL plus a best-effort kill-server. All Status: OPEN.

### Open after this iteration

- **No backpressure on the pty write path**, now reachable at paste speed.
- **`api.ts` cannot see a 403**, so an origin misconfiguration is indistinguishable from a bad
  network. `m2/reconnect` owns the ladder and is the natural home for it.
- **Same-uid**, unchanged.

---

## m2/serve-client - final whole-codebase pass - 2026-08-08

The server serves the built client from `dist/client` on every path that is not an API or socket
route, unauthenticated by necessity. Containment is verified by resolving and then checking against
the real root rather than by rejecting suspicious-looking strings. **Verified by hand against a
live server:** encoded traversal (`..%2f`, `%2e%2e%2f`) is 403; unencoded traversal falls through
to the SPA history fallback and serves index.html rather than any file; a symlink planted inside
`dist/client` pointing at a canary outside is 403, and so is one pointing at the bearer token; and
`/api/*` keeps answering JSON rather than becoming the HTML page.

### Findings

- [medium] src/server.ts:184 - Serving `dist/client` created a second dangerous location, and one
  the allowlist rule cannot describe: everything under it goes out with no bearer token, so a
  credential placed there is downloadable at a URL equal to its filename by any device with HTTP
  reach and no shell. `tokenInsideAllowlist` cannot catch it - if this repo is not itself on
  `AGENTDECK_MOUNTS` the check says nothing and the boot proceeds. The repo is also in its own blast
  radius, so an agent session started here can write a file into the published directory and have it
  served; confirmed by hand, a planted file returns 200 with its contents. Status: FIXED in cdf260c
  for the credential half - the server refuses to start if the token file or the profiles file
  resolves inside the published directory, with the same shape as the allowlist refusal. **The
  agent-writes-into-dist half is OPEN and is a property of publishing a directory at all:** an agent
  with write access to the checkout can publish arbitrary bytes to anyone who can reach the port.

- [low] src/static.ts:195 - The unbuilt-client 503 named the absolute build path on the wire, so an
  unauthenticated caller learned the account name, the checkout layout and the forge owner, in the
  state the server is most likely to be probed in. Status: FIXED. The wire answer still says
  `pnpm build`; where it writes goes to the log.

- [low] src/static.ts:56 - The API routing table now lives in two files and they disagree on case
  and encoding: `/API/health` and `/%61pi/health` return the SPA rather than the API, on a
  case-insensitive filesystem. Nothing today is served that should not be, but any future route
  outside `/api` is silently shadowed by the history fallback - an authenticated 401 becoming an
  unauthenticated 200 text/html. The `/ws` entry is also a claim nothing enforces: `ws.ts` never
  reads `req.url` and will complete an upgrade on any path. Status: OPEN.

- [low] src/client/vite.config.ts:17 - The CSP and `X-Frame-Options` this branch adds are set only
  by the production handler, so the documented dev flow - which runs against real sessions - has
  neither. Status: OPEN.

### Open after this iteration

- **A directory is published, so whatever is in it is published.** The credential case is refused
  at boot now; the general case is inherent and stated rather than solved.
- **Two routing tables**, which is a bypass shape waiting for a route outside `/api`.
- **`ws.ts` upgrades on any path.**
- **Same-uid**, unchanged.

---

## m2/client-visible-heartbeat - final whole-codebase pass - 2026-08-08

Plan 002 asked for something unimplementable: a client that reconnects after two ping intervals of
silence, where the ping is a WebSocket ping frame that JavaScript cannot observe. The plan now
carries `{ t: "ping", intervalMs }` in its frame table, sent on the same timer as the WebSocket
ping to every open socket whether or not that socket's agent is doing anything - which is what
separates "the server is alive and the agent is quiet" from "nothing is arriving". The naive
alternative, a blind silence timer, would make every idle tab reconnect in a loop.

### Findings

- [medium] src/client/backoff.ts:18 - Silence deadlines are re-armed by a heartbeat off ONE server
  timer, so every client's deadline sits within a tick of every other, and the ladder had no
  jitter. A server stall past two intervals - a `capture-pane` over deep scrollback, a burst of
  `resync`, several concurrent snapshot builds - expires all of them at once and every client walks
  the ladder in lockstep, re-attaching every open tab together. On a busy session a 30-second stall
  has rolled the 256 KiB ring buffer, so each of those attaches takes the snapshot path: a
  capture-pane, an alternate-screen probe and a refresh-client per session, aimed at the loop that
  was already stalled. Per-session coalescing stops it compounding per client, so the outcome is
  oscillating recovery rather than a wedge - and nothing restarts this process, so nothing breaks
  the oscillation. Before this branch nothing on the client could produce a correlated,
  self-initiated reconnect at all. Status: FIXED in e132cf7. The delay keeps half its step and
  spreads the rest; `random` is injected so the ladder's shape is still asserted exactly.

- [low] src/client/connection.ts:118 - `MAX_HEARTBEAT_INTERVAL_MS` was 20x the production interval
  and the stated value was never reset, so it outlived the socket that stated it. One frame saying
  five minutes moved the silence bound to ten - including the window BEFORE a socket's first frame,
  which is the stuck-CONNECTING case the watchdog exists for. Status: FIXED in e132cf7: reset per
  socket, ceiling lowered to sixty seconds.

- [low] src/client/connection.ts:574 - The watchdog makes a stuck-CONNECTING socket reach
  `#onClosed`, which calls `verifyToken()` - `GET /api/sessions`, which reaches `registry.list()`
  and spawns `tmux list-sessions` - every cycle. `verifyToken` returns true for anything that is
  not a 401, so the loop never terminates and never surfaces a diagnosis. It re-presents the bearer
  token to whatever is answering, once per cycle, forever. Status: FIXED in `m2/reconnect`.
  `verifyToken` sees a 403, and it now also tells "the server answered" from "nothing answered" -
  which is what makes the stuck case sayable at all. A probe that says the server is answering and
  this token is good, while three sockets in a row have carried nothing, is neither the network nor
  the token, and the client says so once. It does NOT stop the ladder: unlike a 401 or a 403 this
  is two facts agreeing rather than an answer from the server.

### Open after this iteration

- **`verifyToken` treats everything that is not a 401 as success**, so an origin refusal and a
  captive portal both read as "token still good" and retry forever. Two audits have now landed on
  it. `m2/reconnect` owns it and is blocked on `m2/session-metadata-survives-restart`.
  Status: FIXED in `m2/reconnect`. The verdict is now one of four - `ok`, `rejected`, `forbidden`,
  `unreachable` - and plan 002 was edited before the code was.
- **Same-uid**, unchanged.

---

## m2/session-metadata-survives-restart - final whole-codebase pass - 2026-08-08

A session that outlives the server is adopted again rather than left invisible: `#{session_path}`
is the cwd, and the id is `sessionId(cwd, agent)`, so the agent is whichever configured profile
reproduces the id from that path. Nothing is written down - no database, no sidecar - and the hook
secret is deliberately NOT recovered, because it cannot be: the running agent still holds the old
one, and a re-minted secret would never reach it. `waitingDetectionLost: true` says so on the wire.

**Verified by hand against a real server and real tmux:** created a session, `kill -9`, restarted -
`GET /api/sessions` lists it with the right cwd and agent and the lost-detection flag; a session
planted OUTSIDE the allowlist while the server was down is NOT adopted, so `m0/host-boundary`'s
boundary holds.

### Findings

- [medium] src/registry.ts:291 - **Adoption promotes a forged session name to a fully streamed,
  typed-into tab.** Before this branch `list()` required a `#meta` entry and only `create()` wrote
  one, so a session planted on the socket was dropped. Now the metadata is earned from (path, id)
  alone, and the id is a pure function of two values any client reads from `GET /api/cwds` and
  `GET /api/agents`. **Verified by hand:** with the real session killed, a session planted under
  the derived name at an allowlisted path became a tab, and the pane the phone would have streamed
  read `I_AM_NOT_YOUR_AGENT`. The operator's keystrokes would go to it. Marginal over what a
  same-uid attacker already has - `send-keys` into the real session, `capture-pane` off it - but a
  DIFFERENT primitive: impersonation of a trusted tab rather than interference with a real one.
  Status: **ACCEPTED WITH A REASON, and it is the most consequential judgement on this branch.**
  Provenance needs something written down and plan 001 forecloses it; the code already stated the
  weaker claim - "a filter on where a session is, not a claim that agentdeck started it". The
  alternative is leaving the tab blank after every restart, which is the gap this item exists to
  close. Mitigated by visibility rather than prevention: every adoption is logged, so an adoption
  outside the seconds after a restart is visible somewhere other than in a tab.

- [medium] src/registry.ts:328 - `reap()` cannot reach an adopted corpse, so an exited pane and its
  full scrollback stay in the tmux server's memory indefinitely, readable by any same-uid process
  via `capture-pane`. Status: OPEN, and it is a real tradeoff rather than an oversight - 501917e
  made it deliberate, because the corpse is what holds the exit report the tab shows. Bounding it
  by age is the obvious answer and the bound is a number nobody has chosen. Worth an item.

- [medium] src/registry.ts:249 - `waitingDetectionLost` is set on the wire and no client reads it.
  `m3/tab-strip` owns showing it and has not landed. Until then an adopted session comes back
  looking like a healthy tab that will never report `waiting` again - so after any restart,
  including the one `CwdAllowlist.refusal()` instructs the operator to perform to add a repo, an
  agent blocking on a permission prompt sits there with nothing on screen saying its prompt
  detection is dead. Status: OPEN, and it is a dependency `m3/tab-strip` must honour rather than a
  defect here: the API says it, the strip does not yet.

### Open after this iteration

- **An adopted tab cannot be proved to be ours.** Accepted above; the log is the mitigation.
- **`waitingDetectionLost` has no reader** until `m3/tab-strip`.
- **Exited panes are retained indefinitely** once adopted.
- **Same-uid**, unchanged, and this branch is the clearest illustration of it so far.

---

## m2/reconnect - final whole-codebase pass - 2026-08-08

The reconnect ladder, reviewed rather than rebuilt. Both halves of the done-when were already
asserted against real infrastructure in `src/client/end-to-end.test.ts` - a socket killed
mid-output repaints with no hole, and a real server SIGKILLed and restarted under a live client
repaints in a new epoch - and both still pass unchanged. This pass looked for the one failure the
whole item exists to prevent and that a green suite cannot show: a combination of the ladder's
flags (`#stopped`, `#probing`, `#carried`, `#opened`, per-socket `handled`, `#diagnosed`) that
leaves the connection with no socket, no scheduled retry and no status the user can act on. Three
were reachable, all three are fixed here, and each has a test that fails without its fix.

The server half of the storm question was checked and is sound: `buildCoalescedSnapshot` coalesces
per session, a joiner that inherits a rejection looks again before starting its own build, and the
build is raced against a bound that evicts - so a reconnect storm after a restart is one build per
session, not one per tab.

### Findings

- [high] src/client/connection.ts:717 - **A token probe that never settles wedged the connection
  permanently.** `#onClosed` clears `#socket`, sets `#probing` and awaits `verifyToken()`, which is
  `fetch` with no timeout - and the case the probe exists for is precisely the one where the
  network has gone. In that window there is no socket, nothing scheduled, and `poke()` returns
  immediately because `#probing` is the guard that stops a wake opening a second socket beside a
  ladder that is still deciding. So a request that never settles - routine on iOS for a request
  issued as the tab is backgrounded - took the connection out for the life of the tab, and the two
  events App.vue wires to `poke()`, `visibilitychange` and `online`, both hit the guard. A phone
  unlocking fires both, which is the exact moment this item is about. Status: FIXED. The probe is
  raced against `TOKEN_PROBE_TIMEOUT_MS` (10 s, generous next to the ladder's 4 s cap because a
  slow answer is still an answer); expiry is `unreachable`, not `ok`, so nothing is asserted to the
  user and the token is kept. A rejection from the injected `verifyToken` is the same answer for
  the same reason - the ladder cannot survive not getting a decision.

- [medium] src/client/connection.ts:626 - **A socket that cannot be CONSTRUCTED threw out of the
  ladder.** `new WebSocket` throws rather than closing for a blocked mixed-content or CSP-refused
  endpoint. `#open` is called from `start()` and from a scheduled retry callback, so the throw left
  no socket, no retry, and a `connecting` status that would never move again - and from a timer
  there is nobody to catch it. Status: FIXED: a socket that cannot be constructed is treated as one
  that closed, and the ladder carries on. The thrown error is swallowed rather than shown, because
  a constructor's message quotes the arguments it refused and the second argument is the
  subprotocol list, which is where the token is.

- [medium] src/client/connection.ts:594 - **`#dropSocket?.()` at the top of `#open` could leave a
  retry scheduled beside the socket it had just opened.** Dropping a socket that had CARRIED frames
  runs `#onClosed` synchronously - no probe is needed for a socket the server was talking to
  seconds ago - and that path ends by scheduling a retry. The retry then fires beside the healthy
  socket opened immediately afterwards and drops it, and every attached tab re-attaches for
  nothing: on this client a re-attach after a roll of the ring buffer is a cold snapshot per
  session, at the server that was already the reason for reconnecting. Status: FIXED: `#open`
  cancels any outstanding retry after the drop, since an open supersedes one. It cannot recurse -
  the drop's `#onClosed` either awaits the probe or returns after scheduling, never re-entering
  `#open`.

- [low] src/client/connection.ts:320 - `stop()` left the probe's bound timer running. Harmless in
  effect, since `#onClosed` re-checks `#stopped` after the probe, but a timer outliving the object
  that armed it is how a "closed" connection stops being closed. Status: FIXED: `stop()` cancels
  it, and `src/client/connection.test.ts` asserts teardown leaves no timers at all.

### Open after this iteration

- **A late `rejected` verdict from a probe the ladder has already abandoned is discarded**, so a
  token revoked during a 10-second stall is noticed one cycle later rather than immediately. The
  socket carries nothing in the meantime, so nothing is served on a revoked token; this is latency
  in signing the user out, not access. Deliberate: acting on a verdict the ladder has moved past is
  what wiped a freshly pasted token in the defect 99f1855 fixed.
- **The status stays `open` through the first, silent retry** (`showReconnecting` is false until
  one retry has failed), so for up to 250 ms a disconnected tab reads as connected. Deliberate, and
  the alternative is a banner that flashes for every ordinary drop.
- **Same-uid**, unchanged.

---

## m2/reconnect - final whole-codebase pass - 2026-08-08

The item that stopped twice. First because its epoch half was unreachable - after a restart there
was no session to re-attach to, which `m2/session-metadata-survives-restart` then fixed; the epoch
test now ASSERTS the repaint against a real server SIGKILLed under a live client rather than
measuring the gap. Then at QA, which found three real defects in the ladder and wrote failing tests
for them rather than bending them to fit. Those three are fixed in 99f1855 and each test is red
without its fix.

### Findings

- [medium] src/client/api.ts:38 - **Any 403 anywhere in the request path permanently killed the
  client, and blamed the wrong thing.** `POST /api/probe` traverses `tailscale serve`, whatever is
  on the phone's path, and in development the Vite proxy; any of them answering 403 once - a
  Tailscale ACL change, a funnel that is off, a captive portal, a proxy refusing an unknown POST
  target - set `#stopped`, and `poke()` returns early while stopped, so neither `visibilitychange`
  nor `online` could revive it. The same shape bit the honest case: an operator who fixed
  `AGENTDECK_ORIGIN` and restarted got a client that stayed dead, because nothing in the app can
  restart a stopped Connection. Status: FIXED in 828404b. A 403 is terminal only when it carries
  the sentence this server writes (`origin not allowed`); anything else is `unreachable` and keeps
  retrying. And a wake now clears that one stop, so a fixed server does not need the user to know
  to reload.

- [low] src/client/connection.ts:716 - The probe gate widened from `!#opened` to `!#carried`, so
  the client now probes after any socket that completed the 101 and then said nothing - the common
  shape behind a proxy that passes upgrades but not frames, and during a restart. A 401 on that
  probe reaches `signOut()` and clears the stored token, which a phone cannot regenerate: recovery
  means reading `~/.agentdeck/token` on the Mac. Status: FIXED in the same commit and by the same
  rule - a 401 is a rejected token only when it carries `missing or invalid bearer token`.

- [low] src/ws.ts:435 - The inherited-failure cap re-opens the snapshot storm it bounds. Once the
  cap is hit a caller starts its own build, and `resync` reaches `buildCoalescedSnapshot` from a
  socket attached to nothing with a client-chosen epoch, so a bogus epoch forces the snapshot
  branch every time. One authenticated socket can drive up to `MAX_FRAMES_PER_WINDOW` builds per
  second while builds are failing, each two `execFile` spawns with a 16 MB buffer aimed at the tmux
  server that is already the failure. The frame budget is per socket and nothing caps sockets.
  Status: OPEN. The branch narrows this rather than creating it; the real fix is a per-session
  build token with a cooldown after failure, and rate-limiting `resync` separately from the general
  frame budget, since it is the one client frame that costs process spawns.

- [low] src/http.ts:136 - `/api/probe` never reads its body, so `MAX_BODY_BYTES` is not in force on
  it - the one POST route that does not consume its body, while the file states that bound as
  universal. Node dumps the unread body so heap is bounded, but the stated rule is not true.
  Status: OPEN.

### Open after this iteration

- **`resync` costs process spawns and is bounded only by the general frame budget.** This is the
  third audit to land near it. It wants its own item.
- **Same-uid**, unchanged.

---

## m3/tab-strip - final whole-codebase pass - 2026-08-08

Status per tab is pushed rather than polled: the server announces a state change to every open
socket, and the strip renders what arrives on the socket the client already has. A session adopted
after a restart carries `waitingDetectionLost`, and the strip now shows that its waiting detection
is dead rather than rendering it identically to a healthy tab - the dependency
`m2/session-metadata-survives-restart` left for this item.

Both of the audit's mediums are consequences of pushing rather than polling, and both are fixed
here.

### Findings

- [medium] src/http.ts:123 - **The one route not behind the user's token now drives an unrate-limited
  broadcast.** `POST /api/hooks/:id` was process-local before this branch; it now fans out to every
  client synchronously inside the request. It is authenticated by the per-session secret, which any
  same-uid process reads with `tmux show-environment -t` (m0/host-boundary), and `tailscale serve`
  fronts the whole port so it is tailnet-reachable rather than loopback-only. `Hub.announce`'s
  dedupe is defeated by construction - alternate two events that map to different states - so it is
  one full fan-out per POST, with no cap on the route and no ceiling on per-socket buffering.
  Status: FIXED in 899beaa. A per-session token bucket, ten a second with a burst of twenty,
  answering 429 rather than dropping; and `send()` terminates a socket whose `bufferedAmount` is
  over a ceiling, since a phone that has lost signal but not closed buffers forever.

- [medium] src/hub.ts:172 - **`Hub.announce` was a third caller of the cwd boundary and applied it
  not at all.** The sync caller iterates an already-filtered list; the hook caller passes whatever
  id survived `secretMatches`, which reads `#meta` alone. A `#meta` entry outlives membership of
  `list()`: a session recreated by hand at a path off the allowlist is rejected by `list()` on every
  call, so neither `close()` nor `reap()` ever removes its metadata and its secret authenticates
  forever - and `sync()` prunes `#announced` for ids not in the live set, so every later POST from
  that id was news again. Status: FIXED in 899beaa: the hook path announces only for a session the
  hub holds a stream for, which is what `sync()` adopted through the filtered list. **Still OPEN:**
  `Registry.secretMatches` does not fail closed for an id whose remembered cwd no longer agrees
  with tmux, so a stranded secret still authenticates the route even though it can no longer
  announce.

- [low] src/ws.ts:218 - Opening a WebSocket now costs a `tmux list-sessions` spawn, and the
  `clients` set has no size limit, the upgrade handler never checks `req.url`, and `Tmux.#exec` has
  no `timeout`. Connection churn - which the reconnect ladder produces by design - becomes one
  spawn per upgrade, each able to hang against a stalled tmux. Status: OPEN. Post-auth only, so a
  resource footgun rather than a boundary break; the fix is a short TTL on the list, which the sync
  timer already refreshes every 2s.

### Open after this iteration

- **`secretMatches` does not fail closed on a stranded `#meta` entry.**
- **No `execFile` timeout on the tmux path**, now reachable from the upgrade handler too.
- **No cap on concurrent WebSocket connections**, and the upgrade handler accepts any path.
- **Same-uid**, unchanged.

---

## m4/pwa - final whole-codebase pass - 2026-08-08

Manifest, hand-written service worker, safe-area insets and touch targets, checked against the real
build served by the real server. **The install itself is NOT demonstrated** - it needs a phone, and
the only other tailnet device has been offline for five days - and the README says so rather than
implying otherwise, with the steps a person with a phone must take.

### Findings

- [high] src/client/vite.config.ts:11 - **`src/client/public/` is a build-time route into the
  unauthenticated publish root, and the copy dereferences symlinks.** Vite's `publicDir` copies it
  verbatim into `dist/client`, which this server serves with no bearer token, and `copyDir` is
  `statSync` + `copyFileSync` - both follow symlinks. **Measured on this machine:** a symlink at
  `src/client/public/icons/planted.png` pointing outside the repo produced a REGULAR FILE in
  `dist/client` holding that file's bytes, readable over HTTP. Pointed at `~/.agentdeck/token` it
  hands out the credential that starts sessions in every allowed repository. Three controls miss
  it: `static.ts` checks containment against the real root and by serve time it is a real file
  inside that root; the purpose-built "symlink planted inside the REAL build output" test only
  catches symlinks that survive as symlinks; and the boot guard checks where the token and profiles
  files are configured to be, never what is in the publish root. The directory was also named in
  none of the lists review is directed at. Status: FIXED in 94f9ea9. A test walks the directory and
  fails on any `lstat` that is a symlink - verified to catch a planted one - and the directory is
  named in `containment.test.ts`, the README's toolchain exception and plan 005, under its own
  heading: not host-executed, host-PUBLISHED.

- [medium] src/client/public/manifest.webmanifest:6 - `scope: "/"` plus a root-scoped worker claims
  the whole origin, and `localStorage` is keyed by origin rather than path. `tailscale serve
--set-path` mounting a sibling service on the same `.ts.net` hostname is the ordinary way to run
  two things on one machine, and that sibling would be able to read the token. Status: DOCUMENTED
  in the README's install section, with what has to change if a sibling is ever wanted. Not
  enforceable in code from here - it is a deployment decision `m4/tailscale-serve` inherits.

- [medium] src/client/index.html:18 - Installing makes the token permanent. An installed iOS web
  app gets its own storage partition and is exempt from Safari's eviction of script-writable
  storage, so the token lives until the app is deleted - and it exists in two partitions, since the
  installed app cannot see the one pasted into Safari. The server has no expiry and no revocation
  list. Status: DOCUMENTED. The only invalidation is deleting the token file and restarting, which
  revokes for every device at once; that is now stated rather than discovered.

### Open after this iteration

- **No token expiry and no revocation.** Installing sharpens it rather than causing it. Worth an
  item once the phone is actually in use.
- **The origin is whole-app.** Inherited by `m4/tailscale-serve`.
- **Same-uid**, unchanged.

---

## m4/token-qr - final whole-codebase pass - 2026-08-08

The QR carries the token ALONE, not a URL containing it: a scanned `?token=...` would sign the
phone in with one tap and leave the credential in browser history, in the `Referer` of every
request the page makes, and in the log of anything in front of the server. The encoder's output is
verified by decoding it back rather than by eyeballing blocks. The sixth and last runtime
dependency is spent here, which plan 003 line 218 pre-authorises.

### Findings

- [medium] src/server.ts:66 - **Both token-placement refusals compared lexical paths, so a symlink
  smuggled the token into the unauthenticated publish root.** `resolve` normalises `.` and `..` and
  stops there; `writeFileSync` follows links. **Measured on this machine:** a symlink at
  `~/.agentdeck/token` pointing into `dist/client` passed both refusals, the server started
  normally, and a real 0600 file appeared in the publish root - served at a URL equal to its
  filename to any tailnet device with no bearer token. That is a same-uid capability - planting a
  link in `~/.agentdeck/` - escalated into unauthenticated network read, which the README does not
  concede anywhere. `static.ts` had used `realpath` for exactly this reason since it was written.
  Status: FIXED in 1c67166, with a boot test. Worth recording that the first attempt was wrong:
  realpathing the containing directory does not follow a link AT the leaf, and the leaf is where it
  was planted - re-measured, still leaking, then fixed properly.

- [medium] src/server.ts:314 - **Two disagreeing definitions of "first run", and the disagreement
  rotated the credential in silence.** `loadToken` treats an existing but EMPTY token file as a
  first run and mints a new token; the print gate used `existsSync`, which said the file was there.
  A truncated write, an interrupted boot, a `> ~/.agentdeck/token` or an editor that saved nothing
  therefore signed out every device holding the old token and printed NOTHING - no QR, not even the
  line naming the file. Status: FIXED in 1c67166: one question, asked the way `loadToken` asks it.

- [medium] src/server.ts:414 - **The token gains a second home the boot refusals cannot reach:
  terminal scrollback.** Both refusals check where the FILE is. `capture-pane -p -e` preserves the
  escape sequences the QR is drawn with, and agentdeck runs that on every cold attach, so a QR
  printed into a tmux pane is recoverable verbatim - as it is from `pipe-pane`, `script`,
  Terminal.app and iTerm2 logging, or a screen recording. Running the server inside tmux is the
  ordinary way to keep it alive on a Mac. The `isTTY` gate is well-reasoned and covers a pipe and a
  launchd log, but a recorded TTY is still a TTY. The branch also ships a full QR decoder in
  `src/fixtures/`, which shortens "there are coloured blocks in this scrollback" to a three-line
  script. Status: DOCUMENTED in the README rather than fixed - there is no way to print a QR that a
  recorder cannot capture. The operator is told to treat a recorded first run as a disclosure and
  rotate.

### Open after this iteration

- **A recorded first run discloses the token**, and rotation is the only answer. Stated, not
  solved.
- **No token expiry and no revocation list**, carried from `m4/pwa`.
- **Same-uid**, unchanged.

---

## m4/key-row - final whole-codebase pass - 2026-08-08

Esc, Tab, arrows, Enter and a latching Ctrl, sending the bytes a PTY expects rather than DOM key
events. **The phone-side half of the done-when is NOT demonstrated** - the only other tailnet device
has been offline for five days - so a real blocking prompt is answered through the key row's own
code path against real tmux and a real shell instead, and the README carries the steps for someone
holding a phone.

### Findings

- [high] src/client/key-row.ts:71 - **The Ctrl latch made the tmux prefix reachable, and the pty is
  a tmux CLIENT - so `Ctrl` `b` `:` `run-shell "..."` executes arbitrary host commands.**
  `src/pty.ts` attaches with `tmux attach-session`, so bytes land on a client's stdin and tmux
  parses them as keys before the pane sees them. Nothing set a prefix on this socket, so it was the
  operator's own - C-b by default. **Verified on tmux 3.7b by driving a real attach client with
  exactly the bytes this row can emit: the marker file appeared.** That is outside the cwd
  allowlist, outside `AGENTDECK_PROFILES` and without `POST /api/sessions`; `new-window -c /` and
  `attach-session` to a session the registry deliberately filters off the socket are reachable the
  same way, which is the precise situation plan 005 declares the allowlist a boundary against.
  **Not a key-row bug** - any client with a real keyboard could always type C-b; the row only made
  it reachable from a phone, which is what surfaced it. Status: FIXED in ee464ff by taking the
  channel away rather than one route to it: `ensureServer` sets `prefix` and `prefix2` to `none`.
  Re-verified: the same bytes no longer execute anything. The cost is real and belongs to whoever
  attaches to this socket by hand, and it is stated.

- [medium] src/client/key-row.ts:71 - `Ctrl` then `d` is tmux `detach-client`: it kills the
  server's own attach pty while the pane keeps running, and it is a plausible mis-tap rather than
  an attack. `SessionPty.onExit` then declared `exited` on a sticky stream while `sync` kept the
  dead pty, because the session was still in the live list - so the strip showed a finished agent
  that was still working, every keystroke went into a dead pty, and recovery meant restarting the
  server. Status: FIXED in ee464ff, and independently of the prefix fix: tmux still lists the
  session, so tmux is the authority - the corpse is dropped and the next sync re-attaches.

- [medium] src/client/App.vue:146 - The Ctrl latch is one app-wide ref while `send` reads
  `active.value` at spend time, and the active tab moves on its own when the session list settles
  or a tab exits. An armed Ctrl could therefore be spent on a session the user was not looking at
  when they armed it - Ctrl+C to the wrong agent, with nothing to tell them. Status: FIXED: the
  latch disarms on any change of active tab.

### Open after this iteration

- **A hand-attached client on this socket has no tmux bindings.** The deliberate cost of the fix
  above, stated rather than discovered.
- **Same-uid**, unchanged.

---

## m4/launchd-watchdog - final whole-codebase pass - 2026-08-08

One pass of a supervisor (`scripts/watchdog.mjs`) and the LaunchAgent that would run it every 60s
(`scripts/com.agentdeck.watchdog.plist`). **Nothing is installed**: no plist in
`~/Library/LaunchAgents`, nothing in `launchctl list`, no server and no tmux session left running,
and `src/watchdog.test.ts` asserts all of that on every run. The operator installs it themselves
and the exact `launchctl` lines are in the README. Everything launchd itself does - the timer
firing, `RunAtLoad`, recovery after a reboot - is therefore UNDEMONSTRATED; what is demonstrated is
every decision the script makes when something runs one pass of it.

The item is read as **a thing that runs commands on the Mac on a timer, unattended, as the
operator**, not as a script.

### Why it decides what it decides

- **Answered slowly is ALIVE.** `/api/health` does a hard-timed `tmux list-sessions` round trip
  from the event loop that serves the app, so a busy machine or a large capture makes a HEALTHY
  server slow. An answer at all is proof the loop turned, which is the property under test;
  latency is not a health verdict. `PROBE_TIMEOUT_MS` is 15s - five times the server's own 3s
  budget and five times what `scripts/healthcheck.mjs` allows a person. A `curl -f`-shaped check
  collapses this into "dead" and drops every phone's socket and every tab's snapshot on a load
  spike. Held by mutation, not only by passing: making a slow 200 unhealthy fails the suite.
- **Silent is the wedge**, because a blocked event loop still accepts connections; three
  consecutive such passes (three minutes) before acting.
- **Refused skips the streak.** Nothing is listening, so there is no socket to drop and no
  snapshot to lose, and patience only buys a minute of being unreachable.
- **A 503, or a 200 whose body says `ok: false`, is a failure** and takes the same streak. Dropping
  the body test from the probe reads the second as healthy forever.
- **Give up rather than crash-loop.** After `MAX_RESTARTS` recoveries with no healthy pass the
  state file is latched `gaveUp` and every later pass only says so, once loudly via a critical
  `osascript` alert and then quietly in the log. A server that is down and known to be down beats
  one killed every minute.
- **What a restart costs**, which is what licenses acting on this evidence: tmux is a daemon of the
  user's, so no agent is touched - same sessions, same ids, same pane pids. It costs a reconnect,
  a new epoch, a repaint, and the hook secret of any session that outlives the process. Cheap, not
  free. `tmux kill-server` is every session at once and appears nowhere in the script; a test
  asserts its absence rather than leaving it to a path no test happens to take.

### Findings

- [high] scripts/watchdog.mjs:177 - **A recovery could hand back a server with the Origin check
  OFF.** The watchdog spawns the server with its own environment, which under launchd is exactly
  what the plist declares. `b95d072` closed the emptier half of this - it refuses to start without
  `AGENTDECK_MOUNTS` (empty allowlist: every live session filtered out of `/api/sessions`, every
  create refused) or `AGENTDECK_PROFILES` (nothing startable) - but **not the less-protected half**:
  with `AGENTDECK_ORIGIN` unset, `src/http.ts` disables the Origin check on every `/api` route and
  every `/ws` upgrade, so any page a browser visits can drive the API with a token it has. The
  recovery would do that at 3am, unattended, under a banner saying the sessions were kept.
  Status: FIXED - `AGENTDECK_ORIGIN` joins `REQUIRED_ENV`, so the same refusal, log line and
  once-only banner cover it, and a test drives the refusal. Rejected: an opt-out env for operators
  who deliberately run without an Origin check - `""` is not usable as "off" (`src/http.ts` treats
  a defined-but-empty origin as an allowlist of one, which rejects everything), and a flag whose
  only effect is to re-enable a downgrade is a flag that gets set once and forgotten.
- [medium] scripts/com.agentdeck.watchdog.plist:PATH - **The PATH the plist declared put two
  user-writable directories ahead of `/usr/bin`** (the mise node directory and
  `/opt/homebrew/bin`). `osascript` and `tailscale` are resolved on that PATH, and "this user" is
  who an agent in a tmux session runs as - so an agent dropping `osascript` in either directory has
  it executed by a timer, as the operator, within 60 seconds, with no human action. Status: FIXED -
  `/usr/bin:/bin:/usr/sbin:/sbin` first, the writable directories after, asserted by a test.
  Rejected: absolute `/usr/bin/osascript` in the script. It is the stronger control, but PATH
  interposition is the only seam by which the suite proves a person is actually told what the
  watchdog did, and losing every notification assertion to gain a second lock on the same door is
  a bad trade. `lsof` is called by absolute path.
- [medium] scripts/watchdog.mjs:tailscale - **PATH order bought nothing for `tailscale`, the one
  PATH-resolved command with no copy in a system directory.** On this Mac `tailscale` resolves only
  to `/opt/homebrew/bin/tailscale`, `drwxrwxr-x soya:admin` - writable by the uid every agent in a
  session runs as - and `serveConfigured` runs it on every pass, healthy ones included, so an agent
  replacing that symlink (or its Cellar target) has its file executed by launchd as the operator
  within 60 seconds, at every RunAtLoad and after every reboot. Status: FIXED - `TAILSCALE` is
  `/usr/local/bin/tailscale` (root:wheel here), overridable only by `AGENTDECK_TAILSCALE` for the
  suite's stub, and when that path is absent the serve check is skipped with a log line rather than
  falling back to PATH; a test drives the skip and asserts the PATH copy was not run. Residual,
  RECORDED: the recovered server inherits this PATH and resolves `tmux` (`probeTmux`, `src/tmux.ts`)
  from `/opt/homebrew/bin`, so the same drop owns every session a recovery creates - the same class
  as the already-recorded agent-writable `src/server.ts`, and closed by the same deployment change.
- [medium] scripts/watchdog.mjs:gaveUp - **The give-up latch disarmed supervision permanently and
  silently, out of a file any agent can write.** `readState` trusts
  `~/.agentdeck/watchdog-state.json`, and the first thing a pass did was exit on `state.gaveUp`
  before probing and without notifying - sound only if the watchdog set it. It is same-uid data
  with no integrity check, so `{"gaveUp":true}` plus a kill left the machine unsupervised across
  reboots with only a log line; and the latch is reachable with no credential at all, since
  unauthenticated `/api/health` forks `tmux list-sessions` per request and sustained tailnet
  pressure spends both restarts and then latches. Copying the script out of the checkout does not
  move this file. Status: FIXED - a latched pass still probes, and while the server is not
  answering it re-alerts on a bounded cadence (`GIVE_UP_REALERT_MS`, one hour, stamped in
  `gaveUpAlertedAt`), which keeps the anti-crash-loop property while making a planted latch
  audible; a test plants one and asserts both the alert and the quiet hour after it. `startRefused`
  is left as-is: its worst case is a suppressed banner about a misconfiguration that every pass
  still logs and that stops nothing from running. README and the plist now say what the copy does
  and does not put out of an agent's reach.
- [medium] scripts/watchdog.mjs:180 - The recovered server's log is where the server's own words
  go, including a first run's token block (`m4/token-qr`). It was created at the umask default.
  `src/qr.ts` does not print the QR when stdout is not a TTY - which is always, under launchd -
  and prints only the token file's path, so no token has been observed in that file. Status: FIXED
  anyway, `0600` with a `0700` parent, because the mode is what stops the next change to that
  branch from being a leak; a test asserts the mode.
- [medium] scripts/watchdog.mjs:186 - **The recovery executes agent-writable code as the operator,
  and copying the script out of the checkout does not close it.** The README and the plist tell the
  operator to point `ProgramArguments` at `~/.agentdeck/bin/watchdog.mjs` so that launchd is not
  running a file an agent can rewrite. `AGENTDECK_REPO` then points the copy back at the checkout,
  and `startServer` spawns `<repo>/src/server.ts`. So the timer still runs agent-writable code as
  the operator on every recovery; what the copy buys is that the _supervision policy_ - what to
  kill, what to spawn, what to tell the person - is no longer agent-writable, which is the larger
  half. Status: RECORDED, not fixed. Closing it means running the server from a checkout an agent
  cannot write, which is a change to how agentdeck is deployed and is not this item's. The claim
  in the plist and the README is corrected to say what the copy does and does not buy.
- [low] scripts/com.agentdeck.watchdog.plist - `KeepAlive` is absent and must stay absent. Both of
  the script's deliberate refusals (`gaveUp`, `missingEnv`) exit non-zero, and under `KeepAlive`
  launchd relaunches a failed job every `ThrottleInterval` - reinstating the crash-loop the give-up
  was written to prevent, one layer below where the give-up can see it. `StartInterval` alone
  gives a fixed 60s cadence and no respawn-on-exit, and launchd will not start a second instance
  while one is running, so a pass that takes 15s does not overlap the next. Status: asserted by a
  test so a later edit has to argue with it.
- [low] scripts/watchdog.mjs:137 - Restarting into a SECOND server beside a live one: not reachable
  through `stopServer`, which takes the pid `lsof` reports as the listener this pass rather than a
  remembered one, and there is a narrow window where a server still booting reads as `refused` and
  a second is spawned - the loser gets `EADDRINUSE` and exits, and `MAX_RESTARTS` bounds the
  repetition at two. Accepted.
- [low] scripts/watchdog.mjs:105 - The state file is JSON on disk that a crash can truncate and a
  hand can edit, and `state.pid` is what `stopServer` sends SIGTERM then SIGKILL to. `kill(0, ...)`
  signals the watchdog's whole group and `kill(-1, ...)` every process this user owns. Validated
  where it is read (`Number.isInteger(pid) && pid > 1`) and cross-checked against `lsof` every pass,
  so a recycled pid is not a signal aimed at a stranger. Both covered by tests.
- [low] **The health check the watchdog trusts is partly blind, and that is worth stating.**
  `/api/health` answers 200 for exactly the locale failure that broke every create in
  `m0/create-500`, because `src/server.ts`'s `probeTmux` does not go through `baseEnv` and so has
  its own locale (recorded above, still OPEN). A 200 here means the event loop turns, not that the
  server works, so this watchdog cannot see that class of failure at all and will report a server
  that creates nothing as healthy forever. Fixing it is a change to `src/server.ts` and belongs to
  its own item. The second gap - no `execFile` timeout on the server's tmux path, so a wedged tmux
  piles up children nothing reaps - is precisely what the watchdog sees as `silent`, and restarting
  is what reaps them. Every `execFile` the watchdog itself makes carries a timeout, so it cannot
  join the pile it exists to notice; a test reads the source and asserts that.

### Open after this iteration

- **launchd is undemonstrated.** Nothing has loaded the plist on this Mac, by the operator's
  decision. The timer, `RunAtLoad` and reboot recovery are claims, not measurements.
- **It cannot fight a sleeping Mac** (plan 006). With the lid shut nothing runs; Energy Saver or
  `caffeinate` is the answer, decided deliberately rather than discovered.
- **`tailscale serve` is detect-and-report, not re-apply.** Re-applying is `m4/tailscale-serve`,
  blocked on two admin-console switches. "Never configured" is the expected state of that unbuilt
  item and must not fail a pass or notify - a watchdog that reports a milestone as an outage is one
  whose alerts are ignored by the time the outage is real. "Was configured last pass and is gone"
  is the reboot case and does notify.
- **A restart still loses the telling-you-about-it** (plan 006): surviving sessions come back
  without cwd, agent or hook secret, so a surviving claude session never reports `waiting` again
  until it is recreated. Filed alongside `m0/supervisor-crash-test`, not solved here.
- **The recovery runs agent-writable `src/server.ts`**, per the finding above.
- **Same-uid**, unchanged.

---

## m4/launchd-watchdog - final whole-codebase pass - 2026-08-09

A launchd job on a 60s timer: the node process running, `/api/health` reachable, `tailscale serve`
still configured. Restarts after three consecutive failures, then gives up and alerts rather than
crash-looping. **Written and demonstrated, deliberately NOT installed** - the operator chose to run
`launchctl` themselves, and nothing on this machine was loaded or left behind. So the launchd half
of the done-when - the timer firing, recovery after a reboot - is NOT demonstrated; the watchdog
logic is, directly and completely.

### Findings

- [medium] scripts/watchdog.mjs:155 - **Health was decided by port ownership alone.** Any listener
  answering 200 with `{ok:true}` on `/api/health` was believed, and that route is unauthenticated
  by design and reproducible in about thirty lines. A same-uid process - which the threat model
  assumes - could SIGKILL the server, bind the port with a stub, and buy permanent silence from the
  only thing watching it: every later pass logs a green result, resets the counters, and never
  notifies. Once `m4/tailscale-serve` lands, that impostor is what the phone reaches and what
  receives its bearer token. Status: FIXED in 4a2f719. The listener's argv must name this node and
  this repo's `src/server.ts`.

- [medium] scripts/watchdog.mjs:309 - **The same gap, pointing outward: it would kill anything.**
  `stopServer` signalled whatever `lsof` reported on the port, with no identity test, and the plist
  hardcodes 7777. An operator who moves agentdeck and leaves the plist as shipped - or any other
  tool of theirs that binds 7777 - gets SIGTERM then SIGKILL from an unattended timer three minutes
  after it starts listening. Status: FIXED in the same change. A squatter is logged and alerted,
  and explicitly neither killed nor believed: "something else owns your port" is an operator
  decision.

- [medium] scripts/com.agentdeck.watchdog.plist:103 - **A wrong-but-present value was invisible.**
  `AGENTDECK_ORIGIN` shipped as `https://mac.example.ts.net` while `missingEnv` tested only for
  empty, so a missed edit gives a server that answers 403 to every browser request and every socket
  upgrade while `/api/health` - answered before the origin check - returns 200. The watchdog would
  log a green pass every 60 seconds against a server the phone cannot use at all. `AGENTDECK_MOUNTS`
  shipped as the ghq OWNER directory rather than a repository, so a recovery would hand back a
  broader allowlist than the one it replaced - which plan 006 says a recovery must not do. Status:
  FIXED: both are `REPLACE_ME` sentinels and refused exactly like an absent value.

### Found while verifying, not by the gate

`src/watchdog.test.ts` took over ten minutes and presented as a hang. The cause was not the real
timers it waits on: `waitForHealth` called `fetch` with no timeout against a wedged listener - one
that accepts the connection and never answers - which waits forever rather than slowly. Bounded now
with `AbortSignal.timeout`, and the probe timeout, slow threshold and stop grace are env-overridable
so the tests drive milliseconds. **The file is 14 seconds and the whole suite is 20.** The
production defaults are asserted separately, so shrinking them in tests cannot hide a changed
default.

Also recorded because it cost time: the first attempt at that speed-up was reverted. Rescaling the
constants without noticing an assertion that pinned the literal `15000ms` broke the failure-counting
tests, and the real problem was the unbounded fetch underneath.

### Open after this iteration

- **The launchd half is not demonstrated**, by the operator's decision. `launchctl bootstrap
gui/$(id -u) ~/Library/LaunchAgents/com.agentdeck.watchdog.plist` is theirs to run.
- **`/api/health` is blind to the failure class that broke every create** (`probeTmux` does not use
  `baseEnv`), so the watchdog trusts a probe that cannot see it. Recorded, not fixed.
- **Same-uid**, unchanged.

---

## m4/tailscale-serve - final whole-codebase pass - 2026-08-09

The code is complete; the item is NOT ticked. Both tailnet switches are still off, so the
done-when - the `ts.net` URL loading over HTTPS with a secure context - cannot be demonstrated, and
the phone has been offline besides. What IS demonstrated: the detection of both missing switches
against the real binary, the origin derivation, the refusal paths, and the timeout behaviour
against a stubbed tailscale.

### Findings

- [high] scripts/watchdog.mjs:291 - **The Funnel refusal existed only at install time, and the one
  recurring check had no notion of Funnel.** `scripts/tailscale-serve.mjs` refuses to run under
  Funnel, but that is one invocation; the watchdog looks at `tailscale serve status` every 60s and
  matched only for the loopback port. So anything running as this uid could turn Funnel on after a
  green install and put a terminal server on the **public internet** - the unauthenticated client
  bundle and `/api/health` to anyone, session creation to anyone holding the token - while every
  automated check stayed green. The same check was asymmetric: it alerted when exposure was LOST
  and was silent when it was GAINED, which is the security event. Status: FIXED in 95184dd. Funnel
  is read with the same predicate the install script uses, defined once in `src/tailnet.ts`, and
  alerted every pass it is true; exposure appearing is now a notification too.

- [high] scripts/tailscale-serve.mjs:136 - **The proxy outlives the server it was verified
  against.** The script proves agentdeck owns the port before applying serve - it requires the real
  `/api/health` body, not just a 2xx - but `tailscale serve --bg` writes tailscaled state that
  survives the server exiting, a logout and a reboot, and nothing re-runs that proof. The
  watchdog's squatter branch, added in `m4/launchd-watchdog`, makes it concrete: it deliberately
  refuses to kill a non-agentdeck process holding the port, so that process is published to the
  tailnet with a real certificate while the alert reads as a local port conflict. Status: PARTLY
  FIXED in 95184dd - the alert now says when the port is published and names `tailscale serve
reset`. **OPEN:** nothing tears the grant down automatically, and re-verifying it on a schedule
  would be the real fix.

### Found while verifying, not by the gate

Two tests are flaky under load and pass repeatedly in isolation: `snapshot.test.ts`'s "scrollback
that is already in history is not repeated in data" (the ring buffer does not hold the burst when
the machine is busy) and the watchdog's "the recovery leaves ONE server on the port". Neither is a
product defect; both are timing assumptions that hold on an idle machine. Worth an item.

### Open after this iteration

- **The serve grant is permanent once applied.** Named above.
- **Two flaky tests.**
- **The HTTPS half is undemonstrated** until both tailnet switches are on.
- **Same-uid**, unchanged.

---

## m4/tailscale-serve - demonstrated - 2026-08-09

The operator enabled both tailnet switches, so the half that could not be shown now can be. Verified
from this Mac over the tailnet:

- `https://example-host.tailXXXXXX.ts.net/` serves the client, HTTP 200, with a verified
  certificate (`ssl_verify_result=0`).
- `/manifest.webmanifest` and `/sw.mjs` answer 200 with `application/manifest+json` and
  `text/javascript` - the MIME types iOS needs before it will treat the page as installable.
- `/api/sessions` without a token is 401 through the proxy.
- **The Origin check runs for the first time.** With `AGENTDECK_ORIGIN` set to the value the boot
  log names: right Origin 200, wrong Origin `403 origin not allowed`, absent Origin allowed because
  curl is not a browser. This file recorded three times that the check was off for every ordinary
  run; it is not any more.
- `tailscale serve status` reported `(tailnet only)`, never Funnel. `tailscale serve reset` was run
  afterwards, so nothing is left published.

**Found by running it for real:** the first HTTPS request to a `ts.net` name is where tailscaled
issues the certificate, and that outran the script's single 10s probe - the first run reported
"serve is configured but /api/health did not answer" while the URL worked 0.4s later by hand. The
script retries across issuance now, with a line saying why. A one-shot probe would have sent the
operator to debug a working deployment.

**Still not demonstrated: the phone.** Everything above is from the Mac. The device has been offline
throughout, so the three phone done-whens - the home-screen install, the token arriving by scan, and
a permission prompt answered rather than watched - remain unshown.

## Phone-found defects, 2026-08-09 (keyboard, close, neighbour warning)

Three items, all found by Soya using the deck on a real phone against a suite that was green.

**The soft keyboard covered the bottom of the app.** iOS Safari shrinks the visual viewport when
the keyboard opens and leaves the layout viewport at full height, so `height: 100%` kept the app
tall and the keyboard sat over the key row and the last terminal rows - which is where a permission
prompt and the cursor are. Fixed: `.app` is `position: fixed` and its height and `translateY` are
written from `visualViewport` (`src/client/viewport.ts`), on `resize` and on `scroll`. The pane's
existing `ResizeObserver` refits the terminal and reports the new cols/rows, so the pane reflows
rather than being cropped.

**No way to close a session from the phone.** `DELETE /api/sessions/:id` has existed since m1 with
nothing able to reach it: a session started from the phone could only be ended from the Mac. The
cap is on the active tab only and arms before it acts, because closing kills the agent and there is
no undo.

**The two-agents-in-one-tree warning is removed** (plan 004, revised by Soya). It fired on a
neighbouring `shell` session, which is the operator's own terminal rather than a second process
editing the tree - the case the plan's own last paragraph already exempted. A warning that fires
mostly on the legitimate case is dismissed by habit, and then it is still there when it matters and
no longer read. `POST /api/sessions` now sets `warning` only when the same agent is asked for twice
and the running session is handed back.

*Accepted with a reason:* nothing now says out loud that a second agent is being started in a tree
that already has one. `GET /api/cwds` still reports the live sessions per directory and the picker
shows them, so the collision is visible **at the moment of choosing** rather than after the fact -
which is the only moment it can change the decision. This is a deliberate loss of a notification,
recorded rather than solved.

*Not demonstrated:* both client changes are unshown on a device. The keyboard fit cannot be
exercised on the Mac at all - the failure only exists where there is a soft keyboard - and nobody
has yet tapped Close on a phone.

## Touch scrolling in the terminal pane

**Reported from a phone:** streamed output could not be read back in Safari. Dragging on the
terminal scrolled the page, never the scrollback.

**Cause:** xterm has no touch scrolling of its own. It scrolls on `wheel`, and on a touch device
the drag lands on `.xterm-screen`, which sits above `.xterm-viewport` and does not scroll. Nothing
in the pane claimed the gesture, so Safari gave it to the page.

**Fixed:** `TerminalPane` takes `touchstart`/`touchmove`/`touchend` on the host and converts the
drag into `term.scrollLines()`, carrying the sub-row remainder so a slow drag still moves. The
pane is `touch-action: none` so the browser never starts its own scroll, and `touchmove` is
non-passive so the page can be refused. `touchstart` does NOT preventDefault - that is the change
that made every key-row cap dead on iOS last time. Scrollback raised from xterm's default 1000
lines to 5000; an agent writes more than a screen at a time and this is the only copy.

*Accepted with a reason:* `touch-action: none` also gives up pinch-zoom inside the pane. Font size
is fixed at 13px, so zoom was the only way to enlarge the text and it no longer exists. Recorded
rather than solved; a pane-local font-size control is the answer if it is wanted.

*Not demonstrated:* unshown on a device. There is no touch on the Mac, and the suite (863 green)
says nothing about this - the defect it fixes passed every test.

## Scrollback wrapping, and the turn log (plan 007)

**Reported from a phone:** after a finished turn, scrolling up showed the earlier part of the
answer broken at the wrong columns.

**Cause:** `capture-pane` without `-J` returns each segment tmux wrapped as its own line,
terminated by a newline, broken at whatever width the pane had when the text was written. A pane
opens at `DEFAULT_COLS = 120` before any client attaches, and the phone is far narrower, so every
session's early output is in history at 120 and the phone wraps it a second time. Verified against
a real tmux server: 250 characters written at width 100, the window resized to 40, captured with
and without `-J`.

**Fixed:** `Tmux.captureHistory` passes `-J`, so a wrapped line comes back as one line and the
client re-wraps at its own width.

*Accepted with a reason:* pinning the pane to a fixed size was considered as the alternative and
rejected. The phone's own width is not a constant either (rotation), and a pinned width that does
not match the attached client makes the LIVE screen wrap wrongly too - a worse failure than the
history one, and a continuous rather than an occasional one. `-J` removes the dependency on width
entirely, including for history already written.

**Then, the feature underneath it:** the scrollback is the wrong store for an answer at all -
bounded by lines rather than turns, ANSI, unsearchable, and reachable only by dragging a repainting
TUI. Plan 007 adds a turn log: `UserPromptSubmit` and `Stop` joined on the `prompt_id` the agent
itself supplies, stored as one append-only JSONL file per session under `~/.agentdeck/turns`, and
read by the phone as a list. No new dependency and no database; the reasoning against sqlite is in
the plan.

**Found by running it, not by the suite:**

- **A truncated answer was recorded as a whole one.** The hook command cuts the long fields before
  sending, and it cut to exactly the store's bound - so the store saw a field at its limit,
  indistinguishable from one that fit, and wrote no `truncated` flag. It now cuts to the bound plus
  one character. Every test passed both before and after.
- **A long answer used to lose its state as well as its text.** The hook command buffered 64KB and
  sent whatever it had, which for a longer payload is invalid JSON, which the route answers 400 -
  so no state was declared for that turn either. Pre-existing, invisible while payloads carried
  only an event name, and fixed by the same cut.

*Accepted with a reason:* every answer the agent gave is now plaintext on disk under
`~/.agentdeck/turns`, readable by anything running as the operator. This adds material to the
same-uid residual rather than changing its shape - that text already existed in Claude Code's own
transcripts, which the same processes can already read. One more copy, in a more convenient format.

*Accepted with a reason:* `last_assistant_message` when a turn's final block is a tool call rather
than text could not be captured - told to end on a tool call and say nothing, the model emitted a
final text block anyway. An absent, non-string or empty value logs nothing rather than an empty
entry, so the unobserved case degrades to "no history for that turn". Compaction and `--resume`
were not captured either; a `Stop` with an unseen `prompt_id` is stored with an empty prompt.

*Pre-existing, not caused by this work:* two tests that drive a real tmux and a real socket flake
under load. `end-to-end.test.ts`'s "the server process is restarted under an open client" timed out
waiting for the socket once and passed on the next run and standalone. `snapshot.test.ts`'s
"scrollback that is already in history is not repeated in data" fails intermittently the same way. Its precondition is that a
256KB ring buffer still holds a 400-line burst, which is a race with the reader. Confirmed on
unmodified `main`: one failure in two full runs with this branch stashed. Three added test files
make the suite heavier and so make it fire more often. Left alone rather than papered over, because
the fix is to stop the test depending on the machine it runs on and that is its own change.

*Not demonstrated:* the phone half is entirely unshown. The Answers overlay, its list, the tap to
open an answer, the refetch when a turn ends, and the `-J` fix as a person sees it all need a
device. What was demonstrated on the Mac: the `-J` capture against a real tmux, the hook command
run through a real shell against a real socket with a real 3776-character captured answer and a
500,000-character one, and 890 tests.

## The deck's tmux is no longer configured by the operator's terminal

**Found while answering a question about it, not reported as a fault.** `~/.tmux.conf` was being
read by agentdeck's tmux server: `-L` picks the socket, it does not change where tmux resolves its
config from. Verified by reading the running options off a server started by hand.

What the operator's config was actually doing on this socket: `mouse on`, which makes tmux claim
the SGR mouse reports the phone's touch handling sends; a `set-titles-string` containing `#(cd ...
&& git branch ...)`, which runs shell commands on a timer inside the deck's own server; `status
on`, costing a row of a phone-sized pane; and `prefix C-b`, which `Tmux.ensureServer` was already
overriding at boot.

**Fixed:** `tmux.conf` in the repository, passed as `-f`, so a server agentdeck starts reads it and
never the operator's. The settings that must hold on a server agentdeck did NOT start - status,
mouse, history-limit - are also applied as globals in `ensureServer`, the same way and for the same
reason the prefix already was: `start-server` is a no-op against a live server, and attaching by
hand is the documented way to reach an orphaned session.

Both paths checked against a real tmux rather than inferred. A server started with `-f` reports
`mouse off`, `history-limit 10000`, `prefix None`, against the operator's `on`/`50000`/`C-b`. A
server started by hand reports the operator's values and reports agentdeck's after `ensureServer`.

**`DEFAULT_COLS` is now 50x30 rather than 120x40** (`src/hub.ts`), because the phone is the only
thing that attaches and 120 had no argument behind it. It decided the width of every line written
before the first attach, and tmux does not reflow history.

*Accepted with a reason:* `tmux.conf` is host-executed in the sense CLAUDE.md means - tmux reads it
as the operator and a `run-shell` in it would execute on the Mac. Nothing in it runs a command. It
is not on CLAUDE.md's stop-and-ask list because it did not exist when that list was written; adding
it there is Soya's call.

*Accepted with a reason:* `history-limit` drops from the operator's 50000 to 10000. A cold snapshot
captures 2000 lines, so the deck cannot show more than it captures either way; the difference is
only visible to a person attached by hand.

*Not demonstrated:* the new 50x30 default is arithmetic, not a measurement - 13px monospace at
about 7.8px per column against a ~390px portrait phone. It has not been checked against a device,
and the first attach supersedes it, so being near is all it has to be.

## The pane is 40 columns, and never anything else

The phone showed older output broken mid-column when scrolled back, after a first attempt that only
pinned the CLIENT at 40 columns. Pinning the client is not enough, and the reason is the same one
already recorded above: tmux does not reflow scrollback. The pane's width followed whatever the
attached clients reported (`paneSize`, the minimum over them), so a session's history is a trail of
stretches each frozen at the width in force when it was written - the 50-column default before the
first attach, then whatever a client asked for, then whatever it asked for after a rotation or a
second tab. Re-wrapping that at the phone's width can only ever be right for the newest stretch.
`capture-pane -J` repairs the lines tmux itself wrapped, which is why this was invisible until a
long scrollback was read on a device.

**Fixed:** the width is a server-owned constant, `PANE_COLS = 40` in `src/hub.ts`, applied at
session creation and on every resize. A client's `cols` no longer reaches the pane at all:
`paneSize` became `paneRows` and returns only the minimum row count, and `Hub.applyPaneSize` became
`applyPaneRows`. Rows still follow the clients - tmux reflows height freely and nothing is frozen
by it.

**Fixed:** `TerminalPane` fixes xterm at 40 columns and scales its font to whatever makes 40 fill
the width, taking only the rows from the fit addon. The font pass repeats on an animation frame
because the addon measures the font in effect, not the one just assigned, and is capped at four
passes: flooring to whole pixels lets two sizes each propose the other.

*Accepted with a reason:* a second tmux client attached by hand can still move the window's width,
because `window-size` is left at tmux's default. Making it `manual` would freeze the rows too, and
`tmux.conf` is host-executed. Recorded rather than solved.

*Accepted with a reason:* sessions that already exist keep the mis-wrapped history they accumulated
under the old behaviour. Nothing can reflow it; it ages out of the 10000-line limit.

*Not demonstrated:* the phone. The suite is green (901) and the font arithmetic is reasoned, not
measured on a device - which is exactly what the first attempt at this was, and it was wrong.

*Noted:* `src/client/end-to-end.test.ts`, "the server process is restarted under an open client",
failed once on a run where the whole suite took 54s instead of 21s, and passed alone and on the
next full run. Timing, not the change - but it is a real flake and it is written down rather than
re-run until quiet.

## The scrollback, which is where the wrapping was actually wrong

The 40-column work above did not fix what the phone was showing. The report that located it: the
live stream wraps correctly, and only the HISTORY has spaces in the middle of lines and breaks in
the wrong places. That rules out the pane width - the live pane and the history come from the same
pane - and points at `capture-pane`, which is the only thing the history goes through.

Two defects, both measured against tmux 3.7b in a real 40-column pane rather than reasoned about.

**Fixed: `-J` preserves trailing spaces.** It is passed to join wrapped lines, which is wanted, but
the man page's other half is "and preserves trailing spaces for each line". A TUI pads nearly every
line it draws out to the pane width, so `printf "%-40s\n" PADDED` captures as the word plus 32
spaces. Every such line arrives at the client already exactly a row long - or longer, if it was
padded when the pane was wider - so the client breaks it and starts the next line in the middle of
the row. `Tmux.captureHistory` now strips the padding, keeping any escape sequence that follows it
so a colour is still closed where the pane closed it.

**Fixed: `capture-pane` separates lines with LF alone.** A PTY writes CR LF, which is why the
terminal is not in `convertEol` mode - so an LF-only history moved down without returning to column
one, and the scrollback rendered as a staircase, each line indented by the length of the one above.
Nothing in the pipeline had ever normalised it. This is very likely the "spaces in odd places" half
of the report, and it had been there since the history frame existed.

Both live in `forTerminal` in `src/tmux.ts`, applied only to captured history. The live pane is a
repaint, not a capture, and does not pass through it.

Checked end to end against a real pane, not only in unit tests: the raw capture of a 40-column pane
contained zero CR bytes and a longest line of 241; after `forTerminal` every line is its own text's
length, there is one CR per LF, the padded box line is 10 characters instead of 45, and a genuinely
long 79-character line is still one line for the client to wrap at 40.

*Accepted with a reason:* the coloured fill to the right of a TUI's box is lost in scrollback. The
padding is what carries it, and the padding is the defect. The live pane keeps it.

*Not demonstrated:* the phone, again. Two rounds of this have now been reasoned correct and been
wrong on the device, and the thing that found the real cause both times was Soya looking at it.

### And then `-J` itself was the rest of it

The report that closed it: text from one line - "Now verify it against", a button glyph - appearing
at the right-hand END of the previous line. That is `-J` joining, made visible by the padding strip
above rather than caused by it.

`-J` joins the rows tmux wrapped back into one logical line. That is right only when the client's
width differs from the pane's, which was the argument for passing it - and it stopped being true
the moment `PANE_COLS` fixed both at 40. Worse, tmux sets a row's wrap flag whenever text filled
the row and kept going, which a TUI does on every full-width line it draws, so `-J` welds such a
line to the next LOGICAL line, not just to its own continuation.

Reproduced on tmux 3.7b in a 40-column pane before changing anything: a padded full-width line
followed by `NEXTLINE` captures with `-J` as one 57-character line, and without `-J` as the two
rows the pane actually showed.

**Fixed:** `-J` is gone from `Tmux.captureHistory`, with the reasoning written at the call site so
it is not helpfully restored. Checked end to end through `captureHistory` itself against a live
pane: every row comes back at 40 columns or less, one CR per LF, the full-width line breaking
exactly where the pane broke it. `forTerminal` keeps the CR LF normalisation, which was a real and
separate defect; its padding strip is now belt and braces, since tmux strips trailing spaces itself
when `-J` is not passed.

*Accepted with a reason:* history written when the pane was a different width stays wrapped at that
width and is wrapped again at 40. Nothing can reflow it - that is the same tmux limit this whole
entry is about - and with the width now constant it can only affect sessions that predate it.

*Not demonstrated:* the phone. Third round.

## Sending an image from the phone

`POST /api/sessions/:id/uploads` takes the raw image bytes, writes them under
`~/.agentdeck/uploads/<session>/`, and answers with the path. The client downscales to 1568px on
the longest edge, uploads, and TYPES the path at the prompt without submitting it.

The bytes never go near the terminal stream. A screenshot pasted into a pty is megabytes of base64
typed at an agent's prompt through a 40-column pane; a path is 60 characters and the agent reads
the file itself.

Raw body rather than multipart or base64: multipart costs a dependency and the budget is spent,
base64 costs a third of the phone's uplink. The one route whose body is legitimately megabytes gets
its own 8MB ceiling; every other route keeps the 64KB one, which is right for JSON and was never
about this.

**Filenames are entirely the server's.** A random stem plus an extension chosen from a safelisted
content type, so nothing the client sends is ever part of a path - there is no traversal to
sanitise, no second dot, no `.command` landing in a directory the operator may open in Finder. The
session id, which does arrive as a raw path segment, goes through the same allowlist-filtered
`Registry.list()` that `close` uses before any directory is made.

*Accepted with a reason:* the upload directory is readable by anything running as the operator,
like the token, the hook secrets and the tmux socket. Same-uid is the standing residual, and a
screenshot of the deck is not a new class of secret. It is outside every allowlist entry so an
agent's own `grep -rn` does not walk into another session's images.

*Accepted with a reason:* 20 images per session, oldest deleted by mtime. A button on a phone must
not grow disk without end, and there is no expiry - a session that is never used again keeps its
last 20 until someone removes the directory.

*Not demonstrated:* the phone. `createImageBitmap`, the file picker sheet, HEIC normalisation and
whether the typed path lands in Claude's prompt rather than being eaten by its input handling are
all unverified on a real device. The server half is covered by tests; the iOS half is not.

## The scrollback fix, confirmed on the device

The three rounds above - the 40-column pane, the LF-to-CRLF normalisation and the padding strip,
and dropping `-J` - were all written "not verified on the phone". Soya has now confirmed on the
device that the scrollback reads correctly. The record above stands as written; this is the
verification it was missing.

## Ctrl was off the right-hand edge of the key row

Reported from the phone: the row reads `Esc Tab Left Down Up Right Enter` and `Ctrl` is cut off.

`.cap` was `flex: 1 0 auto` with `min-width: var(--touch-target)`. Eight caps at 44px is 352px,
plus seven 4px gaps and 8px of row padding is 388px, before either safe inset. No phone in portrait
has that, and `1 0 auto` forbids shrinking, so `overflow-x: auto` on the row took the overflow and
Ctrl - the last cap, and the only way to reach Ctrl+C - sat off-screen with nothing to indicate it
could be scrolled to. Ctrl+C is the single most-needed key on the row, so this was the row failing
at its own reason for existing.

The caps are now `flex: 1 1 0; min-width: 0`, so eight of them share whatever width there is:
about 42px each on a 375px screen. Height keeps `var(--touch-target)`; a full-width row is under
the thumb regardless of where along it the thumb lands, so height is the dimension that matters and
width was never really the touch target. Horizontal padding is 0.125rem and the label font 0.8rem
so `Right` and `Enter` still fit, with `white-space: nowrap` because the way a shrinking cap fails
is by wrapping to two lines and making itself taller than the caps beside it.

`key-row.test.ts` asserted `min-width: var(--touch-target)` - it pinned the mechanism that WAS the
bug, which is the failure mode CLAUDE.md names. It now asserts the opposite, with the arithmetic in
the comment so the next person does not put it back.

*Not demonstrated:* the phone. The arithmetic is checked and the suite is green, but whether the
labels are legible at 0.8rem in a real hand is a device question.

## Answers removed, and Image moved onto the New session bar

Soya's call: the turn history is not wanted for now. Removed to the UI-and-API depth, deliberately
not further - the hook plumbing that carries it also carries `waiting`, which is what tells the
phone which session needs a person, and that stays.

Gone: `src/turn-log.ts`, `TurnHistory.vue`, `turn-history.ts`, `fetchTurns`/`TurnPage`,
`turnFromHookEvent`, `GET /api/sessions/:id/turns`, the `turns` dependency on the HTTP handler and
its construction in `server.ts`, and `logsTurns` on `AgentSummary`. `turn-log.test.ts`,
`turn-capture.test.ts` and `turns-route.test.ts` went with them.

Kept, and worth naming because it looks like leftovers:

- `src/ring-buffer.ts` is NOT the turn log. It is the terminal scrollback buffer behind
  `stream.ts` and `attach.ts`, and only shared a plan number.
- `MAX_FIELD_CHARS` and the hook command's trimming of `prompt` / `last_assistant_message`. The
  agent still SENDS that text; nothing reads it now, but an untrimmed payload is a body the route
  refuses, and a refused body loses the status frame for that turn as well. The constant moved from
  `turn-log.ts` into `claude-hooks.ts`, where the only remaining reader of it lives.
- `HOOK_MAX_BODY_BYTES` at 256KB, for the same reason.
- `fixtures/claude-turns.jsonl`, still the fixture `turn-transport.test.ts` sizes itself against.

The layout: `Image` was a chip in an `.actions` strip of its own between the tab strip and
`New session`, which read as a floating control belonging to nothing. `NewSession.vue` now has a
`.bar` holding the toggle and a `beside` slot, and `App.vue` puts `UploadImage` in it. The toggle
is `flex: 1 1 0` and the upload `flex: 0 0 auto`, so Image keeps its label's width and New session
takes the rest; the sheet still opens full width below. The bar carries the horizontal safe insets,
which the toggle did not have when it was edge to edge.

`pnpm build` succeeds and the suite is 892 green in 21s. One run before that failed
`the server process is restarted under an open client` in `end-to-end.test.ts` on a 49s pass of the
suite - the same timing flake already recorded above, which passes alone and on a normal-speed run.
The server was booted by hand afterwards to check it still starts without the turn store: it does.

*Not demonstrated:* the phone. Whether the two buttons share the bar legibly at a real width, and
whether losing Answers is actually wanted once it is gone, are both device questions.

## The dead margin down the right-hand edge of the pane

Reported from the phone as "the padding on the right is too big", and then more precisely as a
cursor's width of padding for a scroll indicator. Both halves of that are right.

Measured off the screenshot rather than estimated: the terminal's ink runs x=0..662 of a 724px
image with nothing at all from 663 to 723. The key row's 0.25rem padding is 8px in that image, so
the scale is 1.842px/pt and the device is 393pt wide. 61px of image is 33pt of phone thrown away -
three and a half columns of a forty-column deck.

Two causes, both in the sizing pass, both found in source rather than guessed at.

**The addon reserves 14px and does not say so.** `FitAddon.proposeDimensions` computes
`scrollback === 0 ? 0 : options.overviewRuler?.width || 14` and subtracts it from the width before
dividing. This deck sets `scrollback: 5000` and draws no overview ruler, so 14 CSS pixels are
reserved for something that does not exist - and the reserve CANNOT be configured away, because
`0 || 14` is 14. `RULER_RESERVE` in `TerminalPane.vue` adds it back.

**The font size was floored to a whole pixel.** `Math.floor(current * (proposed.cols / COLUMNS))`.
A font one step below what fits is narrow on every one of forty columns, which on this phone is the
other 19pt. The size is now fractional.

That change breaks the old feedback loop, which is why the loop is gone. The cell width is measured
ONCE, at `MIN_FONT_SIZE`, and cached as a ratio: `proposeDimensions` reports whole columns, so the
cell width read back from it carries that floor's error, and the error is one column's share - at a
font that nearly fills the pane there are only 40 columns to share it over, which is the 1.5% that
made the old two-pass dance oscillate. At the smallest font there are a hundred-odd. Every later
rotation and keyboard open sizes in one pass off the cached ratio, so the probe's tiny text is a
single frame at mount, before any output exists to see it in.

The arithmetic moved to `src/client/pane-fit.ts` with `pane-fit.test.ts` beside it, for the reason
`key-row.ts` exists: it is a rule about numbers, and the alternative is running a browser-only
component on the host. There was NO test over any of this before.

The tests found two things I had asserted and was wrong about:

- I claimed the residual margin would be under 2px. It is under 5. The estimate of the cell width
  is deliberately the HIGH one - `(width - reserve) / cols` rather than a midpoint - because that
  makes the font too small rather than too large, and too large clips the fortieth column. The
  price is a residual of about one cell at the probe size, ~3px. The test states that bound and
  a second test holds that the columns never overflow.
- `width 744 advance 0.5` left 264px. That is `MAX_FONT_SIZE` doing its job on a landscape or iPad
  width, not a fit failure: 40 columns across 744px would be 18px cells. It has its own test now
  saying so, because it looks exactly like the bug and is not it.

*Accepted with a reason:* landscape keeps a wide right margin. The deck is 40 columns by decision
(`PANE_COLS`), and the alternative is text sized for a room. Not centred either - that would move
the text away from the edge a thumb rests on.

*Not demonstrated:* the phone. The 33pt was measured off a real screenshot and the arithmetic is
tested, but the ratio is measured through xterm's own layout, and whether it lands where the model
says is a device question. The number to compare against next time: text should reach x=723 of a
724px screenshot, not 662.

## Confirmed on the device: the key row and the pane's right-hand margin

Soya confirms on the phone that the Ctrl cap is on screen and the margin is gone. Both entries
above were written "not demonstrated"; this is the verification they were missing, and it is the
first of these rounds where the reasoning and the device agreed first time.

Worth keeping for the next one: the thing that made it agree was measuring the screenshot's pixels
instead of reading it. Two independent numbers came out of that - 33pt of dead width, and the key
row's 4pt padding as the scale reference - and both causes were then found in source rather than
guessed at. The three earlier scrollback rounds were all reasoned about and all wrong.

## PANE_COLS 40 -> 50, and the two copies of it that had to agree

Once the pane started using the full width, the font grew: the client sizes the font so the columns
fill the phone, which makes the column count the font-size control. 40 columns on a 393pt phone is
about 16px of text. Soya asked for smaller, so 50, which is about 13px there - close to what it
looked like before the margin was reclaimed, but now with ten more columns rather than dead space.

The change surfaced a defect that was already there. `PANE_COLS` lived in `hub.ts` and the client
wrote `const COLUMNS = 40` of its own, with NOTHING keeping them equal. Two constants that must
match and are not required to are the wrapping bug in waiting: a client rendering at a width the
pane is not is exactly what the scrollback rounds above were about. It now lives in `protocol.ts` -
browser-safe, type-only imports, already imported by the client - and both halves import it.

`pane-fit.test.ts` now takes `COLUMNS` from `PANE_COLS` too, so the properties are held at the
width the deck actually ships rather than at a number of the test's own.

That change made a test fail, which is the test working. "Flooring the font costs visible margin"
was pinned to one width, and what flooring costs is the fractional part of the size times the
column count - at 393px and 50 columns the fraction happened to be 0.05, so the cost was 1.5px and
the assertion that the OLD behaviour was bad became false. A test that a later constant change can
quietly turn into a tautology is worse than no test. It now takes the worst case over seven phone
widths, which is the actual claim.

*Consequence, not a defect:* scrollback written while the pane was 40 columns stays wrapped at 40.
tmux does not reflow, which is the whole reason the width is a constant, so existing history will
show short lines until it scrolls away. New output is 50.

*Needs a restart:* the pane width is applied by the server when it attaches, so `make restart` is
what moves live sessions to 50. The built client is already 50, so until then the client would
render 50 columns of a 40-column pane - reload the phone AFTER restarting, not before.

*Not demonstrated:* the phone. 13px at 50 columns is arithmetic, not an observation, and whether it
is the size Soya wanted is exactly the thing only the device answers.

## The pane width comes off the wire now, because two builds cannot be made to agree

Soya reported "the right-hand padding bothers me" on a screenshot, and the padding was not padding.
Measuring the screenshot rather than reading it - the method the earlier round wrote down - gave a
character pitch of 14.42px across a 724px screenshot, so the client was rendering 50 columns and
using the full width correctly. But the agent's own box border stopped at x=576, which is 40 of
those columns. `tmux -L agentdeck list-panes` confirmed it: the window was 40x34.

The cause is the previous entry's own "*Needs a restart:*" note, arriving as a defect. The server
process had started at 20:37 and the `PANE_COLS` 40 -> 50 commit landed at 21:28, so `dist/client`
was rebuilt at 50 while the running process still held its PTYs at 40. One constant in one file
was not enough, because the two halves are BUILT and RESTARTED separately: a shared constant makes
the source agree, not the two running programs.

So the server now states the width on the wire - `{ t: "hello", cols }`, sent to every socket the
moment it opens - and the client renders at that rather than at its own compiled copy. `PANE_COLS`
in the bundle is now only the value used before the first frame lands.

Three things about the shape, in case a later round wants to move it:

- Sent synchronously, and NOT folded into the `sessions` frame beside it. That frame is built from
  tmux and is allowed to fail; the failure is caught and logged. Carrying the width on it would let
  one failed capture-pane cost a client its width too, which presents as a blank-looking pane
  caused by something unrelated. There is a test for exactly that.
- Re-stated by every socket rather than once. The failing case is a server restarted at a different
  width under a page that has been open the whole time, and the reconnect is the only moment that
  can tell it. A width learned once would leave the tab wrong until a reload.
- Range-checked through `usablePaneCols`, the same treatment `ping`'s `intervalMs` gets and for the
  same reason: the client runs no parser over a server frame, and this value is handed to
  `terminal.resize`. Zero or NaN is a pane that renders nothing, produced by a server that answered
  wrongly rather than not at all.

*Verified live, server half:* a socket opened against the running deployment answers
`{"t":"hello","cols":50}` as its first frame, and the tmux window is 50x30 after `make restart`.

*Not demonstrated:* the phone, for the half that matters most. What a device would show is a pane
that re-renders at the new width on reconnect without a page reload, and the only way to see it is
to change `PANE_COLS`, rebuild, restart, and watch. The screenshot that started this round is the
proof the bug existed; there is no screenshot yet of it not existing.

*Residual, one transition wide:* a client built with this change against a server started before it
gets no `hello` and falls back to its compiled constant - which is today's bug, once, for whoever
is mid-upgrade. Nothing can close that from inside the protocol.

*Pre-existing and untouched:* `the reconnection ladder, against the real transport` fails under
full-suite load and passes when its file is run alone. Confirmed on a clean checkout before this
work, so it is a load flake this change neither caused nor fixed. 904 of 905 green.

---

## `test-concurrency`: the suite was oversubscribing the machine

The previous section recorded `the reconnection ladder, against the real transport` as a load flake
it neither caused nor fixed, at 904 of 905 green. It was not that one test. Two full runs failed
three tests between them and **no test failed twice**: `supervisor-crash`'s "the node process is
killed and nothing brings it back", `toolchain`'s "the lint script passes on the current tree", and
`end-to-end`'s "the server process is restarted under an open client", the last timing out after 30
seconds waiting for a socket to reconnect to a server that was already listening. A failure that
moves is not a defect in the test it lands on.

`node --test` defaults its worker count to the core count, ten on this machine. Most of these
suites spawn a real server, a real tmux and real ptys, so ten workers is far more than ten
processes, and the tests that assert something happens **within a wall-clock window** are the ones
that lose. `src/client/end-to-end.test.ts` run alone is 13 of 13 green in 19 seconds at 8% CPU: it
is almost entirely waiting, which is exactly the shape that starves.

Capping the run at four workers fixes it and is also faster, because ten workers were spending the
difference on contention:

| | result | duration |
| --- | --- | --- |
| default (10) | 902/905, then 904/905, different tests each time | 49.4s |
| `--test-concurrency=4` | 905/905, three consecutive runs | 35.7s, 35.7s, 35.8s |

*What was changed:* one flag in `package.json`'s test script. **No test file's logic, and no
timeout, was touched** - the starvation is removed rather than waited out. `src/toolchain.test.ts`
pinned the script by exact string, which is the mechanism-not-property mistake CLAUDE.md warns
about; it now matches the runner and the glob, and asserts the cap separately with the reason.

*Verified:* three consecutive full-suite runs at 905/905, plus `pnpm typecheck` and `pnpm lint`.

*Not demonstrated:* that four is the right number rather than merely a sufficient one. It was the
first value tried and it was green three times; nothing was measured at 2, 6 or 8. The assertion
allows anything at or below four, so lowering it needs no test change and raising it does.

*Residual, and the reason the cap is asserted rather than just set:* this is a property of the
machine the suite runs on, and the number that is right for a ten-core Mac is not obviously right
for a two-core CI runner, where four workers may oversubscribe just as badly. CI has not been
observed under this change. If the same moving-failure pattern appears there, the answer is a lower
cap, not a longer timeout - and the next person to see a flaky wall-clock test here should suspect
this before suspecting the test.

## A root the server rescans, so a clone is startable without a restart

`make start` computed `AGENTDECK_MOUNTS` from `ghq list -p` **once**, at boot. A repository cloned
afterwards was refused with a message telling the operator to restart - and a restart is the one
action that costs every running agent its hook secret, so the cheap-sounding fix for "I just
cloned something" was the expensive one. `AGENTDECK_ROOTS` names directories to walk instead, and
`CwdAllowlist.paths` walks them on every read, cached for a second.

*What was changed:* `src/repo-scan.ts` (new) walks each root to depth 4 and returns every directory
holding a `.git`. `CwdAllowlist` takes roots alongside the fixed mounts and unions them; `allows`,
`refusal` and `list` are unchanged in shape. `src/server.ts` reads `AGENTDECK_ROOTS`, warns when
both sources are empty, and reports the startable count at boot rather than the mount count. The
`Makefile` passes `ghq root --all`. The refusal now offers the free way out first.

*Membership stays exact.* A root is where to look for repositories, not a prefix anything under it
inherits: `/roots`, `/roots/owner` and `/roots/owner/repo/src` are all refused. The only paths that
become startable are the ones the scan returns.

*Verified by hand, not from green.* A second server on 7788 with its own tmux socket: `POST
/api/sessions` for a directory that did not exist was refused with the new message; the directory
was then created with that same process still running, and the next `POST` started a real tmux
session in it. `GET /api/cwds` listed all eleven `ghq` repositories including one cloned minutes
earlier. 923/923 suite, typecheck and lint green.

*Not demonstrated:* the phone. The picker already re-fetches `/api/cwds` every time the sheet
opens, so a clone should appear at the next tap, but that was checked over loopback with `curl` and
not on the device. Nor was a root with hundreds of repositories: the picker is an unbounded list of
rows and eleven of them says nothing about two hundred.

*Accepted, with the reason:* the allowlist is now open at one end. Anything that appears under a
root with a `.git` in it is startable, so an agent can `mkdir -p ~/ghq/x/y/.git` and make itself a
new place to start. That is a smaller change than it reads as - an agent already runs as the
operator with the whole machine in reach, and the allowlist has always bounded where a session
*starts*, not where it can go - but it is a real widening of what the token can do with no
filesystem write of its own. Symlinks are not followed, which closes the version of this where a
link under the root makes `/` startable while reading as an ordinary clone. Plan 008's separate
account does not change this either: agents would go on sharing a uid with each other.

*Open, and the operator's to close:* `scripts/watchdog.mjs` still lists `AGENTDECK_MOUNTS` in
`REQUIRED_ENV`, and `scripts/com.agentdeck.watchdog.plist` still sets it. Both are host-executed
and were left alone. An installed watchdog therefore refuses to start a server configured with
roots only. The watchdog is not installed, so nothing is broken today; the README says so rather
than leaving it to be found.

## The watchdog identified its own server by a shape nothing on this Mac produces

Preparing the LaunchAgent for a real install turned up a defect that made the whole thing inert.
`isOurServer` required the `ps` line to contain node's absolute path AND the absolute path of
`src/server.ts`. Every server an operator has ever started here - `make start`, `make restart`,
`pnpm start` - reports as `node --env-file-if-exists=.env src/server.ts`, relative on both counts.
Only a server the watchdog itself had spawned could match.

*Measured on the live deck, before and after, with the notifier stubbed.* The version at HEAD, given
a fully populated environment:

```
port 7777 is held by pid 22488, which is not agentdeck
  it is running: node --env-file-if-exists=.env src/server.ts
  and tailscale serve is publishing that port on the tailnet
exit 1
```

plus a critical modal telling the operator a stranger was published on their tailnet. That is every
pass, forever: exit 1 before the probe, no supervision, and a false security alert about the deck
itself. After the fix, same server, same environment: `node process 22488 holds it` /
`/api/health answered 200 in 16ms` / exit 0.

*What was changed:* `isOurServer` now accepts a second shape - argv[0] whose basename is `node`,
some token that is or ends in `src/server.ts`, and that token resolving against the PROCESS'S OWN
working directory (read with `lsof -d cwd`) to this checkout's server. The absolute shape is still
matched first and unchanged. `REQUIRED_ENV`'s first entry became the pair
`AGENTDECK_MOUNTS`/`AGENTDECK_ROOTS`, either satisfying it, so a roots-only plist is recoverable.
The plist declares `AGENTDECK_ROOTS`, `AGENTDECK_REPO`, and points `ProgramArguments` at
`~/.agentdeck/bin/watchdog.mjs` rather than at the checkout.

*The cwd is what keeps this narrow.* Without it the relative form has no checkout in its argv, so a
second agentdeck - a worktree, a second clone, a test run - would be adopted, stopped and restarted
by this one. Asserted as its own test rather than left as a comment. A stranger on the port is
still a squatter, still neither killed nor blessed, also now asserted: that path had no test at all.

*A test that measured the machine was replaced.* `nothing loaded it: this repository installs no
LaunchAgent` probed `~/Library/LaunchAgents` and `launchctl list`, so it went red the moment the
operator did what the README instructs, and it would have stayed green against an agent that
installed the job under another label. It now asserts the property that matters and is actually
this repository's: no `package.json` script, no mise task and no file in `scripts/` runs
`launchctl bootstrap|load|enable|kickstart`. This is the same mistake CLAUDE.md already records
about a test that probed the operator's real `ts.net` name.

*Verified:* 928/928, typecheck, lint, `plutil -lint`, and the two live passes above.

*Not demonstrated, and it is the important half:* launchd. Nothing has been installed - no plist in
`~/Library/LaunchAgents`, nothing in `launchctl list`, no watchdog log in `~/Library/Logs`. The
timer firing, `RunAtLoad`, and recovery after a reboot remain exactly as undemonstrated as they
were, because `launchctl` is the operator's to run. What is demonstrated is one pass, by hand,
against the real server.

*Residual, unchanged by any of this:* the copy at `~/.agentdeck/bin` buys review scope, not write
protection - it and the mise node are both writable by this uid - and the watchdog still spawns
`src/server.ts` from the checkout, so a recovery executes agent-writable code as the operator
either way. Installing it also means every later edit to `scripts/watchdog.mjs` must be copied
across by hand or the timer keeps running the old one; that re-copy IS the gate, and it is a
standing way for the two to drift apart silently.

## The suite was leaking tmux servers, and a reaper for what outlives a session

Started from an operator report that `python` and `esbuild` keep running after a task ends and hold
CPU and memory. Those processes had already been killed by hand before anything could look at them,
so that specific case is undiagnosed and stays undiagnosed. Looking for them turned up a different
leak that was measurable on the spot.

*What was actually there.* 236 abandoned tmux servers, all `ppid 1`, the oldest over two days old,
every one of them holding **zero** sessions, 325MB of RSS between them, beside 3233 socket files in
`/private/tmp/tmux-501`. They are agentdeck's own test suite. `first-run-qr.test.ts` and
`serve-client.test.ts` boot a real server with `TMUX_SOCKET` set; the server sets `exit-empty off`,
which is what keeps a tmux holding no sessions alive; and both `after()` hooks killed the node
process and never the tmux server. Every other tmux-using test file in the repository
(`snapshot`, `host-boundary`, `sync-crash`, `supervisor-crash`, `tailnet`, `de-containerise`) calls
`kill-server`. Two files did not, at two per run, for 118 runs.

Honest about the symptom it does not explain: those 236 processes sit at 0.0% CPU. They are a memory
and file-descriptor leak, not the CPU burn that prompted the report.

*Fixed*, with the `after()` hooks each killing their socket's server, and a guard in
`toolchain.test.ts` asserting that every test file naming a `TMUX_SOCKET` also kills one. The guard
was checked by reintroducing the bug and watching it go red, and the fix by counting tmux servers
before and after a run of both files: 27 pass, delta 0, where the old code gave delta 2. The guard is
source-level because each test worker owns its own sockets, so nothing inside one worker can count
what another leaked.

*The reaper*, `scripts/reap.mjs`, collects three classes: orphaned processes that were working under
a root, tmux servers in the `agentdeck-*` namespace holding no sessions, and socket files with
nothing behind them. It reports by default; `--kill` is a separate word, and `make reap-kill` a
separate target, so acting is always typed on purpose.

*The predicate came from a reproduction, not from reasoning.* A pane was started, three pythons
launched inside it, and the pane killed. The plain `&` ones died with the pane; only the `nohup` one
survived, as `ppid 1` with no controlling terminal. That is the shape - but `ppid 1` and no terminal
on their own describe every launchd daemon on this machine, `endpointsecurityd` and `automountd`
among them, so **the root test is the whole safety argument** and the tool exits 2 rather than run
without one.

*The dry run earned its keep on the first pass.* Among the candidates was `pnpm dev`, 17 hours old,
`ppid 1` because the terminal that started it had closed, cwd under a root - with `turbo`, `vite`,
`wrangler` and an `esbuild` service alive underneath it. Every condition called it garbage. A tool
that killed by default would have killed a working dev server on its first run. The exemption added
for it is that a process whose SUBTREE holds a listening socket is serving something, judged over
the tree because the listener is two levels below the process being judged.

*Two defects were found in the tool by running it rather than reading it.* A pass took 14.6 seconds,
because the cwd of every candidate was one `lsof` each; batched into a single `-Fpn` call over all
pids it is 0.84 seconds, with an identical verdict. And `lsof` failing was indistinguishable from
"nothing is listening", which silently switched OFF the dev-server exemption - on a loaded machine,
which is exactly when `lsof` is slow and when there is most to lose. It now returns `null` for "could
not ask" and abandons the whole class rather than guess, saying so in the output and in `--json`.

*What this does not do, and will not.*

- **The reported symptom is not covered.** A `python` still running as a descendant of a LIVE claude
  session has a living parent, so no condition here matches it, and none can: agentdeck cannot tell a
  long-running process an agent started on purpose from one it forgot about. Only the orphaned shape
  - the session or pane is gone, the process is not - is collectable. Whether the operator's case was
  that shape is unknown, because it was killed before it could be looked at.
- **An orphan that changed directory out of the roots is missed.** Measured on the reproduction's own
  fixture, whose cwd was a scratch directory: the reaper would not have touched it. This is the
  deliberate direction of the trade - the alternative to the root test is signalling system daemons.
- **The tmux half only sees the `agentdeck-*` namespace**, so a leaked server on any other socket
  name is invisible to it. It is also never the live `TMUX_SOCKET`, whatever that socket holds.
- **Nothing is installed on a timer.** It is a command. Wiring it into the watchdog would make an
  unattended job kill processes as the operator, which is the opposite of the decision recorded for
  the port squatter ("Not restarting and not killing it - that is your call"), and reversing that is
  a person's call and a plan, not a side effect of this work.
*The new suite had to be paid for, and the first version was too expensive.* `ps` reports elapsed
time in whole seconds, so a fixture is zero seconds old for its first second and no age bound above
zero can match it - without a wait the cases pass by finding nothing. One wait per case made the file
14 seconds long, and the full run went from one failure to six, all of them in the wall-clock-bound
`watchdog` and `supervisor-crash` suites. That is precisely the starvation this repository already
capped `--test-concurrency` for. Rebuilt with one root and one socket namespace PER CASE - so cases
cannot destroy each other's fixtures and their order is free - the fixtures are built once and
waited for once, and the file is 6 seconds.

*Verified:* the reproduction above, the before/after tmux counts, the guard red then green, 10/10 in
`reap.test.ts`, the dry run against the live machine, and three full runs measured against a
pre-change baseline:

| | tests | pass | fail | failing case | duration |
| --- | --- | --- | --- | --- | --- |
| before these changes | 928 | 927 | 1 | `the reconnection ladder, against the real transport` | 49.3s |
| after, run 1 | 939 | 938 | 1 | the same one | 49.2s |
| after, run 2 | 939 | 938 | 1 | the same one | 49.3s |

The one failure is the load flake the `test-concurrency` entry above already records as neither
caused nor fixed there; it fails identically without any of this work in the tree, so this is eleven
tests added at no measurable cost. It is still a failing suite, and it is still not green.

*Nothing was reaped on this machine.* The 236 servers, the 2979 dead socket files and the four
orphans are all still running, for the operator to point `make reap-kill` at.

## The reaper on a timer, and the classes the operator widened it to

Follow-up to the entry above, all of it the operator's decision after seeing what the first version
refused to touch. Three widenings and one new view, in one pass of work.

*A dev server is garbage now.* The exemption that spared a tree holding a listening socket was the
thing the first dry run was built around - it is what stopped a working `pnpm dev` being killed. The
operator's answer was that a dev server does not need to be running, so it is off by default and
`AGENTDECK_REAP_SPARE_LISTENERS=1` puts it back. The measured consequence on this machine: that
`pnpm dev` moved from spared to a 16-process, 1.5GB tree on the list.

*Trees, not roots.* Signalling only the top of an orphan reparents its children to launchd, where
they look like fresh orphans and survive until some later pass catches them. `pnpm dev` is four
levels deep - turbo, then vite and wrangler, then an esbuild service - so "kill the orphan" was
collecting one process out of sixteen. It now signals the whole subtree, deepest first.

*What a LIVE agent started.* The class the first version called impossible, and it is still
impossible to do *correctly* - nothing can tell a process an agent started on purpose from one it
forgot about. The operator chose to over-collect. The pane process is never signalled, because on
this deck that IS the agent and killing it ends the session; everything below it is, which on this
machine means an agent's `@playwright/mcp` servers die once an hour and the session loses them until
it starts them again. That is accepted, not overlooked. `AGENTDECK_REAP_PANE_CHILDREN=0` turns it
off.

*The premise for that class was half wrong, and checking it changed the design.* The operator's
words were that everything attached to tmux is effectively something claude started through
agentdeck. True of agentdeck's own socket: its one pane's process IS `claude`, forked by the deck's
tmux server. Not true of tmux: the operator's personal tmux on the DEFAULT socket had five sessions
- `agentdeck`, `arukutomaru-store`, `blogs`, `cloudflare-os`, `zenn` - of their own shells. A
literal reading would have killed all of them. The class is bounded to `-L ${TMUX_SOCKET}` and
nothing else.

*On a timer, gated by the server rather than by launchd.* `AGENTDECK_REAP_INTERVAL_MS`, default one
hour, announced on boot because it kills processes and a silent one would be indefensible; `0` turns
it off. The deck is the gate the operator asked for - "while the node server is running" - and it
needs no install step, which matters because the watchdog's LaunchDaemon is still not installed.
Passes never overlap: a pass that outlives its interval would have a second one signalling the same
pids, and the second's "SURVIVED" would be the first's grace period.

*`GET /api/processes` and a `Processes` panel*, so what a session is running can be seen before it
is collected. The deck is the only thing on this Mac that knows which pane belongs to which session,
which is why it is a route and not a `ps` someone runs. Closed by default and read on demand - it
costs a whole-machine `ps` per call. The count and size shown are of what is BELOW the pane, not the
tree: an idle agent holding 800MB is what the session IS, and including it would make every session
look like the worst offender.

*Three defects, each found by running the thing rather than reading it.*

- **A killed pane child became a zombie and was reported as SURVIVED.** Its parent is deliberately
  left alive and a `/bin/sleep` parent never calls `wait`, so `kill(pid, 0)` kept succeeding. A
  zombie holds no memory and runs nothing; reporting it as a survivor is a false alarm about the one
  thing this output exists to tell an operator. Both the tool and its tests now read `ps -o state=`.
- **The test fixture for that class was killing itself.** `sh -c 'sleep & wait'` returns as soon as
  its child dies, so the case failed claiming the pane had been reaped while the report directly
  above the assertion showed it had not. `exec` after backgrounding models the real thing: an agent
  outlives its MCP server.
- **A `tsc`-only failure that `node --test` cannot see.** `assert.deepEqual(said, [])` narrows the
  array to `never[]` for the rest of the function, so the next `push` stops compiling while the test
  still runs green. Worth naming because the suite passing is not the same as the tree compiling.

*Verified:* 12/12 in `reap.test.ts`, 6/6 in `reap-schedule.test.ts` including a real server booting,
reaping a real orphan and saying so, 11/11 in `processes.test.ts` including the route and one pass
against the real `ps`, plus the dry run on the live machine that produced the numbers above.

*Not demonstrated.* The panel has been type-checked and built but **not seen on the phone**, and
this repository's own history says that is where the defects are - the dead key row, the missing
session picker. The hourly pass has not been observed on the live deck either: the running server is
still the old build, deliberately not restarted, so nothing here has yet killed an MCP server in
anger. Both need a person.

## `make up`, and closing a session ending what it was running

*`make up` / `make down`.* The watchdog is one pass and launchd is what repeats it, but nothing in
this repository may run `launchctl` - that is plan 006's decision and `watchdog.test.ts` asserts it
against `package.json`, `mise.toml` and every file in `scripts/`. So `up` is a loop: a pass every
`AGENTDECK_WATCHDOG_EVERY` seconds for as long as it lives, pid in `~/.agentdeck/watchdog-loop.pid`,
output appended to `~/Library/Logs/agentdeck-watchdog.log`. It does NOT survive a reboot or a
logout. That is the whole difference between this and the LaunchDaemon, and it is said out loud
rather than left to be discovered.

No separate server start: a pass against a port with nothing on it starts one, so bringing up the
supervisor brings up the deck through the same path that will recover it later. `.env` is sourced
into the LOOP rather than only into a server, because `startServer` spawns `src/server.ts` with no
`--env-file` - a server the watchdog recovers inherits the loop's environment, and without this it
would come back with no `AGENTDECK_PROFILES` and no `AGENTDECK_ORIGIN`.

`down` stops the loop first and the server second. The other order is the watchdog dutifully
restarting what was just stopped, sixty seconds later, which presents as `make stop` being broken -
so `stop` now prints a loud line when the loop is running.

*Verified on the live machine, without disturbing it.* `make up` adopted the running server:
`node process 22488 holds it` / `/api/health answered 200 in 15ms`, no restart. The `stop` warning
and `down` were exercised with `PORT=59999` so the real server was never a target; the loop stopped,
the pidfile was removed, and 22488 was still answering afterwards.

*Closing a session now ends its process tree.* `kill-session` kills the pane process and SIGHUPs its
foreground group; anything detached is reparented to launchd and runs forever. That is the
reproduction from the entry above - of three pythons started in a pane, the two plain background
ones died with it and the `nohup` one was still there days later - and it is the operator's original
complaint. Pressing Close on the phone is an unambiguous "I am done with this", so `Tmux.kill` reads
the pane trees BEFORE killing the session (afterwards nothing connects those pids to it) and ends
them deepest-first. This is the path where that case is actually solved; the hourly reaper is not.

*A prefix-matching hazard, found by testing the target rather than trusting it.* The first version
asked `list-panes -t =<id>`. `=` is an exact target for `kill-session` - the codebase measured that
and `exactTarget` exists for it - but **not** for `list-panes`: on tmux 3.7b with `alpha` and
`alphabet` on one socket, `list-panes -s -t =alp` returns alpha's pane. Since that list feeds a
kill, a target resolving by prefix would end a different agent's processes. It now enumerates every
pane on the socket and filters by an exact string match on `#{session_name}`, which is immune to
tmux's target resolution entirely. Both halves are asserted, the second with two sessions whose
names are a prefix pair.

*Verified:* 52/52 in `tmux.test.ts`, and the new case checked by neutering the tree kill and
watching `a detached grandchild is killed` go red before restoring it.

*Open, and it changes a decision already taken.* Claude Code's documentation is explicit that
**stdio MCP servers are not reconnected automatically** - only HTTP and SSE servers are, with
backoff. `@playwright/mcp` is stdio. So the hourly pane-children pass does not merely interrupt an
agent's MCP server, it removes it until a person opens `/mcp` and retries. That was accepted on the
understanding that it would come back; it does not. Recorded here rather than silently reversed,
because the decision to over-collect was the operator's to make and so is the decision to keep it.

## MCP servers: spared by the timer, taken by Close

The operator's split, after the finding at the end of the entry above: the timed pass leaves MCP
servers alone, pressing Close takes them.

*Why the split is the right one.* Claude Code's documentation is explicit that stdio MCP servers are
not reconnected automatically - only HTTP and SSE servers are, with backoff - and `@playwright/mcp`
is stdio. So an hourly pass taking one does not interrupt a tool, it removes it until a person opens
`/mcp` and retries. Closing a session is a person saying they are done with the whole session, and
carries no such cost.

*How they are recognised, and how weak that is.* `AGENTDECK_REAP_KEEP`, a case-insensitive pattern
against the command line, defaulting to `mcp|modelcontextprotocol`. A name match: an MCP server
whose command says neither string is not recognised, and a process that merely has one of them in
its path is spared for the wrong reason. An unusable pattern falls back to the default rather than
sparing nothing, because "keep nothing" is the direction that silently widens what gets killed.

*Considered and not taken:* sparing by AGE instead - MCP servers start with the session, so on the
live deck the pane was `1d 00:33:43` old and its MCP `1d 00:33:42`, one second apart, while a
leftover from a finished task is much younger. Structurally better than a name. Rejected because a
tool that kills things should be predictable to the person reading its output, and "it spared that
because the name says mcp" is explainable in a way "it spared that because it started within N
seconds of the pane" is not. Recorded so the option is not lost.

*What is spared is printed*, not silently skipped: a pass that says nothing about what it left
behind cannot be told from one that never looked.

*Measured on the live deck, and it corrected an assumption in the entry above.* The operator closed
`project-a-claude-7fb1bc8d` while the OLD build was still running - the one with no tree kill. All
three processes were gone afterwards: the pane, `npm exec @playwright/mcp`, and the
`playwright-mcp` node under it, with nothing playwright-shaped left anywhere on the machine. **MCP
servers were never the leftover problem.** They are ordinary children of the agent, connected by
pipes, so the agent exiting closes their stdin and a stdio server shuts itself down; SIGHUP reaches
the foreground group as well. What survives a close is what was DETACHED - the `nohup` case the
reproduction found - which is what the tree kill is for. The previous entry implied the tree kill is
what saves MCP cleanup on close; it is not, and both are true independently.

*Two defects in the new test, both worth recording because both passed silently in one direction.*

- **The fixture SIGKILLed the whole suite.** `strays.push(keep.plain, keep.mcp)` sat beside its
  declaration rather than after the fixture ran, so both were still `0`, and `process.kill(0, ...)`
  signals the caller's entire process group. Every case passed and the run died with no summary and
  nothing marked failed - the worst shape a test failure can take. `scripts/reap.mjs` guards `pid > 1`
  for exactly this reason and the test did not.
- **macOS SIGKILLs a copied system binary.** The first fixture made an "MCP-looking" process by
  copying `/bin/sleep` to a file named `playwright-mcp`; the copy has no valid signature and the
  kernel kills it on exec, so the child never existed and the case failed for a reason that had
  nothing to do with the code. Verified directly: `cp /bin/sleep ./playwright-mcp && ./playwright-mcp 1`
  exits 137. The marker is now a real argv entry instead.

*Verified:* 13/13 in `reap.test.ts`, with the new case checked by disabling the KEEP filter and
watching it go red before restoring it.

## Processes moved into the New session bar

*The panel was in the wrong place, and the reason is not taste.* Its toggle sat at the bottom edge
between the panes and the key row - as far from the session-level actions as this layout allows -
while what it answers ("what is this machine still running") is the same level as starting a
session. The toggle is now the third control in the New session bar and the list hangs below that
bar as a sheet, the same shape the picker already uses.

*Open state moved from `ProcessList` to `App`*, because the button and the panel are no longer one
element. The collapsed default existed to keep `GET /api/processes` - a `ps` of the whole machine -
off the hot path; that property is preserved differently, by `v-if` on the component, so it reads
once on mount and is not mounted at all while closed.

*Not demonstrated on a phone, and this is a layout change.* `961/961` green, `pnpm build` clean, the
server serves the new bundle hash and `/api/processes` answers - but no client component in this
repo is ever mounted in a test, so nothing here has rendered the bar. Two things a device decides
and this machine does not: whether three controls plus `New session` still fit at 40 columns without
the toggle's `flex: 1 1 0` collapsing its label, and whether the sheet clears the notch (it carries
`--safe-right`/`--safe-left`, not `--safe-bottom`, because the key row is still below it).

*A restart was spent to serve the new build*, and the deck was already running when it happened.
Every session that was live lost its hook secret, so `waiting` detection is dead for those agents
until each is restarted - the known cost of `make restart`, recorded here because it was paid
without being asked for.
