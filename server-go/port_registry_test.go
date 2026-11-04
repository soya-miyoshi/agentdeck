package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Port of src/registry.test.ts, src/hub.test.ts, src/create-500.test.ts, src/sync-crash.test.ts,
// src/stream.test.ts, src/ring-buffer.test.ts and src/protocol.test.ts.

// ---- a tmux stand-in that models sessions, so create/list/kill are exercised as a whole

type regFakeSession struct {
	dead    bool
	status  string
	created int64
	path    string
}

type regFakeState struct {
	mu       sync.Mutex
	sessions map[string]*regFakeSession
}

type regFake struct {
	t     *testing.T
	state *regFakeState
	tmux  *Tmux
	// mode applies to list-sessions calls once failAfter more of them have been answered normally.
	mode      string
	failAfter int
	lists     int
	onRefresh func()
}

func regTmuxErr(stderr string) error {
	return &TmuxError{Stderr: stderr, Err: errors.New("exit status 1")}
}

// regNewFake builds a fake over state; passing an earlier fake's state is a server restart.
func regNewFake(t *testing.T, state *regFakeState) *regFake {
	if state == nil {
		state = &regFakeState{sessions: map[string]*regFakeSession{}}
	}
	f := &regFake{t: t, state: state, mode: "ok"}
	f.tmux = &Tmux{Socket: "test"}
	f.tmux.exec = f.exec
	return f
}

func (f *regFake) fail(mode string, after int) {
	f.state.mu.Lock()
	f.mode, f.failAfter, f.lists = mode, after, 0
	f.state.mu.Unlock()
}

func regArg(rest []string, flag string) string {
	for i, a := range rest {
		if a == flag && i+1 < len(rest) {
			return rest[i+1]
		}
	}
	return ""
}

func (f *regFake) exec(_ context.Context, args []string, _ map[string]string) (string, error) {
	verbs := []string{"list-sessions", "new-session", "kill-session", "display-message", "capture-pane", "list-clients", "refresh-client", "list-panes"}
	verb, rest := "", args
	for _, v := range verbs {
		for i, a := range args {
			if a == v && verb == "" {
				verb, rest = v, args[i+1:]
			}
		}
	}
	s := f.state
	s.mu.Lock()
	switch verb {
	case "display-message":
		target := strings.TrimSuffix(strings.TrimPrefix(regArg(rest, "-t"), "="), ":")
		found := s.sessions[target]
		s.mu.Unlock()
		if found == nil {
			return "", regTmuxErr("can't find pane")
		}
		return fmt.Sprintf("%s%s%d\n", found.path, sep, found.created), nil
	case "list-sessions":
		f.lists++
		failing := f.mode != "ok" && f.lists > f.failAfter
		if failing && f.mode == "list-throws" {
			s.mu.Unlock()
			return "", errors.New("tmux is not answering this call")
		}
		if failing || len(s.sessions) == 0 {
			s.mu.Unlock()
			return "", regTmuxErr("no sessions")
		}
		var lines []string
		for id, x := range s.sessions {
			dead := "0"
			if x.dead {
				dead = "1"
			}
			lines = append(lines, strings.Join([]string{id, dead, x.status, strconv.FormatInt(x.created, 10), x.path}, sep))
		}
		s.mu.Unlock()
		return strings.Join(lines, "\n") + "\n", nil
	case "new-session":
		id := regArg(rest, "-s")
		// `-A` keeps an existing session and its creation time.
		if s.sessions[id] == nil {
			s.sessions[id] = &regFakeSession{created: time.Now().Unix(), path: regArg(rest, "-c")}
		}
	case "kill-session":
		target := regArg(rest, "-t")
		if !strings.HasPrefix(target, "=") {
			f.t.Errorf("kill target must be exact, got %s", target)
		}
		delete(s.sessions, strings.TrimPrefix(target, "="))
	case "capture-pane":
		s.mu.Unlock()
		return "history\n", nil
	case "list-clients":
		s.mu.Unlock()
		return "/dev/ttys010\n", nil
	case "refresh-client":
		s.mu.Unlock()
		if f.onRefresh != nil {
			f.onRefresh()
		}
		return "", nil
	}
	s.mu.Unlock()
	return "", nil
}

func (f *regFake) die(id, status string) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if x := f.state.sessions[id]; x != nil {
		x.dead, x.status = true, status
	}
}

func (f *regFake) plant(id, path string) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	f.state.sessions[id] = &regFakeSession{created: 1_700_000_000, path: path}
}

func (f *regFake) has(id string) bool {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	return f.state.sessions[id] != nil
}

