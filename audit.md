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
bind-mounted into the container that runs agents**, so anything in the tree that the *host* later
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
