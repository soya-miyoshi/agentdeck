package main

// Port of src/reap.test.ts, src/reap-schedule.test.ts, src/claude-hooks.test.ts,
// src/turn-transport.test.ts, src/tailnet.test.ts, src/cwds.test.ts, src/repo-scan.test.ts and
// src/agent-profiles.test.ts. Every reaper fixture is confined to its own roots, tmux directory and
// agentdeck-gotest- socket namespace, and only processes started here are ever candidates.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

// ---- shared helpers

var (
	cfgBuildOnce sync.Once
	cfgBin       string
	cfgBuildErr  error
)

// cfgBinary builds this package once per test process into a temp dir.
func cfgBinary(t *testing.T) string {
	t.Helper()
	cfgBuildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "agentdeck-gotest-cfgbin-")
		if err != nil {
			cfgBuildErr = err
			return
		}
		cfgBin = filepath.Join(dir, "agentdeck")
		out, err := exec.Command("go", "build", "-o", cfgBin, ".").CombinedOutput()
		if err != nil {
			cfgBuildErr = fmt.Errorf("go build: %v\n%s", err, out)
		}
	})
	if cfgBuildErr != nil {
		t.Fatal(cfgBuildErr)
	}
	return cfgBin
}

// cfgRepoFile is a file of the checkout this package lives in; AGENTDECK_REPO names it elsewhere.
func cfgRepoFile(t *testing.T, rel string) string {
	t.Helper()
	root := os.Getenv("AGENTDECK_REPO")
	if root == "" {
		root = ".."
	}
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("read %s (set AGENTDECK_REPO to the checkout): %v", rel, err)
	}
	return string(b)
}

func cfgMatch(t *testing.T, text, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Errorf("expected /%s/ in:\n%s", pattern, text)
	}
}

func cfgNoMatch(t *testing.T, text, pattern string) {
	t.Helper()
	if regexp.MustCompile(pattern).MatchString(text) {
		t.Errorf("did not expect /%s/ in:\n%s", pattern, text)
	}
}

// cfgShortTemp is a short temp dir, because a tmux socket path has a ~104 byte limit.
func cfgShortTemp(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", name)
	if err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(real) })
	return real
}

func cfgRealTemp(t *testing.T) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func cfgFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

// cfgAlive counts a zombie as gone: kill(pid, 0) succeeds against one.
func cfgAlive(pid int) bool {
	if pid <= 1 || syscall.Kill(pid, 0) != nil {
		return false
	}
	out, _ := exec.Command("/bin/ps", "-o", "state=", "-p", strconv.Itoa(pid)).Output()
	return !strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}

func cfgPpid(pid int) int {
	out, _ := exec.Command("/bin/ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

func cfgListens(pid int) bool {
	out, _ := exec.Command("/usr/sbin/lsof", "-a", "-p", strconv.Itoa(pid), "-i", "-sTCP:LISTEN").Output()
	return strings.TrimSpace(string(out)) != ""
}

// cfgStrays SIGKILLs every pid recorded, at cleanup; pid > 1 because 0 and -1 are groups.
type cfgStrays struct {
	mu   sync.Mutex
	pids []int
}

func (s *cfgStrays) add(pids ...int) {
	s.mu.Lock()
	s.pids = append(s.pids, pids...)
	s.mu.Unlock()
}

func (s *cfgStrays) killAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.pids {
		if p > 1 {
			_ = syscall.Kill(p, syscall.SIGKILL)
		}
	}
}

// cfgOrphan starts `command` under cwd with ppid 1 and no controlling terminal: a leftover's shape.
func cfgOrphan(t *testing.T, strays *cfgStrays, cwd, command string, env ...string) int {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "cd "+shellQuote(cwd)+" && "+command+" >/dev/null 2>&1 & echo $!")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	if pid <= 1 {
		t.Fatalf("orphan printed no pid: %q", out)
	}
	strays.add(pid)
	for i := 0; i < 100 && cfgPpid(pid) != 1; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	return pid
}

// TestConfig_HelperProcess is not a test: the fixtures re-run this binary as a listener or an idler.
func TestConfig_HelperProcess(t *testing.T) {
	switch os.Getenv("CFG_HELPER") {
	case "listen":
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(1)
		}
		defer l.Close()
	case "idle":
	default:
		return
	}
	for {
		time.Sleep(time.Hour)
	}
}

func cfgHelperCommand(mode string, extra ...string) string {
	exe, _ := os.Executable()
	return "CFG_HELPER=" + mode + " exec " + shellQuote(exe) + " -test.run=^TestConfig_HelperProcess$ " + strings.Join(extra, " ")
}

// cfgTmuxEnv is an environment whose tmux reaches only sockets under tmuxDir.
func cfgTmuxEnv(tmuxDir string) []string {
	var env []string
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "TMUX=") && !strings.HasPrefix(e, "TMUX_TMPDIR=") {
			env = append(env, e)
		}
	}
	if tmuxDir == "" {
		return env
	}
	return append(env, "TMUX_TMPDIR="+tmuxDir)
}

func cfgTmux(t *testing.T, tmuxDir string, args ...string) string {
	t.Helper()
	if !strings.HasPrefix(args[1], "agentdeck-gotest-") {
		t.Fatalf("refusing a tmux socket outside the test namespace: %s", args[1])
	}
	cmd := exec.Command("tmux", args...)
	cmd.Env = cfgTmuxEnv(tmuxDir)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("tmux %v: %v", args, err)
	}
	return string(out)
}

func cfgKillTmux(tmuxDir, socket string) {
	cmd := exec.Command("tmux", "-L", socket, "kill-server")
	cmd.Env = cfgTmuxEnv(tmuxDir)
	_ = cmd.Run()
	dir := tmuxDir
	if dir == "" {
		dir = "/tmp"
	}
	_ = os.Remove(filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()), socket))
}

func cfgSocketAnswers(tmuxDir, socket string) bool {
	cmd := exec.Command("tmux", "-L", socket, "list-sessions")
	cmd.Env = cfgTmuxEnv(tmuxDir)
	out, err := cmd.CombinedOutput()
	return err == nil || regexp.MustCompile(`(?i)no sessions`).Match(out)
}

func cfgChildren(pid int) []int {
	out, _ := exec.Command("/usr/bin/pgrep", "-P", strconv.Itoa(pid)).Output()
	var kids []int
	for _, l := range strings.Fields(string(out)) {
		if n, err := strconv.Atoi(l); err == nil && n > 1 {
			kids = append(kids, n)
		}
	}
	return kids
}

// cfgLockedBuffer is a writer two goroutines may share.
type cfgLockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *cfgLockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *cfgLockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type cfgServer struct {
	cmd            *exec.Cmd
	stdout, stderr *cfgLockedBuffer
	exited         chan struct{}
}

func (s *cfgServer) out() string { return s.stdout.String() + s.stderr.String() }

// cfgBoot starts the real server with exactly env, and returns once it listens or exits.
func cfgBoot(t *testing.T, tmuxDir, socket string, env map[string]string) *cfgServer {
	t.Helper()
	bin := cfgBinary(t)
	home := cfgRealTemp(t)
	full := map[string]string{
		"PATH":                      getenv("PATH", "/usr/bin:/bin"),
		"HOME":                      home,
		"TERM":                      "dumb",
		"TMUX_SOCKET":               socket,
		"TMUX_TMPDIR":               tmuxDir,
		"AGENTDECK_PORT":            strconv.Itoa(cfgFreePort(t)),
		"AGENTDECK_AGENT_STATE_DIR": filepath.Join(home, "agent-state"),
		"AGENTDECK_TAILSCALE":       filepath.Join(home, "no-tailscale-here"),
	}
	for k, v := range env {
		full[k] = v
	}
	s := &cfgServer{stdout: &cfgLockedBuffer{}, stderr: &cfgLockedBuffer{}, exited: make(chan struct{})}
	s.cmd = exec.Command(bin)
	s.cmd.Dir = home
	for k, v := range full {
		s.cmd.Env = append(s.cmd.Env, k+"="+v)
	}
	s.cmd.Stdout, s.cmd.Stderr = s.stdout, s.stderr
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.cmd.Wait(); close(s.exited) }()
	t.Cleanup(func() {
		_ = s.cmd.Process.Kill()
		<-s.exited
		cfgKillTmux(tmuxDir, socket)
		// The server's tmux drops TMUX_TMPDIR, so its socket is in tmux's default directory.
		cfgKillTmux("", socket)
	})
	deadline := time.Now().Add(20 * time.Second)
	for !strings.Contains(s.stdout.String(), "listening on") {
		select {
		case <-s.exited:
			return s
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server neither listened nor exited in 20s\n%s", s.out())
		}
		time.Sleep(50 * time.Millisecond)
	}
	return s
}

// ---- src/agent-profiles.test.ts