func (f *regFake) ids() []string {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	out := []string{}
	for id := range f.state.sessions {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func regRegistry(t *testing.T, f *regFake, profilesJSON string, mounts ...string) *Registry {
	t.Helper()
	profiles, _ := parseProfiles([]byte(profilesJSON))
	r, err := newRegistry(f.tmux, profiles, newAllowlist(mounts, nil), "test-secret-key")
	if err != nil {
		t.Fatal(err)
	}
	return r
}

const regProfiles = `{"claude":{"command":"/bin/sh","name":"Claude Code"},"gemini":{"command":"/bin/sh","name":"Gemini CLI"}}`

func regBuild(t *testing.T, state *regFakeState) (*Registry, *regFake) {
	f := regNewFake(t, state)
	return regRegistry(t, f, regProfiles, "/workspace/agentdeck", "/workspace/web"), f
}

var regCtx = context.Background()

func regCreate(t *testing.T, r *Registry, cwd, agent string) *CreateResult {
	t.Helper()
	res, err := r.Create(regCtx, cwd, agent)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func regList(t *testing.T, r *Registry) []Session {
	t.Helper()
	l, err := r.List(regCtx)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestRegistry_Adoption(t *testing.T) {
	t.Run("the survivor is listed again, with the cwd and agent recovered from tmux", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "gemini").Session
		restarted, _ := regBuild(t, f.state)
		l := regList(t, restarted)
		if len(l) != 1 || l[0].ID != s.ID || l[0].Cwd != "/workspace/agentdeck" || l[0].Agent != "gemini" || l[0].Name != "agentdeck" {
			t.Fatalf("adopted: %+v", l)
		}
	})

	t.Run("its waiting detection SURVIVES the restart, because the secret is derived", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		restarted, _ := regBuild(t, f.state)
		if l := regList(t, restarted); l[0].WaitingDetectionLost {
			t.Fatal("the tab was muted by a restart")
		}
		if !restarted.SecretMatches(s.ID, secretFor("test-secret-key", s.ID)) {
			t.Fatal("the restarted process cannot authenticate the hook its own agent will send")
		}
		if restarted.SecretMatches(s.ID, "any-secret-at-all") {
			t.Fatal("the wrong secret was accepted")
		}
	})

	t.Run("an agent holding a secret from before derivation is reported as muted, not as healthy", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		restarted, _ := regBuild(t, f.state)
		if regList(t, restarted)[0].WaitingDetectionLost {
			t.Fatal("muted before any hook was refused")
		}
		if restarted.SecretMatches(s.ID, "a-secret-from-the-old-scheme") {
			t.Fatal("an old secret was accepted")
		}
		if !regList(t, restarted)[0].WaitingDetectionLost {
			t.Fatal("a session whose hooks are refused is still reported as able to report waiting")
		}
	})

	t.Run("recreating it reattaches to the same agent and the hook path still works", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		restarted, _ := regBuild(t, f.state)
		again := regCreate(t, restarted, "/workspace/agentdeck", "claude")
		if !strings.Contains(again.Warning, "already running") {
			t.Fatalf("this was not the reattach path: %q", again.Warning)
		}
		if again.Session.WaitingDetectionLost {
			t.Fatal("reattach marked the session muted")
		}
		if !restarted.SecretMatches(s.ID, secretFor("test-secret-key", s.ID)) {
			t.Fatal("the derived secret is refused after a reattach")
		}
	})

	t.Run("a session outside the allowlist is not adopted, however it is named", func(t *testing.T) {
		r, f := regBuild(t, nil)
		f.plant(sessionID("/", "claude"), "/")
		f.plant(sessionID("/home/someone", "claude"), "/home/someone")
		if l := regList(t, r); len(l) != 0 {
			t.Fatalf("a session off the allowlist became a tab: %+v", l)
		}
		restarted, _ := regBuild(t, f.state)
		if l := regList(t, restarted); len(l) != 0 {
			t.Fatalf("listed after restart: %+v", l)
		}
		if len(f.ids()) != 2 {
			t.Fatal("the server killed sessions it refuses to list")
		}
	})

	t.Run("an allowlisted session whose name is not one of ours is left alone", func(t *testing.T) {
		r, f := regBuild(t, nil)
		f.plant("agentdeck-claude-deadbeef", "/workspace/agentdeck")
		f.plant(sessionID("/workspace/agentdeck", "codex"), "/workspace/agentdeck")
		f.plant(sessionID("/workspace/web", "claude"), "/workspace/agentdeck")
		if l := regList(t, r); len(l) != 0 {
			t.Fatalf("adopted: %+v", l)
		}
	})

	t.Run("a session tmux reports with no path at all is not adopted", func(t *testing.T) {
		r, f := regBuild(t, nil)
		f.plant(sessionID("", "claude"), "")
		if l := regList(t, r); len(l) != 0 {
			t.Fatalf("adopted: %+v", l)
		}
		if len(f.ids()) != 1 {
			t.Fatal("the server killed a session it refuses to list")
		}
	})

	t.Run("an adopted corpse is listed as exited, and reap at boot leaves it alone", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		restarted, _ := regBuild(t, f.state)
		f.die(s.ID, "exited")
		if l := regList(t, restarted); l[0].State != StateExited {
			t.Fatalf("state %s", l[0].State)
		}
		if reaped, err := restarted.Reap(regCtx); err != nil || len(reaped) != 0 {
			t.Fatalf("reap killed a corpse this process did not start: %v %v", reaped, err)
		}
		if len(regList(t, restarted)) != 1 {
			t.Fatal("the adopted corpse was destroyed")
		}
	})

	t.Run("restarting the AGENT clears a loss that was detected", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		restarted, _ := regBuild(t, f.state)
		regList(t, restarted)
		restarted.SecretMatches(s.ID, "a-secret-from-the-old-scheme")
		if !regList(t, restarted)[0].WaitingDetectionLost {
			t.Fatal("the refused hook did not mark the session")
		}
		if err := restarted.Close(regCtx, s.ID); err != nil {
			t.Fatal(err)
		}
		fresh := regCreate(t, restarted, "/workspace/agentdeck", "claude")
		if fresh.Session.ID != s.ID {
			t.Fatal("the id is not stable across the agent restart")
		}
		if fresh.Warning != "" {
			t.Fatal("this was a reattach, not a fresh process")
		}
		if fresh.Session.WaitingDetectionLost || regList(t, restarted)[0].WaitingDetectionLost {
			t.Fatal("a freshly started agent is still reported as having lost its hook path")
		}
	})

	t.Run("a corpse from before the restart survives reap at boot, and a human can still close it", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		f.die(s.ID, "1")
		restarted, _ := regBuild(t, f.state)
		if reaped, _ := restarted.Reap(regCtx); len(reaped) != 0 {
			t.Fatal("the adopted corpse was reaped at boot")
		}
		l := regList(t, restarted)
		if len(l) != 1 || l[0].ID != s.ID || l[0].State != StateExited || l[0].ExitCode == nil || *l[0].ExitCode != 1 {
			t.Fatalf("listed: %+v", l)
		}
		if err := restarted.Close(regCtx, s.ID); err != nil {
			t.Fatal(err)
		}
		if len(f.ids()) != 0 {
			t.Fatal("closing an adopted corpse did not kill it")
		}
	})

	t.Run("a corpse this process watched exit is still reaped at boot", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		f.die(s.ID, "1")
		if reaped, _ := r.Reap(regCtx); len(reaped) != 1 || reaped[0] != s.ID {
			t.Fatalf("our own corpse was not reaped: %v", reaped)
		}
		if len(f.ids()) != 0 {
			t.Fatal("the corpse is still on the socket")
		}
	})
}

func TestRegistry_Creating(t *testing.T) {
	t.Run("refuses a cwd off the mount list, with a sentence that says what to change", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		_, err := r.Create(regCtx, "/workspace/not-mounted", "claude")
		var e *CwdNotAllowedError
		if !errors.As(err, &e) || !strings.Contains(e.Error(), "AGENTDECK_MOUNTS") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("refuses an unknown agent", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		_, err := r.Create(regCtx, "/workspace/agentdeck", "nonexistent")
		var e *UnknownAgentError
		if !errors.As(err, &e) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("a first session has no warning", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		res := regCreate(t, r, "/workspace/agentdeck", "claude")
		s := res.Session
		if res.Warning != "" || s.Cwd != "/workspace/agentdeck" || s.Agent != "claude" || s.Name != "agentdeck" || s.State != StateIdle {
			t.Fatalf("%+v", res)
		}
	})

	t.Run("two DIFFERENT agents in one tree produce two sessions and no warning", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		regCreate(t, r, "/workspace/agentdeck", "claude")
		second := regCreate(t, r, "/workspace/agentdeck", "gemini")
		if second.Warning != "" {
			t.Fatal("a neighbouring session warned")
		}
		if len(regList(t, r)) != 2 {
			t.Fatal("expected two sessions")
		}
	})

	t.Run("the SAME agent twice hands back the running one and says so", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		first := regCreate(t, r, "/workspace/agentdeck", "claude")
		second := regCreate(t, r, "/workspace/agentdeck", "claude")
		if second.Session.ID != first.Session.ID || !strings.Contains(second.Warning, "already running") || len(regList(t, r)) != 1 {
			t.Fatalf("%+v", second)
		}
	})

	t.Run("a dead session left by a previous run is replaced, not reported as already running", func(t *testing.T) {
		r, f := regBuild(t, nil)
		first := regCreate(t, r, "/workspace/agentdeck", "claude")
		f.die(first.Session.ID, "exited")
		restarted := regRegistry(t, regNewFake(t, f.state), `{"claude":{"command":"/bin/sh","name":"Claude Code"}}`, "/workspace/agentdeck")
		second := regCreate(t, restarted, "/workspace/agentdeck", "claude")
		if second.Warning != "" {
			t.Fatal("the corpse was reported as a running session")
		}
		if second.Session.State != StateIdle {
			t.Fatal("the new tab is pinned at the dead pane's state")
		}
		if len(regList(t, restarted)) != 1 {
			t.Fatal("expected one session")
		}
	})

	t.Run("the same repo under two agents gets two distinct ids", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		a := regCreate(t, r, "/workspace/agentdeck", "claude")
		b := regCreate(t, r, "/workspace/agentdeck", "gemini")
		if a.Session.ID == b.Session.ID {
			t.Fatal("same id")
		}
	})
}

func TestRegistry_ListingAndExit(t *testing.T) {
	t.Run("an empty tmux is an empty list", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		if l := regList(t, r); len(l) != 0 {
			t.Fatal(l)
		}
	})

	t.Run("a session whose command exited still lists, as exited, with its code", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		f.die(s.ID, "137")
		l := regList(t, r)
		if l[0].State != StateExited || l[0].ExitCode == nil || *l[0].ExitCode != 137 {
			t.Fatalf("%+v", l[0])
		}
	})

	t.Run("a live session reports no exit code", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		regCreate(t, r, "/workspace/agentdeck", "claude")
		l := regList(t, r)
		if l[0].ExitCode != nil || l[0].State == StateExited {
			t.Fatalf("%+v", l[0])
		}
	})

	t.Run("reaping removes dead sessions and leaves live ones", func(t *testing.T) {
		r, f := regBuild(t, nil)
		dead := regCreate(t, r, "/workspace/agentdeck", "claude")
		live := regCreate(t, r, "/workspace/web", "claude")
		f.die(dead.Session.ID, "1")
		if reaped, _ := r.Reap(regCtx); len(reaped) != 1 || reaped[0] != dead.Session.ID {
			t.Fatalf("reaped %v", reaped)
		}
		if l := regList(t, r); len(l) != 1 || l[0].ID != live.Session.ID {
			t.Fatalf("remaining %+v", l)
		}
	})

	t.Run("sessions group by cwd for the picker", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		regCreate(t, r, "/workspace/agentdeck", "claude")
		regCreate(t, r, "/workspace/agentdeck", "gemini")
		regCreate(t, r, "/workspace/web", "claude")
		by, err := r.SessionsByCwd(regCtx)
		if err != nil || len(by["/workspace/agentdeck"]) != 2 || len(by["/workspace/web"]) != 1 {
			t.Fatalf("%v %v", by, err)
		}
	})
}

func TestRegistry_Secret(t *testing.T) {
	t.Run("matches only its own session", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		a := regCreate(t, r, "/workspace/agentdeck", "claude")
		b := regCreate(t, r, "/workspace/web", "claude")
		if r.SecretMatches(a.Session.ID, "wrong") || r.SecretMatches("no-such-session", "anything") {
			t.Fatal("a wrong secret matched")
		}
		if r.SecretMatches(a.Session.ID, secretFor("test-secret-key", b.Session.ID)) {
			t.Fatal("another session's secret matched")
		}
		if !r.SecretMatches(a.Session.ID, secretFor("test-secret-key", a.Session.ID)) {
			t.Fatal("its own secret did not match")
		}
	})

	t.Run("never appears in a listed session", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		raw, _ := json.Marshal(regList(t, r))
		if regexp.MustCompile(`(?i)secret`).Match(raw) || bytes.Contains(raw, []byte(secretFor("test-secret-key", s.ID))) {
			t.Fatalf("the secret is in the listing: %s", raw)
		}
	})

	t.Run("survives a reattach, so a running agent's hook keeps working", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		first := regCreate(t, r, "/workspace/agentdeck", "claude")
		regCreate(t, r, "/workspace/agentdeck", "claude")
		if regList(t, r)[0].ID != first.Session.ID {
			t.Fatal("not the same session")
		}
		if !r.SecretMatches(first.Session.ID, secretFor("test-secret-key", first.Session.ID)) {
			t.Fatal("the running agent's secret is refused after a reattach")
		}
	})
}

func TestRegistry_Closing(t *testing.T) {
	t.Run("removes the session and forgets its secret", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		if err := r.Close(regCtx, s.ID); err != nil {
			t.Fatal(err)
		}
		if len(regList(t, r)) != 0 {
			t.Fatal("still listed")
		}
		if r.SecretMatches(s.ID, secretFor("test-secret-key", s.ID)) {
			t.Fatal("the secret of a closed session is still accepted")
		}
	})

	t.Run("closing something already gone is not an error", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		if err := r.Close(regCtx, "never-existed"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("will not kill a session it would not list", func(t *testing.T) {
		r, f := regBuild(t, nil)
		f.plant("notes", "/home/someone")
		_ = r.Close(regCtx, "notes")
		if !f.has("notes") {
			t.Fatal("killed")
		}
	})

	t.Run("a prefix of a real id kills nothing", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		_ = r.Close(regCtx, s.ID[:4])
		_ = r.Close(regCtx, "*")
		if !f.has(s.ID) {
			t.Fatal("killed")
		}
	})
}

func TestRegistry_AllowlistAgainstTmuxPath(t *testing.T) {
	t.Run("a session renamed onto ours, pointed elsewhere, is not listed", func(t *testing.T) {
		r, f := regBuild(t, nil)
		s := regCreate(t, r, "/workspace/agentdeck", "claude").Session
		f.plant(s.ID, "/")
		if l := regList(t, r); len(l) != 0 {
			t.Fatalf("%+v", l)
		}
	})

	t.Run("the reported cwd is the one tmux reports", func(t *testing.T) {
		r, _ := regBuild(t, nil)
		regCreate(t, r, "/workspace/web", "claude")
		if c := regList(t, r)[0].Cwd; c != "/workspace/web" {
			t.Fatal(c)
		}
	})
}

// A create reads the list twice before it creates (existing, then Has), so failing from the third
// list call fails exactly the one after the create.
func TestRegistry_FailedCreateLeavesNoOrphan(t *testing.T) {
	t.Run("the session is killed when the list after the create throws", func(t *testing.T) {
		r, f := regBuild(t, nil)
		f.fail("list-throws", 2)
		if _, err := r.Create(regCtx, "/workspace/agentdeck", "claude"); err == nil {
			t.Fatal("create succeeded")
		}
		if ids := f.ids(); len(ids) != 0 {
			t.Fatalf("left %v", ids)
		}
	})

	t.Run("the session is killed when the list comes back without it", func(t *testing.T) {
		r, f := regBuild(t, nil)
		f.fail("list-omits", 0)
		_, err := r.Create(regCtx, "/workspace/agentdeck", "claude")
		if err == nil || !strings.Contains(err.Error(), "was created but tmux does not list it") {
			t.Fatalf("got %v", err)
		}
		if ids := f.ids(); len(ids) != 0 {
			t.Fatalf("left %v", ids)
		}
	})

	t.Run("a retry after a failed create succeeds rather than colliding with its own leftovers", func(t *testing.T) {
		r, f := regBuild(t, nil)
		f.fail("list-throws", 2)
		if _, err := r.Create(regCtx, "/workspace/agentdeck", "claude"); err == nil {
			t.Fatal("create succeeded")
		}
		f.fail("ok", 0)
		res := regCreate(t, r, "/workspace/agentdeck", "claude")
		if res.Warning != "" || res.Session.State != StateIdle {
			t.Fatalf("%+v", res)
		}
		if ids := f.ids(); len(ids) != 1 || ids[0] != res.Session.ID {
			t.Fatalf("%v", ids)
		}
	})

	t.Run("a session under our name that we did not just create is not killed", func(t *testing.T) {
		r, f := regBuild(t, nil)
		id := sessionID("/workspace/agentdeck", "claude")
		f.plant(id, "/workspace/agentdeck")
		f.fail("list-omits", 0)
		if _, err := r.Create(regCtx, "/workspace/agentdeck", "claude"); err == nil {
			t.Fatal("create succeeded")
		}
		if !f.has(id) {
			t.Fatal("a session this call did not create was killed by its undo")
		}
	})

	t.Run("an ATTACH that cannot finish leaves the running agent alone", func(t *testing.T) {
		r, f := regBuild(t, nil)
		first := regCreate(t, r, "/workspace/agentdeck", "claude")
		f.fail("list-throws", 2)
		if _, err := r.Create(regCtx, "/workspace/agentdeck", "claude"); err == nil {
			t.Fatal("create succeeded")
		}
		if ids := f.ids(); len(ids) != 1 || ids[0] != first.Session.ID {
			t.Fatalf("%v", ids)
		}
	})
}

// ---- hub

type regFakePTY struct {
	mu       sync.Mutex
	stream   *Stream
	written  []string
	resized  [][2]int
	disposed bool
}

func (p *regFakePTY) Write(d []byte) {
	p.mu.Lock()
	p.written = append(p.written, string(d))
	p.mu.Unlock()
}

func (p *regFakePTY) Resize(c, r int) {
	p.mu.Lock()
	p.resized = append(p.resized, [2]int{c, r})
	p.mu.Unlock()
}

func (p *regFakePTY) Dispose() {
	p.mu.Lock()
	p.disposed = true
	p.mu.Unlock()
}

func (p *regFakePTY) Stream() *Stream { return p.stream }

type regAnnounced struct {
	id    string
	state SessionState
	code  int // -1 for none
}