func cfgOneProfile(t *testing.T, raw, id string) *AgentProfile {
	t.Helper()
	profiles, rejected := parseProfiles([]byte(raw))
	p := profiles[id]
	if p == nil {
		t.Fatalf("no profile %s: %v", id, rejected)
	}
	return p
}

func TestConfig_AgentProfiles(t *testing.T) {
	t.Run("a minimal profile needs only a command", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude"}}`, "claude")
		if p.Command != "claude" || p.Name != "claude" || len(p.Args) != 0 {
			t.Fatalf("%+v", p)
		}
	})

	t.Run("a profile with no command is rejected, and the others survive", func(t *testing.T) {
		profiles, rejected := parseProfiles([]byte(`{"broken":{"name":"Broken"},"shell":{"command":"/bin/zsh"}}`))
		if profiles["broken"] != nil || profiles["shell"] == nil || len(rejected) != 1 {
			t.Fatalf("%v %v", profiles, rejected)
		}
		cfgMatch(t, rejected[0].Reason, `command`)
	})

	t.Run("env lists names, and a non-string entry rejects the profile", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude","env":["ANTHROPIC_API_KEY"]}}`, "claude")
		if strings.Join(p.Env, ",") != "ANTHROPIC_API_KEY" {
			t.Fatal(p.Env)
		}
		profiles, rejected := parseProfiles([]byte(`{"claude":{"command":"claude","env":[{"key":"secret"}]}}`))
		if profiles["claude"] != nil || len(rejected) != 1 {
			t.Fatal(profiles, rejected)
		}
		cfgMatch(t, rejected[0].Reason, `NAMES`)
	})

	t.Run("an absolute or escaping waiting.settings disables the mechanism", func(t *testing.T) {
		for _, settings := range []string{"/Users/someone/.claude/settings.json", "../../.claude/settings.json"} {
			raw, _ := json.Marshal(map[string]any{"claude": map[string]any{"command": "/bin/sh", "waiting": map[string]any{"via": "hook", "settings": settings}}})
			p := cfgOneProfile(t, string(raw), "claude")
			if p.Waiting != nil {
				t.Errorf("%s was accepted", settings)
			}
			cfgMatch(t, p.WaitingDisabledReason, `relative to the agent-state directory`)
		}
	})

	t.Run("hook without settings", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude","waiting":{"via":"hook"}}}`, "claude")
		if p.Waiting != nil || p.Command != "claude" {
			t.Fatalf("%+v", p)
		}
		cfgMatch(t, p.WaitingDisabledReason, `settings`)
	})

	t.Run("an unparseable screen regex", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude","waiting":{"via":"screen","match":"([unclosed"}}}`, "claude")
		if p.Waiting != nil {
			t.Fatalf("%+v", p.Waiting)
		}
		cfgMatch(t, p.WaitingDisabledReason, `regex`)
	})

	t.Run("an unknown via", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude","waiting":{"via":"telepathy"}}}`, "claude")
		if p.Waiting != nil {
			t.Fatalf("%+v", p.Waiting)
		}
		cfgMatch(t, p.WaitingDisabledReason, `telepathy`)
	})

	t.Run("a valid hook survives", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude","waiting":{"via":"hook","settings":"claude-hooks.json"}}}`, "claude")
		if p.Waiting == nil || *p.Waiting != (WaitingMechanism{Via: "hook", Settings: "claude-hooks.json"}) || p.WaitingDisabledReason != "" {
			t.Fatalf("%+v %q", p.Waiting, p.WaitingDisabledReason)
		}
	})

	t.Run("a command that does not resolve reports available: false", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"definitely-not-installed-xyz"}}`, "claude")
		t.Setenv("PATH", "/usr/bin:/bin")
		if summarise(p).Available {
			t.Fatal("reported available")
		}
	})

	pathOnly := func(path string) func(string) (string, bool) {
		return func(name string) (string, bool) {
			if name == "PATH" && path != "" {
				return path, true
			}
			return "", false
		}
	}

	t.Run("a real command resolves", func(t *testing.T) {
		if !resolvesOnPath("sh", pathOnly("/usr/bin:/bin")) {
			t.Fatal("sh did not resolve")
		}
	})

	t.Run("an absolute path is checked directly; a relative one is refused", func(t *testing.T) {
		if !resolvesOnPath("/bin/sh", pathOnly("")) {
			t.Error("/bin/sh did not resolve")
		}
		if resolvesOnPath("./sh", pathOnly("/bin")) {
			t.Error("./sh resolved")
		}
	})

	t.Run("detectsWaiting false is a supported configuration, not a defect", func(t *testing.T) {
		p := cfgOneProfile(t, `{"shell":{"command":"/bin/sh"}}`, "shell")
		if summarise(p).DetectsWaiting {
			t.Fatal("detectsWaiting true")
		}
	})

	t.Run("a disabled mechanism reports detectsWaiting false, like an absent one", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"/bin/sh","waiting":{"via":"hook"}}}`, "claude")
		if summarise(p).DetectsWaiting {
			t.Fatal("detectsWaiting true")
		}
	})

	lookupOf := func(m map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
	}

	t.Run("passes named variables through and drops unset ones", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude","env":["SET_ME","UNSET_ME"]}}`, "claude")
		env := spawnEnv(p, map[string]string{}, lookupOf(map[string]string{"SET_ME": "value"}))
		if len(env) != 1 || env["SET_ME"] != "value" {
			t.Fatal(env)
		}
		if _, ok := env["UNSET_ME"]; ok {
			t.Fatal("an unset name became an empty string")
		}
	})

	t.Run("carries the per-session extras the hook route authenticates against", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude"}}`, "claude")
		env := spawnEnv(p, map[string]string{"AGENTDECK_SESSION_ID": "s1", "AGENTDECK_SECRET": "abc"}, lookupOf(nil))
		if env["AGENTDECK_SESSION_ID"] != "s1" || env["AGENTDECK_SECRET"] != "abc" {
			t.Fatal(env)
		}
	})

	t.Run("extras win over passthrough, so a profile cannot shadow the session secret", func(t *testing.T) {
		p := cfgOneProfile(t, `{"claude":{"command":"claude","env":["AGENTDECK_SECRET"]}}`, "claude")
		env := spawnEnv(p, map[string]string{"AGENTDECK_SECRET": "real"}, lookupOf(map[string]string{"AGENTDECK_SECRET": "spoofed"}))
		if env["AGENTDECK_SECRET"] != "real" {
			t.Fatal(env)
		}
	})
}

// ---- src/repo-scan.test.ts