type regHub struct {
	hub       *Hub
	reg       *Registry
	fake      *regFake
	mu        sync.Mutex
	created   []string
	ptys      map[string]*regFakePTY
	announced []regAnnounced
}

func regBuildHub(t *testing.T) *regHub {
	f := regNewFake(t, nil)
	h := &regHub{fake: f, ptys: map[string]*regFakePTY{}}
	h.reg = regRegistry(t, f, `{"claude":{"command":"/bin/sh"}}`, "/workspace/a", "/workspace/b")
	h.hub = newHub(f.tmux, h.reg, func(id string, st SessionState, code *int) {
		c := -1
		if code != nil {
			c = *code
		}
		h.mu.Lock()
		h.announced = append(h.announced, regAnnounced{id, st, c})
		h.mu.Unlock()
	})
	h.hub.repaintQuiet, h.hub.repaintMax = 10*time.Millisecond, 100*time.Millisecond
	h.hub.createPTY = func(id string) (PTY, error) {
		p := &regFakePTY{stream: newStream(id)}
		h.mu.Lock()
		h.created = append(h.created, id)
		h.ptys[id] = p
		h.mu.Unlock()
		return p, nil
	}
	return h
}

func (h *regHub) sync(t *testing.T) {
	t.Helper()
	if err := h.hub.Sync(regCtx); err != nil {
		t.Fatal(err)
	}
}

func (h *regHub) takeAnnounced() []regAnnounced {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.announced
	h.announced = nil
	return out
}

func regEqual(a, b any) bool { return fmt.Sprint(a) == fmt.Sprint(b) }

func TestRegistry_HubAllowlistBoundsSessions(t *testing.T) {
	t.Run("a session on the socket that agentdeck did not start is never attached", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		if _, err := h.fake.tmux.CreateOrAttach(regCtx, "stranger", "/", "/bin/sh", nil, nil); err != nil {
			t.Fatal(err)
		}
		h.sync(t)
		if !regEqual(h.created, []string{s.ID}) || h.hub.Size() != 1 || h.hub.StreamFor("stranger") != nil {
			t.Fatalf("the hub adopted a session nobody allowed: %v", h.created)
		}
	})

	t.Run("and it is not on the session list either, so no tab claims it", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		_, _ = h.fake.tmux.CreateOrAttach(regCtx, "stranger", "/", "/bin/sh", nil, nil)
		if l := regList(t, h.reg); len(l) != 1 || l[0].ID != s.ID {
			t.Fatalf("%+v", l)
		}
	})
}

func TestRegistry_HubReconcile(t *testing.T) {
	t.Run("attaches to a session it has not seen", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		if !regEqual(h.created, []string{s.ID}) || h.hub.Size() != 1 {
			t.Fatal(h.created)
		}
	})

	t.Run("syncing twice does not attach twice", func(t *testing.T) {
		h := regBuildHub(t)
		regCreate(t, h.reg, "/workspace/a", "claude")
		h.sync(t)
		h.sync(t)
		if len(h.created) != 1 {
			t.Fatal(h.created)
		}
	})

	t.Run("lets go of a session tmux no longer has, and disposes its attachment", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		_ = h.reg.Close(regCtx, s.ID)
		h.sync(t)
		if h.hub.Size() != 0 || !h.ptys[s.ID].disposed || h.hub.StreamFor(s.ID) != nil {
			t.Fatal("still held")
		}
	})

	t.Run("does not attach to a session that has already exited", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.fake.die(s.ID, "1")
		h.sync(t)
		if len(h.created) != 0 || h.hub.Size() != 0 {
			t.Fatal(h.created)
		}
	})

	t.Run("a session that cannot be attached does not take the server down", func(t *testing.T) {
		h := regBuildHub(t)
		inner := h.hub.createPTY
		h.hub.createPTY = func(id string) (PTY, error) {
			if strings.HasPrefix(id, "a-") {
				return nil, errors.New("posix_spawnp failed")
			}
			return inner(id)
		}
		bad := regCreate(t, h.reg, "/workspace/a", "claude").Session
		good := regCreate(t, h.reg, "/workspace/b", "claude").Session
		h.sync(t)
		if !regEqual(h.created, []string{good.ID}) || h.hub.StreamFor(bad.ID) != nil || h.hub.Size() != 1 {
			t.Fatalf("the healthy session must still be attached: %v", h.created)
		}
	})

	t.Run("tmux is still the truth for every session inside the boundary", func(t *testing.T) {
		h := regBuildHub(t)
		regCreate(t, h.reg, "/workspace/a", "claude")
		regCreate(t, h.reg, "/workspace/b", "claude")
		h.sync(t)
		if len(h.created) != 2 {
			t.Fatal(h.created)
		}
	})
}

func TestRegistry_HubStateToList(t *testing.T) {
	t.Run("an idle stream reports idle", func(t *testing.T) {
		h := regBuildHub(t)
		regCreate(t, h.reg, "/workspace/a", "claude")
		h.sync(t)
		if st := regList(t, h.reg)[0].State; st != StateIdle {
			t.Fatal(st)
		}
	})

	t.Run("output makes the listed session working", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		h.ptys[s.ID].stream.Write(bytes.Repeat([]byte("a"), 200))
		h.sync(t)
		if st := regList(t, h.reg)[0].State; st != StateWorking {
			t.Fatal(st)
		}
	})

	t.Run("a dead session reports exited regardless of what any stream thinks", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		h.fake.die(s.ID, "137")
		h.sync(t)
		l := regList(t, h.reg)[0]
		if l.State != StateExited || l.ExitCode == nil || *l.ExitCode != 137 {
			t.Fatalf("%+v", l)
		}
	})
}

func TestRegistry_HubRouting(t *testing.T) {
	t.Run("input and resize reach only the session addressed", func(t *testing.T) {
		h := regBuildHub(t)
		a := regCreate(t, h.reg, "/workspace/a", "claude").Session
		b := regCreate(t, h.reg, "/workspace/b", "claude").Session
		h.sync(t)
		h.hub.SendInput(a.ID, "typed into a")
		h.hub.ApplyPaneRows(b.ID, 20)
		pa, pb := h.ptys[a.ID], h.ptys[b.ID]
		if !regEqual(pa.written, []string{"typed into a"}) || len(pb.written) != 0 {
			t.Fatalf("written %v %v", pa.written, pb.written)
		}
		if !regEqual(pb.resized, [][2]int{{paneCols, 20}}) || len(pa.resized) != 0 {
			t.Fatalf("resized %v %v", pa.resized, pb.resized)
		}
	})

	t.Run("input to an unknown session is dropped rather than thrown", func(t *testing.T) {
		h := regBuildHub(t)
		h.hub.SendInput("no-such-session", "hello")
		h.hub.ApplyPaneRows("no-such-session", 24)
	})

	t.Run("scrollback comes from tmux for the session asked about", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		got, err := h.fake.tmux.CaptureHistory(regCtx, s.ID, 100)
		if err != nil || got != "history\r\n" {
			t.Fatalf("%q %v", got, err)
		}
	})
}

// regAttached builds a hub attached to one session whose repaint runs onRefresh against its stream.
func regAttached(t *testing.T, onRefresh func(*Stream)) (*Hub, string, *Stream) {
	h := regBuildHub(t)
	var pane atomic.Pointer[Stream]
	h.fake.onRefresh = func() {
		if s := pane.Load(); s != nil {
			onRefresh(s)
		}
	}
	s := regCreate(t, h.reg, "/workspace/a", "claude").Session
	h.sync(t)
	stream := h.hub.StreamFor(s.ID)
	if stream == nil {
		t.Fatal("the hub never attached to the session")
	}
	pane.Store(stream)
	return h.hub, s.ID, stream
}

func TestRegistry_HubRepaint(t *testing.T) {
	t.Run("returns the bytes tmux repainted and the seq they end at", func(t *testing.T) {
		hub, id, stream := regAttached(t, func(p *Stream) { p.Write([]byte("\x1b[H\x1b[2Jprompt$ ")) })
		stream.Write([]byte("an hour-old build log"))
		_, before := stream.Buffered()
		data, seq, err := hub.Repaint(regCtx, id)
		_, head := stream.Buffered()
		if err != nil || string(data) != "\x1b[H\x1b[2Jprompt$ " || seq != head || seq != before+int64(len(data)) {
			t.Fatalf("%q %d %d %v", data, seq, head, err)
		}
	})

	t.Run("output the agent produces during the window is carried, not dropped", func(t *testing.T) {
		var wg sync.WaitGroup
		hub, id, stream := regAttached(t, func(p *Stream) {
			p.Write([]byte("repaint"))
			wg.Add(1)
			go func() {
				defer wg.Done()
				time.Sleep(2 * time.Millisecond)
				p.Write([]byte("+agent output"))
			}()
		})
		data, seq, err := hub.Repaint(regCtx, id)
		wg.Wait()
		_, head := stream.Buffered()
		if err != nil || string(data) != "repaint+agent output" || seq != head {
			t.Fatalf("%q %d %d %v", data, seq, head, err)
		}
	})

	t.Run("a pane that never stops drawing is capped rather than waited on forever", func(t *testing.T) {
		stop := make(chan struct{})
		done := make(chan struct{})
		hub, id, _ := regAttached(t, func(p *Stream) {
			go func() {
				defer close(done)
				tick := time.NewTicker(2 * time.Millisecond)
				defer tick.Stop()
				for {
					select {
					case <-stop:
						return
					case <-tick.C:
						p.Write([]byte("."))
					}
				}
			}()
		})
		started := time.Now()
		data, seq, err := hub.Repaint(regCtx, id)
		close(stop)
		<-done
		if time.Since(started) >= time.Second {
			t.Fatal("the cap did not hold")
		}
		if err != nil || len(data) == 0 || seq != int64(len(data)) {
			t.Fatalf("%d %d %v", len(data), seq, err)
		}
	})

	t.Run("a pane that floods is cut at the ring buffer's capacity, not at the clock", func(t *testing.T) {
		hub, id, stream := regAttached(t, func(p *Stream) {
			block := bytes.Repeat([]byte("x"), 64*1024)
			for i := 0; i < 40; i++ {
				p.Write(block)
			}
		})
		data, seq, err := hub.Repaint(regCtx, id)
		if err != nil || len(data) > stream.buf.capacity+64*1024 {
			t.Fatalf("collected %d bytes past the budget: %v", len(data), err)
		}
		if seq != int64(len(data)) {
			t.Fatalf("seq %d for %d bytes", seq, len(data))
		}
	})

	t.Run("a repaint that collected nothing fails rather than returning a blank screen", func(t *testing.T) {
		hub, id, _ := regAttached(t, func(*Stream) {})
		if _, _, err := hub.Repaint(regCtx, id); err == nil || !strings.Contains(err.Error(), "no repaint arrived") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("a session with no attachment cannot repaint, and says so", func(t *testing.T) {
		h := regBuildHub(t)
		if _, _, err := h.hub.Repaint(regCtx, "no-such-session"); err == nil || !strings.Contains(err.Error(), "no session") {
			t.Fatalf("got %v", err)
		}
	})
}

func TestRegistry_HubShutdown(t *testing.T) {
	t.Run("disposes every attachment and forgets them", func(t *testing.T) {
		h := regBuildHub(t)
		a := regCreate(t, h.reg, "/workspace/a", "claude").Session
		regCreate(t, h.reg, "/workspace/b", "claude")
		h.sync(t)
		h.hub.DisposeAll()
		if h.hub.Size() != 0 || !h.ptys[a.ID].disposed {
			t.Fatal("not disposed")
		}
	})
}

func TestRegistry_HubAnnounce(t *testing.T) {
	t.Run("each session is announced once when it first appears", func(t *testing.T) {
		h := regBuildHub(t)
		a := regCreate(t, h.reg, "/workspace/a", "claude").Session
		b := regCreate(t, h.reg, "/workspace/b", "claude").Session
		h.sync(t)
		got := h.takeAnnounced()
		sort.Slice(got, func(i, j int) bool { return got[i].id < got[j].id })
		want := []regAnnounced{{a.ID, StateIdle, -1}, {b.ID, StateIdle, -1}}
		sort.Slice(want, func(i, j int) bool { return want[i].id < want[j].id })
		if !regEqual(got, want) {
			t.Fatalf("%v", got)
		}
	})

	t.Run("a sync that changed nothing says nothing", func(t *testing.T) {
		h := regBuildHub(t)
		regCreate(t, h.reg, "/workspace/a", "claude")
		h.sync(t)
		h.takeAnnounced()
		h.sync(t)
		h.sync(t)
		if got := h.takeAnnounced(); len(got) != 0 {
			t.Fatal(got)
		}
	})

	t.Run("output makes it working, once, and staying working is not re-announced", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		h.takeAnnounced()
		h.ptys[s.ID].stream.Write(bytes.Repeat([]byte("a"), 200))
		h.sync(t)
		h.ptys[s.ID].stream.Write(bytes.Repeat([]byte("a"), 200))
		h.sync(t)
		if got := h.takeAnnounced(); !regEqual(got, []regAnnounced{{s.ID, StateWorking, -1}}) {
			t.Fatal(got)
		}
	})

	t.Run("a session with no attachment is announced from the registry, code and all", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.fake.die(s.ID, "137")
		h.sync(t)
		if got := h.takeAnnounced(); !regEqual(got, []regAnnounced{{s.ID, StateExited, 137}}) {
			t.Fatal(got)
		}
	})

	t.Run("a session that dies while the hub is attached is announced exited, not idle", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		h.takeAnnounced()
		h.ptys[s.ID].stream.Write(bytes.Repeat([]byte("a"), 200))
		h.fake.die(s.ID, "137")
		h.sync(t)
		if got := h.takeAnnounced(); !regEqual(got, []regAnnounced{{s.ID, StateExited, 137}}) {
			t.Fatal(got)
		}
		st, code := h.ptys[s.ID].stream.State()
		if st != StateExited || code == nil || *code != 137 {
			t.Fatalf("the stream says %s", st)
		}
	})

	t.Run("an exit code that arrives after the state is not suppressed as a repeat", func(t *testing.T) {
		h := regBuildHub(t)
		code := 137
		h.hub.Announce("s1", StateExited, nil)
		h.hub.Announce("s1", StateExited, &code)
		if got := h.takeAnnounced(); !regEqual(got, []regAnnounced{{"s1", StateExited, -1}, {"s1", StateExited, 137}}) {
			t.Fatal(got)
		}
	})

	t.Run("a session that goes away and comes back is announced again", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		h.takeAnnounced()
		if err := h.fake.tmux.Kill(regCtx, s.ID); err != nil {
			t.Fatal(err)
		}
		h.sync(t)
		regCreate(t, h.reg, "/workspace/a", "claude")
		h.sync(t)
		if got := h.takeAnnounced(); !regEqual(got, []regAnnounced{{s.ID, StateIdle, -1}}) {
			t.Fatal(got)
		}
	})

	t.Run("a hook's statement goes out through the same funnel, and repeats do not", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		h.takeAnnounced()
		h.ptys[s.ID].stream.Declare(StateWaiting, nil)
		h.hub.Announce(s.ID, StateWaiting, nil)
		h.hub.Announce(s.ID, StateWaiting, nil)
		h.sync(t)
		if got := h.takeAnnounced(); !regEqual(got, []regAnnounced{{s.ID, StateWaiting, -1}}) {
			t.Fatal(got)
		}
	})
}