func TestConfig_RepoScan(t *testing.T) {
	root := t.TempDir()
	repo := func(parts ...string) string {
		dir := filepath.Join(append([]string{root}, parts...)...)
		if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	scan := func(roots ...string) []string { return scanRepos(roots, scanMaxDepth) }

	t.Run("a clone at ghq's own depth is found", func(t *testing.T) {
		cloned := repo("github.com", "someone", "thing")
		if !contains(scan(root), cloned) {
			t.Fatal("not found")
		}
	})

	t.Run("a repository appearing after an earlier scan is found by the next one", func(t *testing.T) {
		before := scan(root)
		cloned := repo("github.com", "someone", "cloned-just-now")
		if contains(before, cloned) || !contains(scan(root), cloned) {
			t.Fatal("not found by the next scan")
		}
	})

	t.Run("a worktree, whose .git is a file, is a repository", func(t *testing.T) {
		dir := filepath.Join(root, "github.com", "someone", "worktree")
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: /elsewhere\n"), 0o644)
		if !contains(scan(root), dir) {
			t.Fatal("worktree not found")
		}
	})

	t.Run("it does not descend into a repository", func(t *testing.T) {
		outer := repo("github.com", "someone", "outer")
		inner := filepath.Join(outer, "vendor", "inner")
		_ = os.MkdirAll(filepath.Join(inner, ".git"), 0o755)
		found := scan(root)
		if !contains(found, outer) || contains(found, inner) {
			t.Fatal(found)
		}
	})

	t.Run("a symlinked directory is not followed", func(t *testing.T) {
		target := t.TempDir()
		_ = os.MkdirAll(filepath.Join(target, "secret", ".git"), 0o755)
		if err := os.Symlink(target, filepath.Join(root, "linked")); err != nil {
			t.Fatal(err)
		}
		for _, p := range scan(root) {
			if strings.Contains(p, "secret") || p == filepath.Join(root, "linked") {
				t.Fatalf("followed the link: %s", p)
			}
		}
	})

	t.Run("the root itself is never startable, even holding a .git", func(t *testing.T) {
		own := t.TempDir()
		_ = os.MkdirAll(filepath.Join(own, ".git"), 0o755)
		if contains(scan(own), own) {
			t.Fatal("the root was listed")
		}
	})

	t.Run("hidden directories are skipped", func(t *testing.T) {
		hidden := filepath.Join(root, ".cache", "thing")
		_ = os.MkdirAll(filepath.Join(hidden, ".git"), 0o755)
		if contains(scan(root), hidden) {
			t.Fatal("hidden repo listed")
		}
	})

	t.Run("a repository below the depth bound is not found", func(t *testing.T) {
		deep := filepath.Join(root, "a", "b", "c", "d", "e")
		_ = os.MkdirAll(filepath.Join(deep, ".git"), 0o755)
		if contains(scan(root), deep) {
			t.Fatal("deep repo listed")
		}
	})

	t.Run("a root that does not exist yields nothing rather than throwing", func(t *testing.T) {
		if got := scan(filepath.Join(root, "no-such-root")); len(got) != 0 {
			t.Fatal(got)
		}
	})

	t.Run("results are absolute, sorted and unique across roots", func(t *testing.T) {
		found := scan(root, root)
		seen := map[string]bool{}
		for i, p := range found {
			if seen[p] || !filepath.IsAbs(p) || (i > 0 && found[i-1] > p) {
				t.Fatal(found)
			}
			seen[p] = true
		}
	})
}

// ---- src/cwds.test.ts

// cfgAllowlist is an allowlist whose scan is a variable, so "cloned since" is expressible.
func cfgAllowlist(mounts, roots []string, ttl time.Duration, scan func() []string) *Allowlist {
	a := newAllowlist(mounts, roots)
	a.scan = func([]string) []string { return scan() }
	a.ttl = ttl
	return a
}

func TestConfig_Cwds(t *testing.T) {
	list := newAllowlist([]string{"/workspace/agentdeck", "/workspace/web"}, nil)

	t.Run("allows exactly what is on the list", func(t *testing.T) {
		if !list.Allows("/workspace/agentdeck") || !list.Allows("/workspace/web") || list.Allows("/workspace/other") {
			t.Fatal("membership is not exact")
		}
	})

	t.Run("a trailing slash is the same directory", func(t *testing.T) {
		if !list.Allows("/workspace/agentdeck/") {
			t.Fatal("refused")
		}
	})

	t.Run("traversal does not escape", func(t *testing.T) {
		if list.Allows("/workspace/agentdeck/../../etc") {
			t.Error("escaped")
		}
		if !list.Allows("/workspace/agentdeck/./../web") {
			t.Error("resolves to a mounted path")
		}
	})

	t.Run("a subdirectory of a mounted repo is not itself startable", func(t *testing.T) {
		if list.Allows("/workspace/agentdeck/src") {
			t.Fatal("allowed")
		}
	})

	t.Run("a sibling sharing a prefix is refused", func(t *testing.T) {
		if list.Allows("/workspace/agentdeck-secrets") {
			t.Fatal("allowed")
		}
	})

	t.Run("the refusal names what would have to change, and its cost", func(t *testing.T) {
		m := list.Refusal("/workspace/newly-cloned")
		cfgMatch(t, m, `AGENTDECK_MOUNTS`)
		cfgMatch(t, m, `restart agentdeck`)
		cfgMatch(t, m, `/workspace/agentdeck`)
	})

	t.Run("the refusal prices the restart at what it actually costs now", func(t *testing.T) {
		m := list.Refusal("/workspace/newly-cloned")
		cfgNoMatch(t, m, `waiting detection stays dead`)
		cfgNoMatch(t, m, `secret does not survive`)
		cfgMatch(t, m, `still able to report waiting`)
		cfgMatch(t, m, `derived rather than minted`)
	})

	t.Run("the README prices it the same way, since that is what a person reads first", func(t *testing.T) {
		readme := cfgRepoFile(t, "README.md")
		cfgNoMatch(t, readme, "never `waiting` again")
		cfgMatch(t, readme, `hook\s+secret comes back too`)
		cfgMatch(t, readme, `HMAC\(bearer token, session id\)`)
	})

	claims := []string{
		`agentdeck only knows a session's directory for the\s+sessions it started`,
		`start by hand[^.]*does \*\*not\*\* appear as a tab`,
		`session started by\s+hand under that socket does not appear as a tab`,
		`session started by hand in tmux does not appear as a tab`,
	}
	read := func(t *testing.T, file string) string {
		if strings.HasPrefix(file, "server-go/") {
			b, err := os.ReadFile(strings.TrimPrefix(file, "server-go/"))
			if err != nil {
				t.Fatal(err)
			}
			return string(b)
		}
		return cfgRepoFile(t, file)
	}
	// hub.ts's statement lives on Registry.List in the Go port.
	for _, c := range []struct{ file, states string }{
		{"SECURITY.md", "its name is exactly the one\nagentdeck would derive"},
		{"plans/005-containment.md", "its name equals\n> `sessionId\\(that path, a configured agent\\)`"},
		{"server-go/registry.go", `filtered to allowed paths whose name matches \(path, a configured agent\)`},
	} {
		t.Run(c.file+" does not claim a hand-started session can never be listed", func(t *testing.T) {
			text := read(t, c.file)
			for _, claim := range claims {
				cfgNoMatch(t, text, claim)
			}
			cfgMatch(t, text, c.states)
		})
	}

	t.Run("a session whose directory is unknown is never allowed", func(t *testing.T) {
		if list.Allows("") {
			t.Fatal("allowed the unknown directory")
		}
	})

	t.Run("it names the metadata the surviving sessions lose", func(t *testing.T) {
		plan := cfgRepoFile(t, "plans/006-availability.md")
		cfgMatch(t, plan, `hook secret in memory only`)
		cfgMatch(t, plan, "never\\s+reports `waiting` again")
		cfgMatch(t, plan, `known gap`)
	})

	withRoots := func(repos *[]string) *Allowlist {
		return cfgAllowlist([]string{"/workspace/pinned"}, []string{"/roots"}, 0, func() []string { return append([]string{}, *repos...) })
	}

	t.Run("a repository cloned since the server started is startable", func(t *testing.T) {
		repos := []string{"/roots/host/owner/one"}
		l := withRoots(&repos)
		if l.Allows("/roots/host/owner/two") {
			t.Fatal("allowed before the clone")
		}
		repos = append(repos, "/roots/host/owner/two")
		if !l.Allows("/roots/host/owner/two") {
			t.Fatal("no restart should be needed")
		}
	})

	t.Run("the fixed entries survive alongside the scanned ones", func(t *testing.T) {
		repos := []string{"/roots/host/owner/one"}
		l := withRoots(&repos)
		if !l.Allows("/workspace/pinned") || !l.Allows("/roots/host/owner/one") {
			t.Fatal("lost an entry")
		}
	})

	t.Run("the root itself is not startable, and nor is a stranger under it", func(t *testing.T) {
		repos := []string{"/roots/host/owner/one"}
		l := withRoots(&repos)
		for _, p := range []string{"/roots", "/roots/host/owner", "/roots/host/owner/one/src"} {
			if l.Allows(p) {
				t.Errorf("%s allowed", p)
			}
		}
	})

	t.Run("a scan is reused within its window rather than run per session", func(t *testing.T) {
		scans := 0
		l := cfgAllowlist(nil, []string{"/roots"}, time.Minute, func() []string { scans++; return []string{"/roots/host/owner/one"} })
		l.Allows("/roots/host/owner/one")
		l.Allows("/roots/host/owner/one")
		l.List(map[string][]string{})
		if scans != 1 {
			t.Fatalf("%d scans", scans)
		}
	})

	t.Run("no roots means no scan at all", func(t *testing.T) {
		scans := 0
		l := cfgAllowlist([]string{"/workspace/pinned"}, nil, time.Minute, func() []string { scans++; return nil })
		if !l.Allows("/workspace/pinned") || scans != 0 {
			t.Fatalf("scans=%d", scans)
		}
	})

	t.Run("the refusal offers the clone before the restart, and prices only the restart", func(t *testing.T) {
		repos := []string{"/roots/host/owner/one"}
		m := withRoots(&repos).Refusal("/elsewhere/thing")
		cfgMatch(t, m, `Clone it under one of /roots`)
		cfgMatch(t, m, `with no restart`)
		if strings.Index(m, "Clone it under") > strings.Index(m, "AGENTDECK_MOUNTS") {
			t.Error("the free way out should come first")
		}
		cfgMatch(t, m, `derived rather than minted`)
	})

	t.Run("each entry carries its basename and the sessions already there", func(t *testing.T) {
		got := list.List(map[string][]string{"/workspace/agentdeck": {"agentdeck-claude-abc"}})
		want := []Cwd{
			{Path: "/workspace/agentdeck", Name: "agentdeck", Sessions: []string{"agentdeck-claude-abc"}},
			{Path: "/workspace/web", Name: "web", Sessions: []string{}},
		}
		a, _ := json.Marshal(got)
		b, _ := json.Marshal(want)
		if string(a) != string(b) {
			t.Fatalf("%s != %s", a, b)
		}
	})

	t.Run("two repositories sharing a basename are told apart by their owner", func(t *testing.T) {
		l := cfgAllowlist(nil, []string{"/roots"}, 0, func() []string {
			return []string{"/roots/github.com/alice/dotfiles", "/roots/github.com/bob/dotfiles"}
		})
		var names []string
		for _, c := range l.List(map[string][]string{}) {
			names = append(names, c.Name)
		}
		if strings.Join(names, ",") != "alice/dotfiles,bob/dotfiles" {
			t.Fatal(names)
		}
	})

	t.Run("the returned session arrays are copies", func(t *testing.T) {
		live := []string{"a"}
		entries := list.List(map[string][]string{"/workspace/agentdeck": live})
		entries[0].Sessions = append(entries[0].Sessions, "b")
		entries[0].Sessions[0] = "mutated"
		if strings.Join(live, ",") != "a" {
			t.Fatal(live)
		}
	})
}

// ---- src/tailnet.test.ts

const cfgCertsOff = `{"Self":{"DNSName":"example-host.tailXXXXXX.ts.net."},"CertDomains":null,"MagicDNSSuffix":"tailXXXXXX.ts.net"}`
const cfgCertsOn = `{"Self":{"DNSName":"example-host.tailXXXXXX.ts.net."},"CertDomains":["example-host.tailXXXXXX.ts.net"],"MagicDNSSuffix":"tailXXXXXX.ts.net"}`

func cfgParse(t *testing.T, raw string) *Tailnet {
	t.Helper()
	tn, err := parseTailnetStatus([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return tn
}

// cfgStubTailscale writes a `tailscale` printing body for `status --json` after delay seconds.
func cfgStubTailscale(t *testing.T, path, body string, delay, exit int) {
	t.Helper()
	script := fmt.Sprintf("#!/bin/sh\nsleep %d\necho 'Warning: client version mismatch' >&2\ncat <<'JSON'\n%s\nJSON\nexit %d\n", delay, body, exit)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestConfig_Tailnet(t *testing.T) {
	t.Run("the origin drops DNSName's trailing dot", func(t *testing.T) {
		if o := cfgParse(t, cfgCertsOff).Origin; o != "https://example-host.tailXXXXXX.ts.net" {
			t.Fatal(o)
		}
	})

	t.Run("a null CertDomains is HTTPS certificates being off", func(t *testing.T) {
		if cfgParse(t, cfgCertsOff).HTTPSCertificates || !cfgParse(t, cfgCertsOn).HTTPSCertificates {
			t.Fatal("wrong certificate state")
		}
	})

	t.Run("no MagicDNS name means no origin rather than a broken one", func(t *testing.T) {
		if o := cfgParse(t, `{"Self":{},"CertDomains":null}`).Origin; o != "" {
			t.Fatal(o)
		}
	})

	t.Run("AGENTDECK_TAILSCALE wins, and only if it exists", func(t *testing.T) {
		t.Setenv("AGENTDECK_TAILSCALE", "/bin/sh")
		if b := tailscaleBinary(); b != "/bin/sh" {
			t.Fatal(b)
		}
		t.Setenv("AGENTDECK_TAILSCALE", "/nowhere/tailscale")
		if b := tailscaleBinary(); b != "" {
			t.Fatal(b)
		}
	})

	advice := func(tn *Tailnet, port int, origin string) string {
		return strings.Join(tailnetAdvice(tn, port, origin), "\n")
	}

	t.Run("certificates off names the state, the settings page and the hang", func(t *testing.T) {
		a := advice(cfgParse(t, cfgCertsOff), 7777, "")
		cfgMatch(t, a, `HTTPS certificates are DISABLED`)
		if !strings.Contains(a, adminDNSPage) {
			t.Error("no admin page")
		}
		cfgMatch(t, a, `waits forever|timeout`)
	})

	t.Run("the AGENTDECK_ORIGIN advice names the actual value, not a placeholder", func(t *testing.T) {
		a := advice(cfgParse(t, cfgCertsOn), 7777, "")
		cfgMatch(t, a, `AGENTDECK_ORIGIN=https://example-host\.tailXXXXXX\.ts\.net\b`)
		cfgNoMatch(t, a, `<host>`)
	})

	t.Run("the serve command names the port the server actually listened on", func(t *testing.T) {
		cfgMatch(t, advice(cfgParse(t, cfgCertsOn), 7999, ""), `tailscale serve --bg 7999`)
	})

	t.Run("an origin that is not this machine's is called out rather than left to a 403", func(t *testing.T) {
		cfgMatch(t, advice(cfgParse(t, cfgCertsOn), 7777, "https://somewhere-else.ts.net"), `403`)
	})

	t.Run("a configured origin that matches is not nagged about", func(t *testing.T) {
		a := advice(cfgParse(t, cfgCertsOn), 7777, "https://example-host.tailXXXXXX.ts.net")
		cfgNoMatch(t, a, `AGENTDECK_ORIGIN=`)
		cfgNoMatch(t, a, `403`)
	})

	t.Run("no tailscale at all says so instead of claiming a URL", func(t *testing.T) {
		a := advice(nil, 7777, "")
		cfgMatch(t, a, "could not read `tailscale status --json`")
		cfgNoMatch(t, a, `https://[a-z0-9-]+\.ts\.net`)
	})

	t.Run("the plan names both switches, the hang and the admin page", func(t *testing.T) {
		plan := cfgRepoFile(t, "plans/006-availability.md")
		cfgMatch(t, plan, `CertDomains`)
		cfgMatch(t, plan, `Serve is not enabled on your tailnet`)
		if !strings.Contains(plan, adminDNSPage) {
			t.Error("no admin page")
		}
		cfgMatch(t, plan, "agentdeck does not run `tailscale serve` itself")
	})

	dir := t.TempDir()
	stub := filepath.Join(dir, "tailscale")
	read := func(t *testing.T) *Tailnet {
		t.Setenv("AGENTDECK_TAILSCALE", stub)
		return readTailnet(context.Background())
	}

	t.Run("the two facts come back out of the process, warnings on stderr and all", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOff, 0, 0)
		tn := read(t)
		if tn == nil || *tn != (Tailnet{Origin: "https://example-host.tailXXXXXX.ts.net", HTTPSCertificates: false}) {
			t.Fatalf("%+v", tn)
		}
	})

	t.Run("no binary at the named path is undefined, not a throw and not a PATH search", func(t *testing.T) {
		t.Setenv("AGENTDECK_TAILSCALE", filepath.Join(dir, "nowhere", "tailscale"))
		if tn := readTailnet(context.Background()); tn != nil {
			t.Fatalf("%+v", tn)
		}
	})

	t.Run("output that is not JSON is nothing known, not a crashed boot", func(t *testing.T) {
		cfgStubTailscale(t, stub, "tailscaled is not running", 0, 0)
		if tn := read(t); tn != nil {
			t.Fatalf("%+v", tn)
		}
	})

	t.Run("a non-zero exit is nothing known", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOn, 0, 1)
		if tn := read(t); tn != nil {
			t.Fatalf("%+v", tn)
		}
	})

	t.Run("a tailscale that never answers is timed out, not waited on", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOn, 30, 0)
		started := time.Now()
		if tn := read(t); tn != nil {
			t.Fatalf("%+v", tn)
		}
		if time.Since(started) >= 10*time.Second {
			t.Fatalf("readTailnet waited %s on a wedged tailscale", time.Since(started))
		}
	})

	tmuxDir := cfgShortTemp(t, "cfgtn")
	socketN := 0
	boot := func(t *testing.T, env map[string]string) *cfgServer {
		socketN++
		socket := fmt.Sprintf("agentdeck-gotest-cfg-tailnet-%d-%d", os.Getpid(), socketN)
		full := map[string]string{"AGENTDECK_TAILSCALE": stub}
		for k, v := range env {
			full[k] = v
		}
		return cfgBoot(t, tmuxDir, socket, full)
	}

	t.Run("the boot names the missing switch, the page, and still serves loopback", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOff, 0, 0)
		s := boot(t, nil)
		cfgMatch(t, s.stdout.String(), `listening on`)
		cfgMatch(t, s.stderr.String(), `HTTPS certificates are DISABLED`)
		if !strings.Contains(s.stderr.String(), adminDNSPage) {
			t.Error("no admin page")
		}
	})

	t.Run("the boot prints the AGENTDECK_ORIGIN to run behind the proxy, in full", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOn, 0, 0)
		s := boot(t, nil)
		cfgMatch(t, s.stderr.String(), `AGENTDECK_ORIGIN=https://example-host\.tailXXXXXX\.ts\.net\b`)
		cfgMatch(t, s.stderr.String(), `tailscale serve --bg \d+`)
	})

	t.Run("an AGENTDECK_ORIGIN that is not this machine's is called out at boot", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOn, 0, 0)
		s := boot(t, map[string]string{"AGENTDECK_ORIGIN": "https://other.tailXXXXXX.ts.net"})
		cfgMatch(t, s.stderr.String(), `403`)
		cfgNoMatch(t, s.stderr.String(), `AGENTDECK_ORIGIN is not set`)
	})

	t.Run("the right AGENTDECK_ORIGIN boots quietly", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOn, 0, 0)
		s := boot(t, map[string]string{"AGENTDECK_ORIGIN": "https://example-host.tailXXXXXX.ts.net"})
		cfgMatch(t, s.stdout.String(), `listening on`)
		cfgNoMatch(t, s.stderr.String(), `AGENTDECK_ORIGIN=`)
		cfgNoMatch(t, s.stderr.String(), `403`)
	})

	t.Run("a wedged tailscale delays the boot by seconds, it does not prevent it", func(t *testing.T) {
		cfgStubTailscale(t, stub, cfgCertsOn, 30, 0)
		s := boot(t, nil)
		cfgMatch(t, s.stdout.String(), `listening on`)
		cfgMatch(t, s.stderr.String(), "could not read `tailscale status --json`")
	})

	t.Run("Self.DNSName and CertDomains are the fields this version emits", func(t *testing.T) {
		if os.Getenv("AGENTDECK_TAILSCALE") != "" {
			t.Skip("AGENTDECK_TAILSCALE names a binary; this checks the real one")
		}
		bin := tailscaleBinary()
		if bin == "" {
			t.Skip("no tailscale on this machine")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, "status", "--json")
		cmd.Env = tailscaleEnv()
		cmd.WaitDelay = time.Second
		raw, err := cmd.Output()
		if err != nil {
			t.Skip("tailscale is not logged in or not running")
		}
		var status map[string]any
		if json.Unmarshal(raw, &status) != nil {
			t.Skip("tailscale printed no JSON")
		}
		if _, ok := status["CertDomains"]; !ok {
			t.Error("tailscale no longer reports CertDomains")
		}
		self, _ := status["Self"].(map[string]any)
		name, ok := self["DNSName"].(string)
		if !ok || !strings.HasSuffix(name, ".") {
			t.Errorf("DNSName lost the trailing dot the parser strips: %v", self["DNSName"])
		}
	})
}