func TestRegistry_HubAttachClientDeath(t *testing.T) {
	t.Run("a session tmux still lists gets a new pty rather than a sticky exited tab", func(t *testing.T) {
		h := regBuildHub(t)
		s := regCreate(t, h.reg, "/workspace/a", "claude").Session
		h.sync(t)
		zero := 0
		h.hub.StreamFor(s.ID).Declare(StateExited, &zero)
		h.sync(t)
		if !regEqual(h.created, []string{s.ID, s.ID}) {
			t.Fatalf("the hub kept the dead pty: %v", h.created)
		}
		if st, _ := h.hub.StreamFor(s.ID).State(); st == StateExited {
			t.Fatal("the new stream is still dead")
		}
	})
}

// ---- real tmux: create-500 and sync-crash

// regSocket is a fresh real tmux on an agentdeck-gotest- socket, killed and unlinked at cleanup.
func regSocket(t *testing.T) *Tmux {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	socket := fmt.Sprintf("agentdeck-gotest-reg-%d-%d", os.Getpid(), time.Now().UnixNano()%1000000)
	tm := newTmux(socket, "")
	real := tm.exec
	t.Cleanup(func() {
		path, _ := real(context.Background(), []string{"display-message", "-p", "#{socket_path}"}, nil)
		_, _ = real(context.Background(), []string{"kill-server"}, nil)
		if path = strings.TrimSpace(path); strings.Contains(path, socket) {
			_ = os.Remove(path)
		}
	})
	return tm
}

func regHeld(t *testing.T, tm *Tmux) []string {
	out, err := exec.Command("tmux", "-L", tm.Socket, "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil
	}
	return strings.Fields(string(out))
}

func TestRegistry_Create500(t *testing.T) {
	t.Run("answers 201 with the session it created", func(t *testing.T) {
		// The reproduction: no locale at all, as `env -i` and launchd give a process.
		for _, name := range []string{"LANG", "LC_ALL", "LC_CTYPE"} {
			t.Setenv(name, "")
			_ = os.Unsetenv(name)
		}
		d := newDeck(t)
		id := d.create()
		held := regHeld(t, d.tmux)
		if !contains(held, id) {
			t.Fatalf("tmux does not hold the session the 201 named; it holds %v", held)
		}
		status, body := d.do("GET", "/api/sessions", d.token, nil)
		list, _ := body["sessions"].([]any)
		if status != 200 || len(list) != 1 || list[0].(map[string]any)["id"] != id {
			t.Fatalf("%d %v", status, body)
		}
	})

	t.Run("the session tmux made is killed again when the call cannot finish", func(t *testing.T) {
		tm := regSocket(t)
		real := tm.exec
		var creates atomic.Int32
		tm.exec = func(ctx context.Context, args []string, extra map[string]string) (string, error) {
			if contains(args, "new-session") {
				creates.Add(1)
			}
			if args[0] == "list-sessions" && creates.Load() > 0 {
				return "", errors.New("tmux is not answering, as far as this call is concerned")
			}
			return real(ctx, args, extra)
		}
		work, _ := filepath.EvalSymlinks(t.TempDir())
		profiles, _ := parseProfiles([]byte(`{"sh":{"command":"/bin/sh","args":["-c","exec sleep 100000"]}}`))
		r, _ := newRegistry(tm, profiles, newAllowlist([]string{work}, nil), "test-secret-key")
		if err := tm.EnsureServer(regCtx); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Create(regCtx, work, "sh"); err == nil {
			t.Fatal("create succeeded")
		}
		if creates.Load() == 0 {
			t.Fatal("the create never reached tmux")
		}
		if held := regHeld(t, tm); len(held) != 0 {
			t.Fatalf("the failed create left %v running on the socket", held)
		}
	})
}