// ---- src/claude-hooks.test.ts

func cfgFixtures(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(cfgRepoFile(t, "src/fixtures/claude-hooks.jsonl"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func cfgByEvent(t *testing.T, fixtures []map[string]any, name string) map[string]any {
	t.Helper()
	for _, f := range fixtures {
		if f["hook_event_name"] == name {
			c := map[string]any{}
			for k, v := range f {
				c[k] = v
			}
			return c
		}
	}
	t.Fatalf("the fixture file should contain a %s payload", name)
	return nil
}

func cfgReadJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func cfgHookCommand(t *testing.T, port int, binary string) string {
	t.Helper()
	c, err := hookCommand(port, binary)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConfig_ClaudeHooks(t *testing.T) {
	fixtures := cfgFixtures(t)

	t.Run("the in-turn events mean working", func(t *testing.T) {
		for _, name := range []string{"UserPromptSubmit", "PreToolUse", "PostToolUse"} {
			if s, _ := mapHookEvent(cfgByEvent(t, fixtures, name)); s != StateWorking {
				t.Errorf("%s: %q", name, s)
			}
		}
	})

	t.Run("Stop means waiting", func(t *testing.T) {
		if s, _ := mapHookEvent(cfgByEvent(t, fixtures, "Stop")); s != StateWaiting {
			t.Fatal(s)
		}
	})

	t.Run("both observed Notification subtypes mean waiting", func(t *testing.T) {
		var types []string
		for _, f := range fixtures {
			if f["hook_event_name"] != "Notification" {
				continue
			}
			nt, _ := f["notification_type"].(string)
			types = append(types, nt)
			if s, _ := mapHookEvent(f); s != StateWaiting {
				t.Errorf("%s: %q", nt, s)
			}
		}
		if len(types) != 2 || !contains(types, "idle_prompt") || !contains(types, "permission_prompt") {
			t.Fatal(types)
		}
	})

	t.Run("an unrecognised notification_type is ACTIONABLE", func(t *testing.T) {
		p := cfgByEvent(t, fixtures, "Notification")
		p["notification_type"] = "some_subtype_from_a_later_release"
		if s, _ := mapHookEvent(p); s != StateWaiting {
			t.Fatal(s)
		}
	})

	t.Run("a Notification with no notification_type at all is still actionable", func(t *testing.T) {
		p := cfgByEvent(t, fixtures, "Notification")
		delete(p, "notification_type")
		if s, _ := mapHookEvent(p); s != StateWaiting {
			t.Fatal(s)
		}
	})

	t.Run("an unrecognised EVENT NAME changes no state and says why", func(t *testing.T) {
		s, reason := mapHookEvent(map[string]any{"hook_event_name": "PreCompact", "trigger": "auto"})
		if s != "" {
			t.Fatal(s)
		}
		cfgMatch(t, reason, `PreCompact`)
	})

	t.Run("observed-but-unmapped events change no state either", func(t *testing.T) {
		for _, name := range []string{"SessionStart", "SessionEnd"} {
			if s, _ := mapHookEvent(cfgByEvent(t, fixtures, name)); s != "" {
				t.Errorf("%s: %q", name, s)
			}
		}
	})

	t.Run("an informational notification_type does not raise attention", func(t *testing.T) {
		p := cfgByEvent(t, fixtures, "Notification")
		p["notification_type"] = "observed_as_informational"
		informationalNotificationTypes["observed_as_informational"] = true
		defer delete(informationalNotificationTypes, "observed_as_informational")
		if s, _ := mapHookEvent(p); s != "" {
			t.Fatal(s)
		}
	})

	t.Run("a subagent finishing mid-turn does NOT flag the tab", func(t *testing.T) {
		p := cfgByEvent(t, fixtures, "SubagentStop")
		if p["agent_type"] != "Explore" {
			t.Fatal(p["agent_type"])
		}
		if s, _ := mapHookEvent(p); s != "" {
			t.Fatal(s)
		}
	})

	t.Run("junk is refused rather than interpreted", func(t *testing.T) {
		for _, junk := range []any{nil, "Stop", map[string]any{"hook_event_name": 7.0}} {
			if s, _ := mapHookEvent(junk); s != "" {
				t.Errorf("%v: %q", junk, s)
			}
		}
	})

	t.Run("carries the session id and secret from the environment, not from the file", func(t *testing.T) {
		command := cfgHookCommand(t, 7777, "/usr/local/bin/agentdeck")
		cfgMatch(t, command, `\$AGENTDECK_SESSION_ID`)
		cfgNoMatch(t, command, `(?i)Authorization`)
		// The secret is nowhere in the line, so it can only be what the hook reads from its environment.
		got := cfgRunHook(t, `{"hook_event_name":"Stop"}`, map[string]string{"AGENTDECK_SESSION_ID": "s1", "AGENTDECK_SECRET": "from-the-env"})
		if got.secret != "from-the-env" || got.path != "/api/hooks/s1" {
			t.Fatalf("secret %q path %q", got.secret, got.path)
		}
	})

	t.Run("never expands the secret into an argument, where ps would show it", func(t *testing.T) {
		command := cfgHookCommand(t, 7777, "/usr/local/bin/agentdeck")
		cfgNoMatch(t, command, `\$AGENTDECK_SECRET`)
		cfgNoMatch(t, command, `\$\{AGENTDECK_SECRET`)
		dir := t.TempDir()
		argvFile := filepath.Join(dir, "argv")
		stub := filepath.Join(dir, "agentdeck")
		_ = os.WriteFile(stub, []byte("#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\" > "+shellQuote(argvFile)+"\n"), 0o755)
		cmd := exec.Command("/bin/sh", "-c", cfgHookCommand(t, 7777, stub))
		cmd.Env = []string{"PATH=" + dir, "AGENTDECK_SESSION_ID=s1", "AGENTDECK_SECRET=s3cret-value"}
		if err := cmd.Run(); err != nil {
			t.Fatal(err)
		}
		argv, err := os.ReadFile(argvFile)
		if err != nil {
			t.Fatal("the stub never ran")
		}
		if strings.Contains(string(argv), "s3cret-value") {
			t.Fatalf("secret leaked into argv: %s", argv)
		}
	})

	t.Run("runs the interpreter by absolute path, so a minimal PATH still posts", func(t *testing.T) {
		command := cfgHookCommand(t, 7777, "/opt/agentdeck/bin/agentdeck")
		if !strings.Contains(command, "'/opt/agentdeck/bin/agentdeck' hook") {
			t.Fatalf("expected the binary's absolute path in: %s", command)
		}
		dir := t.TempDir()
		marker := filepath.Join(dir, "ran")
		stub := filepath.Join(dir, "interp")
		_ = os.WriteFile(stub, []byte("#!/bin/sh\nprintf ok > "+shellQuote(marker)+"\n"), 0o755)
		cmd := exec.Command("/bin/sh", "-c", cfgHookCommand(t, 7777, stub))
		cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "AGENTDECK_SESSION_ID=s1"}
		if err := cmd.Run(); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(marker); string(b) != "ok" {
			t.Fatal("the interpreter did not run")
		}
	})

	t.Run("refuses a bare interpreter name rather than emitting one", func(t *testing.T) {
		_, err := hookCommand(7777, "agentdeck")
		if err == nil || !strings.Contains(err.Error(), "absolute path") {
			t.Fatal(err)
		}
	})

	ours := func(port int) string { return cfgHookCommand(t, port, "/usr/local/bin/agentdeck") }

	t.Run("a stranger's hook whose command contains the marker is not ours to delete", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.json")
		stranger := "curl -s 127.0.0.1:9000/api/hooks/mine"
		raw, _ := json.Marshal(map[string]any{"hooks": map[string]any{"Stop": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": stranger}}}}}})
		_ = os.WriteFile(path, append(raw, '\n'), 0o644)
		for i := 0; i < 2; i++ {
			if _, err := installHookSettings(path, ours(7777)); err != nil {
				t.Fatal(err)
			}
		}
		stop, _ := json.Marshal(cfgReadJSON(t, path)["hooks"].(map[string]any)["Stop"])
		cfgMatch(t, string(stop), `9000/api/hooks/mine`)
	})

	t.Run("merges once and idempotently, preserving keys it did not write", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.json")
		_ = os.WriteFile(path, []byte(`{
  "model": "opus",
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "echo compacting" }] }]
  }
}
`), 0o644)
		if changed, err := installHookSettings(path, ours(7777)); err != nil || !changed {
			t.Fatal(changed, err)
		}
		first, _ := os.ReadFile(path)
		if changed, err := installHookSettings(path, ours(7777)); err != nil || changed {
			t.Fatal(changed, err)
		}
		if again, _ := os.ReadFile(path); string(again) != string(first) {
			t.Fatal("a second merge changed the file")
		}
		parsed := cfgReadJSON(t, path)
		if parsed["model"] != "opus" {
			t.Error("a key we did not write was lost")
		}
		hooks := parsed["hooks"].(map[string]any)
		pre, _ := json.Marshal(hooks["PreCompact"])
		if string(pre) != `[{"hooks":[{"command":"echo compacting","type":"command"}]}]` {
			t.Errorf("an event we do not install was changed: %s", pre)
		}
		stop, _ := json.Marshal(hooks["Stop"])
		cfgMatch(t, string(stop), `say done`)
		cfgMatch(t, string(stop), `api/hooks`)
		n := 0
		for _, e := range hooks["Stop"].([]any) {
			b, _ := json.Marshal(e)
			if strings.Contains(string(b), "api/hooks") {
				n++
			}
		}
		if n != 1 {
			t.Errorf("%d agentdeck entries", n)
		}
	})

	t.Run("writes a whole file when there is none, and stays idempotent", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "nested", "settings.json")
		if changed, err := installHookSettings(path, ours(7777)); err != nil || !changed {
			t.Fatal(changed, err)
		}
		if changed, err := installHookSettings(path, ours(7777)); err != nil || changed {
			t.Fatal(changed, err)
		}
	})

	t.Run("replaces our previous entry when the port changes rather than adding a second", func(t *testing.T) {
		var once any = mergeHookSettings(map[string]any{}, ours(7777))
		// Round-tripped, as a file read back at the next boot is.
		b, _ := json.Marshal(once)
		_ = json.Unmarshal(b, &once)
		twice := mergeHookSettings(once, ours(7788))
		stop := twice["hooks"].(map[string]any)["Stop"].([]any)
		n := 0
		for _, e := range stop {
			s, _ := json.Marshal(e)
			if strings.Contains(string(s), hookMarker) {
				n++
			}
		}
		all, _ := json.Marshal(stop)
		if n != 1 || !strings.Contains(string(all), "7788") || strings.Contains(string(all), "7777") {
			t.Fatalf("%d entries: %s", n, all)
		}
	})

	t.Run("a malformed settings file is left exactly as the human left it", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.json")
		_ = os.WriteFile(path, []byte("{ this is not json"), 0o644)
		if _, err := installHookSettings(path, ours(7777)); err == nil {
			t.Fatal("no error")
		}
		if b, _ := os.ReadFile(path); string(b) != "{ this is not json" {
			t.Fatal(string(b))
		}
	})
}

// ---- src/turn-transport.test.ts

type cfgHookReceived struct {
	got           bool
	body          []byte
	payload       map[string]any
	secret, path  string
	exitCode      int
	commandOutput string
}

// cfgRunHook runs the built binary's hook command through a real shell at a local server.
func cfgRunHook(t *testing.T, stdin string, env map[string]string) cfgHookReceived {
	t.Helper()
	var mu sync.Mutex
	var r cfgHookReceived
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		mu.Lock()
		r.got, r.body, r.secret, r.path = true, body, req.Header.Get("X-Agentdeck-Secret"), req.URL.EscapedPath()
		_ = json.Unmarshal(body, &r.payload)
		mu.Unlock()
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	cmd := exec.Command("/bin/sh", "-c", cfgHookCommand(t, port, cfgBinary(t)))
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if exit, ok := err.(*exec.ExitError); ok {
		r.exitCode = exit.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	r.commandOutput = string(out)
	return r
}

func TestConfig_TurnTransport(t *testing.T) {
	session := map[string]string{"AGENTDECK_SESSION_ID": "s", "AGENTDECK_SECRET": "x"}
	post := func(t *testing.T, payload any) cfgHookReceived {
		b, _ := json.Marshal(payload)
		return cfgRunHook(t, string(b), session)
	}
	answerOf := func(r cfgHookReceived) string { s, _ := r.payload["last_assistant_message"].(string); return s }

	t.Run("an ordinary answer arrives byte for byte", func(t *testing.T) {
		answer := "# Heading\n\n- a list item\n\n```sh\necho hi\n```\n"
		if got := answerOf(post(t, map[string]any{"hook_event_name": "Stop", "prompt_id": "p", "last_assistant_message": answer})); got != answer {
			t.Fatalf("%q", got)
		}
	})

	huge := map[string]any{"hook_event_name": "Stop", "prompt_id": "p", "last_assistant_message": strings.Repeat("X", 500_000)}

	t.Run("a huge answer is cut down to something the route will accept", func(t *testing.T) {
		r := post(t, huge)
		if !r.got || len(r.body) >= 64*1024 {
			t.Fatalf("got=%v body was %d bytes", r.got, len(r.body))
		}
		if r.payload["hook_event_name"] != "Stop" {
			t.Fatal("the event name did not survive the cut")
		}
	})

	t.Run("a cut answer arrives long enough for the store to know it was cut", func(t *testing.T) {
		if n := utf8.RuneCountInString(answerOf(post(t, huge))); n <= maxFieldChars {
			t.Fatalf("the answer arrived at %d code points, at or under the bound", n)
		}
	})

	t.Run("a large multi-byte answer arrives with every character intact", func(t *testing.T) {
		got := answerOf(post(t, map[string]any{"hook_event_name": "Stop", "prompt_id": "p", "last_assistant_message": strings.Repeat("折", 30_000)}))
		if got == "" || strings.Trim(got, "折") != "" {
			t.Fatalf("damaged: %d bytes, valid=%v", len(got), utf8.ValidString(got))
		}
	})

	t.Run("a payload that is not JSON is dropped rather than sent as a broken body", func(t *testing.T) {
		if r := cfgRunHook(t, strings.Repeat("X", 400_000), session); r.got {
			t.Fatalf("an unparseable oversized payload was sent anyway (%d bytes)", len(r.body))
		}
	})

	t.Run("without AGENTDECK_SESSION_ID the hook does nothing and still exits 0", func(t *testing.T) {
		r := cfgRunHook(t, `{"hook_event_name":"Stop"}`, map[string]string{"AGENTDECK_SECRET": "x"})
		if r.got || r.exitCode != 0 {
			t.Fatalf("got=%v exit=%d", r.got, r.exitCode)
		}
	})

	t.Run("a hook whose server is gone exits 0 and prints nothing", func(t *testing.T) {
		port := cfgFreePort(t)
		cmd := exec.Command("/bin/sh", "-c", cfgHookCommand(t, port, cfgBinary(t)))
		cmd.Env = []string{"PATH=/usr/bin:/bin", "AGENTDECK_SESSION_ID=s", "AGENTDECK_SECRET=x"}
		cmd.Stdin = strings.NewReader(`{"hook_event_name":"Stop"}`)
		out, err := cmd.CombinedOutput()
		if err != nil || len(out) != 0 {
			t.Fatalf("err=%v out=%q", err, out)
		}
	})
}

// ---- src/reap-schedule.test.ts

func TestConfig_ReapSchedule(t *testing.T) {
	quiet := func(string) {}

	t.Run("runs the reaper repeatedly until it is stopped", func(t *testing.T) {
		var passes atomic.Int64
		stop := startReaping(20*time.Millisecond, func() reapOutcome { passes.Add(1); return reapOutcome{ok: true} }, quiet)
		time.Sleep(150 * time.Millisecond)
		stop()
		afterStop := passes.Load()
		if afterStop < 3 {
			t.Fatalf("only %d passes in 150ms of a 20ms interval", afterStop)
		}
		time.Sleep(100 * time.Millisecond)
		if passes.Load() != afterStop {
			t.Fatal("it kept running after being stopped")
		}
	})

	t.Run("never runs two passes at once", func(t *testing.T) {
		var started, running, overlapped atomic.Int64
		release := make(chan struct{})
		stop := startReaping(10*time.Millisecond, func() reapOutcome {
			started.Add(1)
			if running.Add(1) > 1 {
				overlapped.Add(1)
			}
			<-release
			running.Add(-1)
			return reapOutcome{ok: true}
		}, quiet)
		time.Sleep(120 * time.Millisecond)
		if n := started.Load(); n != 1 {
			t.Fatalf("%d passes overlapped", n)
		}
		close(release)
		time.Sleep(60 * time.Millisecond)
		stop()
		if started.Load() <= 1 {
			t.Fatal("it never resumed after the slow pass finished")
		}
		if overlapped.Load() != 0 {
			t.Fatal("two passes ran at once")
		}
	})

	t.Run("says nothing on a pass that collected nothing, and speaks when it collects", func(t *testing.T) {
		var mu sync.Mutex
		var said []string
		log := func(l string) { mu.Lock(); said = append(said, l); mu.Unlock() }
		stopQuiet := startReaping(10*time.Millisecond, func() reapOutcome { return reapOutcome{ok: true} }, log)
		time.Sleep(60 * time.Millisecond)
		stopQuiet()
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		if len(said) != 0 {
			t.Errorf("a pass that reaped nothing logged: %v", said)
		}
		mu.Unlock()
		stopLoud := startReaping(10*time.Millisecond, func() reapOutcome { return reapOutcome{ok: true, summary: "reaped 1"} }, log)
		time.Sleep(60 * time.Millisecond)
		stopLoud()
		mu.Lock()
		defer mu.Unlock()
		if len(said) == 0 || !strings.Contains(said[0], "reaped 1") {
			t.Fatalf("a pass that reaped something logged: %v", said)
		}
	})

	t.Run("a failing pass is logged rather than left to reject", func(t *testing.T) {
		var mu sync.Mutex
		var said []string
		stop := startReaping(10*time.Millisecond, func() reapOutcome { return reapOutcome{ok: false, summary: "the reaper exited 1: boom"} },
			func(l string) { mu.Lock(); said = append(said, l); mu.Unlock() })
		time.Sleep(60 * time.Millisecond)
		stop()
		mu.Lock()
		defer mu.Unlock()
		if !strings.Contains(strings.Join(said, "\n"), "boom") {
			t.Fatalf("the failure never reached the log: %v", said)
		}
	})

	t.Run("a failing reaper process is summarised with its exit and its words", func(t *testing.T) {
		out := summariseReap("", "agentdeck-reap: boom\n", 2)
		if out.ok || !strings.Contains(out.summary, "boom") || !strings.Contains(out.summary, "2") {
			t.Fatalf("%+v", out)
		}
	})

	strays := &cfgStrays{}
	t.Cleanup(strays.killAll)
	tmuxDir := cfgShortTemp(t, "cfgsc")
	socket := fmt.Sprintf("agentdeck-gotest-cfg-sched-%d", os.Getpid())
	bootEnv := func(root string, extra map[string]string) map[string]string {
		env := map[string]string{
			"AGENTDECK_ROOTS":              root,
			"AGENTDECK_REAP_SOCKET_PREFIX": fmt.Sprintf("agentdeck-gotest-cfg-schedns-%d-", os.Getpid()),
		}
		for k, v := range extra {
			env[k] = v
		}
		return env
	}

	t.Run("says on boot that it is on, and then actually collects an orphan", func(t *testing.T) {
		root := cfgRealTemp(t)
		pid := cfgOrphan(t, strays, root, "exec /bin/sleep 100000")
		time.Sleep(1200 * time.Millisecond)
		s := cfgBoot(t, tmuxDir, socket, bootEnv(root, map[string]string{
			"AGENTDECK_REAP_INTERVAL_MS":   "700",
			"AGENTDECK_REAP_MIN_AGE_MS":    "1",
			"AGENTDECK_REAP_STOP_GRACE_MS": "500",
		}))
		cfgMatch(t, s.out(), `(?i)collecting abandoned processes`)
		reaped := regexp.MustCompile(`(?i)reaped .*orphan tree`)
		for i := 0; i < 150 && !reaped.MatchString(s.out()); i++ {
			time.Sleep(100 * time.Millisecond)
		}
		cfgMatch(t, s.out(), `(?i)reaped .*orphan tree`)
		if cfgAlive(pid) {
			t.Fatalf("it reported reaping but pid %d is alive\n%s", pid, s.out())
		}
	})

	t.Run("an interval of 0 turns it off, and the orphan is left alone", func(t *testing.T) {
		root := cfgRealTemp(t)
		pid := cfgOrphan(t, strays, root, "exec /bin/sleep 100000")
		time.Sleep(1200 * time.Millisecond)
		s := cfgBoot(t, tmuxDir, socket, bootEnv(root, map[string]string{
			"AGENTDECK_REAP_INTERVAL_MS": "0",
			"AGENTDECK_REAP_MIN_AGE_MS":  "1",
		}))
		cfgNoMatch(t, s.out(), `(?i)collecting abandoned processes`)
		time.Sleep(2 * time.Second)
		if !cfgAlive(pid) {
			t.Fatalf("it reaped with the interval set to 0\n%s", s.out())
		}
	})
}

// ---- src/reap.test.ts

type cfgReapOpts struct {
	kill           bool
	roots          string
	minAgeMs       string
	prefix         string
	liveSocket     string
	spareListeners bool
	paneChildren   bool
}

func TestConfig_Reap(t *testing.T) {
	bin := cfgBinary(t)
	base := fmt.Sprintf("agentdeck-gotest-cfg-reap-%d-", os.Getpid())
	strays := &cfgStrays{}
	tmuxDir := cfgShortTemp(t, "cfgrp")
	var sockets []string
	t.Cleanup(func() {
		strays.killAll()
		for _, s := range sockets {
			cfgKillTmux(tmuxDir, s)
		}
	})

	reap := func(o cfgReapOpts) (int, string) {
		args := []string{"reap"}
		if o.kill {
			args = append(args, "--kill")
		}
		def := func(v, d string) string {
			if v == "" {
				return d
			}
			return v
		}
		bool01 := func(b bool) string {
			if b {
				return "1"
			}
			return "0"
		}
		cmd := exec.Command(bin, args...)
		cmd.Env = []string{
			"PATH=" + getenv("PATH", "/usr/bin:/bin"),
			"HOME=" + os.Getenv("HOME"),
			"AGENTDECK_ROOTS=" + o.roots,
			"AGENTDECK_REAP_SOCKET_PREFIX=" + def(o.prefix, base+"none-"),
			"AGENTDECK_REAP_MIN_AGE_MS=" + def(o.minAgeMs, "1"),
			"AGENTDECK_REAP_STOP_GRACE_MS=1000",
			"TMUX_SOCKET=" + def(o.liveSocket, base+"unused"),
			"AGENTDECK_REAP_SPARE_LISTENERS=" + bool01(o.spareListeners),
			"AGENTDECK_REAP_PANE_CHILDREN=" + bool01(o.paneChildren),
			"TMUX_TMPDIR=" + tmuxDir,
		}
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		err := cmd.Run()
		code := 0
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		// SIGTERM then SIGKILL lands a moment after the pass returns.
		time.Sleep(300 * time.Millisecond)
		return code, out.String()
	}

	roots := map[string]string{}
	for _, k := range []string{"report", "kill", "outside", "listening", "listenReaped", "young", "parented"} {
		roots[k] = cfgRealTemp(t)
	}
	pids := map[string]int{}
	pids["report"] = cfgOrphan(t, strays, roots["report"], "exec /bin/sleep 100000")
	pids["kill"] = cfgOrphan(t, strays, roots["kill"], "exec /bin/sleep 100000")
	pids["outside"] = cfgOrphan(t, strays, roots["outside"], "exec /bin/sleep 100000")
	pids["listening"] = cfgOrphan(t, strays, roots["listening"], cfgHelperCommand("listen"))
	pids["listenReaped"] = cfgOrphan(t, strays, roots["listenReaped"], cfgHelperCommand("listen"))
	// Not double-forked: this process stays its living parent, so ppid is never 1.
	parented := exec.Command("/bin/sleep", "100000")
	parented.Dir = roots["parented"]
	parented.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := parented.Start(); err != nil {
		t.Fatal(err)
	}
	pids["parented"] = parented.Process.Pid
	strays.add(pids["parented"])
	t.Cleanup(func() { _ = parented.Process.Kill(); _ = parented.Wait() })

	names := map[string]string{}
	for _, k := range []string{"empty", "busy", "live", "pane", "keep"} {
		names[k] = base + k + "-sock"
		sockets = append(sockets, names[k])
	}
	cfgTmux(t, tmuxDir, "-L", names["empty"], "start-server", ";", "set-option", "-g", "exit-empty", "off")
	cfgTmux(t, tmuxDir, "-L", names["busy"], "new-session", "-d", "-s", "work", "sleep", "100000")
	cfgTmux(t, tmuxDir, "-L", names["busy"], "set-option", "-g", "exit-empty", "off")
	cfgTmux(t, tmuxDir, "-L", names["live"], "start-server", ";", "set-option", "-g", "exit-empty", "off")

	panePid := func(socket string) int {
		n, _ := strconv.Atoi(strings.TrimSpace(cfgTmux(t, tmuxDir, "-L", socket, "list-panes", "-a", "-F", "#{pane_pid}")))
		strays.add(n)
		return n
	}
	// `exec` rather than `wait`: with `wait` the pane exits when its child is killed.
	cfgTmux(t, tmuxDir, "-L", names["pane"], "new-session", "-d", "-s", "work", "/bin/sh", "-c", "/bin/sleep 100000 & exec /bin/sleep 200000")
	pane := panePid(names["pane"])
	paneChild := 0
	for i := 0; i < 100 && paneChild == 0; i++ {
		if kids := cfgChildren(pane); len(kids) > 0 {
			paneChild = kids[0]
		} else {
			time.Sleep(50 * time.Millisecond)
		}
	}
	strays.add(paneChild)

	// One ordinary leftover, and one whose argv says "mcp", which is what the reaper matches.
	cfgTmux(t, tmuxDir, "-L", names["keep"], "new-session", "-d", "-s", "work", "/bin/sh", "-c",
		"/bin/sleep 100000 & ("+cfgHelperCommand("idle", "playwright-mcp")+") & exec /bin/sleep 200000")
	keepPane := panePid(names["keep"])
	keepPlain, keepMCP := 0, 0
	for i := 0; i < 100 && (keepPlain == 0 || keepMCP == 0); i++ {
		for _, kid := range cfgChildren(keepPane) {
			cmd, _ := exec.Command("/bin/ps", "-o", "command=", "-p", strconv.Itoa(kid)).Output()
			if strings.Contains(string(cmd), "playwright-mcp") {
				keepMCP = kid
			} else {
				keepPlain = kid
			}
		}
		if keepPlain == 0 || keepMCP == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	strays.add(keepPlain, keepMCP)

	for i := 0; i < 100 && !(cfgListens(pids["listening"]) && cfgListens(pids["listenReaped"])); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	// ps reports elapsed time in whole seconds: the one age wait for the whole fixture.
	time.Sleep(1200 * time.Millisecond)

	t.Run("no roots means it reaps nothing and says why", func(t *testing.T) {
		code, out := reap(cfgReapOpts{kill: true})
		if code != 2 {
			t.Fatalf("exit %d\n%s", code, out)
		}
		cfgMatch(t, out, `AGENTDECK_ROOTS`)
		cfgMatch(t, out, `(?i)launchd daemon`)
		if !cfgAlive(pids["report"]) {
			t.Fatal("a refusing pass still killed something")
		}
	})

	t.Run("an orphan under a root is named but left running", func(t *testing.T) {
		code, out := reap(cfgReapOpts{roots: roots["report"]})
		if code != 0 {
			t.Fatalf("exit %d\n%s", code, out)
		}
		cfgMatch(t, out, fmt.Sprintf(`pid %d\b`, pids["report"]))
		if !cfgAlive(pids["report"]) {
			t.Fatal("the default pass killed a process; it is meant to report only")
		}
	})

	t.Run("an orphan working under a root", func(t *testing.T) {
		code, out := reap(cfgReapOpts{kill: true, roots: roots["kill"]})
		if code != 0 || cfgAlive(pids["kill"]) {
			t.Fatalf("exit %d, pid %d alive=%v\n%s", code, pids["kill"], cfgAlive(pids["kill"]), out)
		}
	})

	t.Run("a tmux server in the namespace that holds no sessions", func(t *testing.T) {
		_, out := reap(cfgReapOpts{kill: true, roots: roots["kill"], prefix: names["empty"]})
		if cfgSocketAnswers(tmuxDir, names["empty"]) {
			t.Fatalf("it survived --kill\n%s", out)
		}
	})

	t.Run("a listening tree, because sparing them is no longer the default", func(t *testing.T) {
		if !cfgListens(pids["listenReaped"]) {
			t.Fatal("the fixture never listened, so this proves nothing")
		}
		_, out := reap(cfgReapOpts{kill: true, roots: roots["listenReaped"]})
		if cfgAlive(pids["listenReaped"]) {
			t.Fatalf("a listening tree was spared by default\n%s", out)
		}
	})

	t.Run("an ordinary leftover in a live pane, but NOT the one that looks like an MCP server", func(t *testing.T) {
		if keepPlain <= 1 || keepMCP <= 1 {
			t.Fatal("the keep fixture did not produce both children")
		}
		_, out := reap(cfgReapOpts{kill: true, roots: roots["kill"], liveSocket: names["keep"], paneChildren: true})
		if cfgAlive(keepPlain) {
			t.Errorf("the ordinary leftover survived\n%s", out)
		}
		if !cfgAlive(keepMCP) {
			t.Errorf("the MCP server was reaped by the timed pass\n%s", out)
		}
		cfgMatch(t, out, `kept\s+\d+`)
	})

	t.Run("what a live pane started, while leaving the pane itself alone", func(t *testing.T) {
		if pane <= 1 || paneChild <= 1 {
			t.Fatal("the pane fixture did not start")
		}
		_, out := reap(cfgReapOpts{kill: true, roots: roots["kill"], liveSocket: names["pane"], paneChildren: true})
		if cfgAlive(paneChild) {
			t.Errorf("the pane's child survived\n%s", out)
		}
		if !cfgAlive(pane) {
			t.Errorf("the PANE was reaped, which ends the session\n%s", out)
		}
	})

	t.Run("an orphan working outside every root", func(t *testing.T) {
		_, out := reap(cfgReapOpts{kill: true, roots: roots["report"]})
		if !cfgAlive(pids["outside"]) {
			t.Fatalf("pid %d was outside the root given and was reaped\n%s", pids["outside"], out)
		}
	})

	t.Run("an orphan whose tree holds a listening socket, when asked to spare them", func(t *testing.T) {
		if !cfgListens(pids["listening"]) {
			t.Fatal("the fixture never listened, so this case proves nothing")
		}
		_, out := reap(cfgReapOpts{kill: true, roots: roots["listening"], spareListeners: true})
		if !cfgAlive(pids["listening"]) {
			t.Fatalf("a listening tree was reaped\n%s", out)
		}
	})

	t.Run("a tmux server that still holds a session", func(t *testing.T) {
		_, out := reap(cfgReapOpts{kill: true, roots: roots["kill"], prefix: names["busy"]})
		if !cfgSocketAnswers(tmuxDir, names["busy"]) {
			t.Fatalf("a server holding a session was reaped\n%s", out)
		}
	})

	t.Run("the live deck's own socket, even holding nothing", func(t *testing.T) {
		_, out := reap(cfgReapOpts{kill: true, roots: roots["kill"], prefix: names["live"], liveSocket: names["live"]})
		if !cfgSocketAnswers(tmuxDir, names["live"]) {
			t.Fatalf("the configured TMUX_SOCKET was reaped\n%s", out)
		}
	})

	t.Run("an orphan younger than the age bound", func(t *testing.T) {
		pid := cfgOrphan(t, strays, roots["young"], "exec /bin/sleep 100000")
		_, out := reap(cfgReapOpts{kill: true, roots: roots["young"], minAgeMs: "3600000"})
		if !cfgAlive(pid) {
			t.Fatalf("a process seconds old was reaped under a one-hour bound\n%s", out)
		}
	})

	t.Run("a process with a living parent, however idle", func(t *testing.T) {
		_, out := reap(cfgReapOpts{kill: true, roots: roots["parented"]})
		cfgNoMatch(t, out, fmt.Sprintf(`pid %d\b`, pids["parented"]))
		if !cfgAlive(pids["parented"]) {
			t.Fatal("a process with a living parent was reaped")
		}
	})
}