func TestRegistry_SyncCrash(t *testing.T) {
	d := newDeck(t)
	var broken atomic.Bool
	real := d.tmux.exec
	d.tmux.exec = func(ctx context.Context, args []string, extra map[string]string) (string, error) {
		if broken.Load() && contains(args, "list-sessions") {
			return "", regTmuxErr("lost server")
		}
		return real(ctx, args, extra)
	}
	rogue := filepath.Join(filepath.Dir(d.repo), "ro\ngue")
	_ = os.MkdirAll(rogue, 0o755)
	// Exactly what any process running as this user can do, on the socket agentdeck shares.
	if out, err := exec.Command("tmux", "-L", d.tmux.Socket, "new-session", "-d", "-c", rogue, "--", "sleep", "300").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}

	t.Run("a session whose path contains a newline costs at most that session", func(t *testing.T) {
		d.create()
		for i := 0; i < 2; i++ {
			if err := d.hub.Sync(regCtx); err != nil {
				t.Fatalf("sync failed over one session's odd working dir: %v", err)
			}
		}
		if status, body := d.do("GET", "/api/sessions", d.token, nil); status != 200 || len(body["sessions"].([]any)) != 1 {
			t.Fatalf("GET /api/sessions: %d %v", status, body)
		}
	})

	t.Run("a boot with that session already present still reaches listen", func(t *testing.T) {
		// Boot runs reap before the listener; it must not fail over the rogue session.
		if _, err := d.reg.Reap(regCtx); err != nil {
			t.Fatalf("reap at boot failed: %v", err)
		}
		if err := d.hub.Sync(regCtx); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("a tmux failure on the timer degrades one poll, it does not exit the process", func(t *testing.T) {
		broken.Store(true)
		for i := 0; i < 2; i++ {
			if err := d.hub.Sync(regCtx); err == nil {
				t.Fatal("a failing tmux was reported as a successful sync")
			}
		}
		if status, _ := d.do("GET", "/api/sessions", d.token, nil); status == 200 {
			t.Fatal("a list tmux refused was answered as if it succeeded")
		}
		broken.Store(false)
		if err := d.hub.Sync(regCtx); err != nil {
			t.Fatalf("did not recover once tmux answered again: %v", err)
		}
		if status, _ := d.do("GET", "/api/sessions", d.token, nil); status != 200 {
			t.Fatalf("GET /api/sessions %d after recovery", status)
		}
	})
}

// ---- stream

func regClockStream() (*Stream, func(time.Duration)) {
	s := newStream("s1")
	var mu sync.Mutex
	now := time.Unix(1_000_000, 0)
	s.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	return s, func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
}

func regState(s *Stream) SessionState { st, _ := s.State(); return st }

func TestRegistry_StreamCadence(t *testing.T) {
	t.Run("a fresh session is idle, not working", func(t *testing.T) {
		s, _ := regClockStream()
		if regState(s) != StateIdle {
			t.Fatal(regState(s))
		}
	})

	t.Run("sustained output is working", func(t *testing.T) {
		s, _ := regClockStream()
		s.Write(bytes.Repeat([]byte("a"), 200))
		if regState(s) != StateWorking {
			t.Fatal(regState(s))
		}
	})

	t.Run("it falls back to idle once output stops", func(t *testing.T) {
		s, advance := regClockStream()
		s.Write(bytes.Repeat([]byte("a"), 200))
		advance(workingLinger + time.Millisecond)
		if regState(s) != StateIdle {
			t.Fatal(regState(s))
		}
	})

	t.Run("a single keystroke echoing back is not an agent thinking", func(t *testing.T) {
		s, _ := regClockStream()
		s.Write([]byte("a"))
		if regState(s) != StateIdle {
			t.Fatal(regState(s))
		}
	})

	t.Run("bytes accumulate within a window but not across a quiet gap", func(t *testing.T) {
		s, _ := regClockStream()
		s.Write(bytes.Repeat([]byte("a"), 8))
		s.Write(bytes.Repeat([]byte("a"), 8))
		if regState(s) != StateWorking {
			t.Fatal("16 bytes inside one window")
		}
		f, advance := regClockStream()
		f.Write(bytes.Repeat([]byte("a"), 8))
		advance(workingLinger + time.Millisecond)
		f.Write(bytes.Repeat([]byte("a"), 8))
		if regState(f) != StateIdle {
			t.Fatal("a gap resets the count rather than summing")
		}
	})
}

func TestRegistry_StreamDeclared(t *testing.T) {
	t.Run("exit is definitive and sticky, even with bytes still arriving", func(t *testing.T) {
		s, _ := regClockStream()
		code := 137
		s.Declare(StateExited, &code)
		s.Write(bytes.Repeat([]byte("a"), 200))
		st, c := s.State()
		if st != StateExited || c == nil || *c != 137 {
			t.Fatal(st)
		}
	})

	t.Run("a declared waiting survives quiet, where cadence alone would say idle", func(t *testing.T) {
		s, advance := regClockStream()
		s.Declare(StateWaiting, nil)
		advance(workingLinger * 10)
		if regState(s) != StateWaiting {
			t.Fatal(regState(s))
		}
	})

	t.Run("output contradicts waiting, because the agent is evidently doing something", func(t *testing.T) {
		s, _ := regClockStream()
		s.Declare(StateWaiting, nil)
		s.Write(bytes.Repeat([]byte("a"), 200))
		if regState(s) != StateWorking {
			t.Fatal(regState(s))
		}
	})

	t.Run("an agent with no mechanism never claims waiting", func(t *testing.T) {
		s, advance := regClockStream()
		for _, ms := range []int{0, 500, 5000, 60_000} {
			step := time.Duration(ms) * time.Millisecond
			advance(step)
			s.Write(bytes.Repeat([]byte("a"), 100))
			if regState(s) == StateWaiting {
				t.Fatal("waiting")
			}
			advance(step)
			if regState(s) == StateWaiting {
				t.Fatal("waiting")
			}
		}
	})
}

func TestRegistry_StreamChunks(t *testing.T) {
	t.Run("every write reaches listeners with the epoch and the new seq", func(t *testing.T) {
		s, _ := regClockStream()
		var seen []Chunk
		s.OnChunk(func(c Chunk) { seen = append(seen, c) })
		s.Write([]byte("abc"))
		s.Write([]byte("de"))
		if len(seen) != 2 || string(seen[0].Data) != "abc" || seen[0].Seq != 3 || string(seen[1].Data) != "de" || seen[1].Seq != 5 {
			t.Fatalf("%v", seen)
		}
		if seen[0].Epoch != seen[1].Epoch || seen[0].Epoch != s.Epoch() {
			t.Fatal("epoch is per session, not per chunk")
		}
	})

	t.Run("unsubscribing stops delivery", func(t *testing.T) {
		s, _ := regClockStream()
		count := 0
		off := s.OnChunk(func(Chunk) { count++ })
		s.Write([]byte("a"))
		off()
		s.Write([]byte("b"))
		if count != 1 {
			t.Fatal(count)
		}
	})

	t.Run("an empty write changes nothing", func(t *testing.T) {
		s, _ := regClockStream()
		count := 0
		s.OnChunk(func(Chunk) { count++ })
		s.Write(nil)
		if _, head := s.Buffered(); count != 0 || head != 0 {
			t.Fatal(count, head)
		}
	})

	t.Run("two streams get different epochs, so a restart cannot be mistaken for continuity", func(t *testing.T) {
		if newStream("s").Epoch() == newStream("s").Epoch() {
			t.Fatal("same epoch")
		}
	})
}

func TestRegistry_StreamPaneHeight(t *testing.T) {
	t.Run("the pane is the minimum over attached clients", func(t *testing.T) {
		s, _ := regClockStream()
		s.Attach("phone", 60, 40)
		s.Attach("laptop", 200, 50)
		if s.MinRows() != 40 {
			t.Fatal(s.MinRows())
		}
	})

	t.Run("detaching releases the constraint and the pane grows back", func(t *testing.T) {
		s, _ := regClockStream()
		s.Attach("phone", 60, 40)
		s.Attach("laptop", 200, 50)
		s.Detach("phone")
		if s.MinRows() != 50 {
			t.Fatal(s.MinRows())
		}
	})

	t.Run("with nobody attached the pane keeps whatever it had", func(t *testing.T) {
		s, _ := regClockStream()
		s.Attach("phone", 60, 40)
		s.Detach("phone")
		if s.MinRows() != 0 {
			t.Fatal(s.MinRows())
		}
	})

	t.Run("a resize from a detached client constrains nothing", func(t *testing.T) {
		s, _ := regClockStream()
		s.Attach("laptop", 200, 50)
		s.Resize("ghost", 20, 5)
		if s.MinRows() != 50 {
			t.Fatal(s.MinRows())
		}
	})

	t.Run("the stream reads output whether or not anyone is attached", func(t *testing.T) {
		s, _ := regClockStream()
		s.Write(bytes.Repeat([]byte("a"), 200))
		if _, head := s.Buffered(); regState(s) != StateWorking || head != 200 {
			t.Fatal(regState(s), head)
		}
	})
}

// ---- ring buffer

func regPanics(f func()) (panicked bool) {
	defer func() { panicked = recover() != nil }()
	f()
	return false
}

func TestRegistry_RingSeqIsByteCount(t *testing.T) {
	t.Run("headSeq counts bytes, not messages", func(t *testing.T) {
		r := newRingBuffer("e1", defaultRingCapacity)
		if r.headSeq != 0 {
			t.Fatal(r.headSeq)
		}
		r.append([]byte("hello"))
		if r.headSeq != 5 {
			t.Fatal(r.headSeq)
		}
		r.append([]byte("!"))
		if r.headSeq != 6 {
			t.Fatal(r.headSeq)
		}
	})

	t.Run("an empty append does not move the counter", func(t *testing.T) {
		r := newRingBuffer("e1", defaultRingCapacity)
		r.append([]byte("abc"))
		r.append(nil)
		if r.headSeq != 3 {
			t.Fatal(r.headSeq)
		}
	})

	t.Run("multi-byte characters count as bytes", func(t *testing.T) {
		r := newRingBuffer("e1", defaultRingCapacity)
		r.append([]byte("日本語"))
		if r.headSeq != 9 {
			t.Fatal(r.headSeq)
		}
	})
}

func TestRegistry_RingCoverage(t *testing.T) {
	t.Run("serves a client inside the window", func(t *testing.T) {
		r := newRingBuffer("e1", defaultRingCapacity)
		r.append([]byte("abcdef"))
		if !r.covers("e1", 2, true) || string(r.since(2)) != "cdef" {
			t.Fatal("not served")
		}
	})

	t.Run("a client at headSeq is covered and gets nothing", func(t *testing.T) {
		r := newRingBuffer("e1", defaultRingCapacity)
		r.append([]byte("abc"))
		if !r.covers("e1", 3, true) || len(r.since(3)) != 0 {
			t.Fatal("wrong")
		}
	})

	t.Run("a client below tailSeq is not covered", func(t *testing.T) {
		r := newRingBuffer("e1", 4)
		r.append([]byte("abcdefgh"))
		if r.tailSeq() != 4 || r.covers("e1", 3, true) || !r.covers("e1", 4, true) {
			t.Fatal("wrong")
		}
	})

	t.Run("a client AHEAD of headSeq is not covered, which is the assertion that matters", func(t *testing.T) {
		r := newRingBuffer("e1", defaultRingCapacity)
		r.append([]byte("abc"))
		if r.covers("e1", 9999, true) {
			t.Fatal("covered")
		}
	})

	t.Run("since() refuses a position outside the window rather than returning a hole", func(t *testing.T) {
		r := newRingBuffer("e1", 4)
		r.append([]byte("abcdefgh"))
		if !regPanics(func() { r.since(0) }) || !regPanics(func() { r.since(99) }) {
			t.Fatal("since returned something for a position outside the window")
		}
	})
}

func TestRegistry_RingEpoch(t *testing.T) {
	t.Run("a mismatched epoch is never covered, whatever the numbers say", func(t *testing.T) {
		r := newRingBuffer("e2", defaultRingCapacity)
		r.append([]byte("abcdef"))
		if r.covers("e1", 2, true) {
			t.Fatal("covered")
		}
	})

	t.Run("a missing epoch is never covered", func(t *testing.T) {
		r := newRingBuffer("e2", defaultRingCapacity)
		r.append([]byte("abcdef"))
		if r.covers("", 2, true) {
			t.Fatal("covered")
		}
	})

	t.Run("the restart case: same id, client far ahead, fresh counter", func(t *testing.T) {
		r := newRingBuffer("e2", defaultRingCapacity)
		r.append([]byte("fresh output"))
		if r.covers("e1", 4_000_000, true) {
			t.Fatal("covered")
		}
	})

	t.Run("a non-integer seq is not covered", func(t *testing.T) {
		// The Go buffer takes an int64, so a fractional seq can only arrive through the parser.
		r := newRingBuffer("e1", defaultRingCapacity)
		r.append([]byte("abcdef"))
		m, e := parseClientMessage([]byte(`{"t":"attach","sessionId":"s1","cols":80,"rows":24,"haveEpoch":"e1","haveSeq":1.5}`))
		if e != "" {
			t.Fatal(e)
		}
		if r.covers(m.HaveEpoch, m.HaveSeq, m.HasPos) {
			t.Fatal("a fractional seq was covered")
		}
	})
}

func TestRegistry_RingEviction(t *testing.T) {
	t.Run("holds at most `capacity` bytes", func(t *testing.T) {
		r := newRingBuffer("e1", 8)
		for i := 0; i < 10; i++ {
			r.append([]byte("xyz"))
		}
		if len(r.data) > 8 {
			t.Fatal(len(r.data))
		}
	})

	t.Run("evicting part of a chunk still serves a client inside it", func(t *testing.T) {
		r := newRingBuffer("e1", 5)
		r.append([]byte("abcdefgh"))
		if r.tailSeq() != 3 || !r.covers("e1", 3, true) || string(r.since(3)) != "defgh" {
			t.Fatal("wrong")
		}
	})

	t.Run("covers and since agree at every position in the window", func(t *testing.T) {
		r := newRingBuffer("e1", 6)
		r.append([]byte("abcd"))
		r.append([]byte("efgh"))
		r.append([]byte("ij"))
		for seq := int64(0); seq <= r.headSeq+2; seq++ {
			p := regPanics(func() { r.since(seq) })
			if r.covers("e1", seq, true) == p {
				t.Fatalf("covers and since disagree at %d", seq)
			}
		}
	})

	t.Run("headSeq keeps counting past eviction", func(t *testing.T) {
		r := newRingBuffer("e1", 4)
		r.append([]byte("abcdefghij"))
		if r.headSeq != 10 || string(r.snapshot()) != "ghij" {
			t.Fatal("wrong")
		}
	})

	t.Run("rejects a nonsense capacity", func(t *testing.T) {
		if !regPanics(func() { newRingBuffer("e1", 0) }) {
			t.Fatal("accepted")
		}
	})
}

// ---- protocol

func regOK(t *testing.T, raw string) *ClientMessage {
	t.Helper()
	m, e := parseClientMessage([]byte(raw))
	if e != "" {
		t.Fatalf("expected a message for %s, got: %s", raw, e)
	}
	return m
}

func regErr(t *testing.T, raw string, want string) {
	t.Helper()
	m, e := parseClientMessage([]byte(raw))
	if m != nil || !regexp.MustCompile(want).MatchString(e) {
		t.Fatalf("expected an error matching %s for %s, got %+v %q", want, raw, m, e)
	}
}

func TestRegistry_ProtocolParsing(t *testing.T) {
	t.Run("attach carries a viewport", func(t *testing.T) {
		m := regOK(t, `{"t":"attach","sessionId":"s1","cols":80,"rows":24}`)
		if *m != (ClientMessage{T: "attach", SessionID: "s1", Cols: 80, Rows: 24}) {
			t.Fatalf("%+v", m)
		}
	})

	t.Run("attach carries a resume position only when epoch and seq travel together", func(t *testing.T) {
		if m := regOK(t, `{"t":"attach","sessionId":"s1","cols":80,"rows":24,"haveEpoch":"e1","haveSeq":42}`); !m.HasPos || m.HaveSeq != 42 || m.HaveEpoch != "e1" {
			t.Fatalf("%+v", m)
		}
		if m := regOK(t, `{"t":"attach","sessionId":"s1","cols":80,"rows":24,"haveSeq":42}`); m.HasPos {
			t.Fatal("a seq with no epoch must not become a position")
		}
		if m := regOK(t, `{"t":"attach","sessionId":"s1","cols":80,"rows":24,"haveEpoch":"e1"}`); m.HasPos || m.HaveEpoch != "" {
			t.Fatal("an epoch with no seq became a position")
		}
	})

	t.Run("resync demands both, because its whole purpose is a position", func(t *testing.T) {
		regErr(t, `{"t":"resync","sessionId":"s1","haveSeq":5}`, "haveEpoch")
		regErr(t, `{"t":"resync","sessionId":"s1","haveEpoch":"e1"}`, "haveSeq")
		m := regOK(t, `{"t":"resync","sessionId":"s1","haveEpoch":"e1","haveSeq":5}`)
		if *m != (ClientMessage{T: "resync", SessionID: "s1", HaveEpoch: "e1", HaveSeq: 5, HasPos: true}) {
			t.Fatalf("%+v", m)
		}
	})

	t.Run("input takes a string, including an empty one", func(t *testing.T) {
		if m := regOK(t, `{"t":"input","sessionId":"s1","data":""}`); *m != (ClientMessage{T: "input", SessionID: "s1"}) {
			t.Fatalf("%+v", m)
		}
		regErr(t, `{"t":"input","sessionId":"s1","data":42}`, "string data")
	})
}

func TestRegistry_ProtocolRefusals(t *testing.T) {
	t.Run("malformed JSON", func(t *testing.T) { regErr(t, `{not json`, "not JSON") })
	t.Run("no sessionId", func(t *testing.T) { regErr(t, `{"t":"attach","cols":80,"rows":24}`, "sessionId") })
	t.Run("unknown type names what it did not recognise", func(t *testing.T) {
		regErr(t, `{"t":"teleport","sessionId":"s1"}`, "teleport")
	})
	t.Run("dimensions must be integers in range", func(t *testing.T) {
		// null is what JSON.stringify makes of NaN.
		for _, bad := range []string{"0", "-1", "1.5", "100000", "null", `"80"`} {
			regErr(t, `{"t":"attach","sessionId":"s1","cols":`+bad+`,"rows":24}`, "cols and rows")
			regErr(t, `{"t":"resize","sessionId":"s1","cols":80,"rows":`+bad+`}`, "cols and rows")
		}
	})
	t.Run("an array is not a message", func(t *testing.T) { regErr(t, `[1,2,3]`, "not an object") })
	t.Run("null is not a message", func(t *testing.T) { regErr(t, `null`, "not an object") })
}

func TestRegistry_ProtocolPaneRows(t *testing.T) {
	t.Run("one client gets its own row count", func(t *testing.T) {
		s := newStream("s")
		s.Attach("a", 80, 24)
		if s.MinRows() != 24 {
			t.Fatal(s.MinRows())
		}
	})
	t.Run("two clients get the smaller row count", func(t *testing.T) {
		s := newStream("s")
		s.Attach("a", 80, 20)
		s.Attach("b", 80, 60)
		if s.MinRows() != 20 {
			t.Fatal(s.MinRows())
		}
	})
	t.Run("no clients resizes nothing", func(t *testing.T) {
		// 0 is the "resize nothing" answer; applySize skips it.
		if newStream("s").MinRows() != 0 {
			t.Fatal("a default row count for an unwatched pane")
		}
	})
	t.Run("a client detaching lets the pane grow back", func(t *testing.T) {
		s := newStream("s")
		s.Attach("phone", 80, 40)
		s.Attach("laptop", 80, 50)
		if s.MinRows() != 40 {
			t.Fatal(s.MinRows())
		}
		s.Detach("phone")
		if s.MinRows() != 50 {
			t.Fatal(s.MinRows())
		}
	})
}
