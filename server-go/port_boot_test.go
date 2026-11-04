package main

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
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Ported from supervisor-crash, host-boundary, containment, processes and the server half of
// de-containerise. The boot properties run the real binary, because a refusal is an exit code.

var (
	bootBuildOnce sync.Once
	bootBinPath   string
	bootBuildErr  error
	bootSocketSeq int
	bootSocketMu  sync.Mutex
)

func bootBinary(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Fatal("tmux is required by these tests and is not installed")
	}
	bootBuildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "agentdeck-gotest-bin-")
		if err != nil {
			bootBuildErr = err
			return
		}
		bootBinPath = filepath.Join(dir, "agentdeck")
		out, err := exec.Command("go", "build", "-o", bootBinPath, ".").CombinedOutput()
		if err != nil {
			bootBuildErr = fmt.Errorf("go build: %v\n%s", err, out)
		}
	})
	if bootBuildErr != nil {
		t.Fatal(bootBuildErr)
	}
	return bootBinPath
}

// bootTemp is a fresh directory with symlinks resolved, since tmux reports session paths resolved.
func bootTemp(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func bootFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// bootSocket is a throwaway tmux socket name whose server and socket file go at cleanup.
func bootSocket(t *testing.T) string {
	t.Helper()
	bootSocketMu.Lock()
	bootSocketSeq++
	name := fmt.Sprintf("agentdeck-gotest-boot-%d-%d-%d", os.Getpid(), time.Now().UnixNano()%1000000, bootSocketSeq)
	bootSocketMu.Unlock()
	t.Cleanup(func() {
		_ = exec.Command("tmux", "-L", name, "kill-server").Run()
		base := os.Getenv("TMUX_TMPDIR")
		if base == "" {
			base = "/tmp"
		}
		_ = os.Remove(filepath.Join(base, fmt.Sprintf("tmux-%d", os.Getuid()), name))
	})
	return name
}

type bootProc struct {
	cmd    *exec.Cmd
	mu     sync.Mutex
	stdout bytes.Buffer
	stderr bytes.Buffer
	exited chan struct{}
	state  *os.ProcessState
}

func (p *bootProc) out() (string, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stdout.String(), p.stderr.String()
}

type bootWriter struct {
	p   *bootProc
	buf *bytes.Buffer
}

func (w bootWriter) Write(b []byte) (int, error) {
	w.p.mu.Lock()
	defer w.p.mu.Unlock()
	return w.buf.Write(b)
}

// bootStart runs the server and returns once it has listened or exited, whichever comes first.
func bootStart(t *testing.T, env map[string]string) *bootProc {
	t.Helper()
	bin := bootBinary(t)
	full := map[string]string{
		"PATH":                       os.Getenv("PATH"),
		"AGENTDECK_REAP_INTERVAL_MS": "0",
		"AGENTDECK_TAILSCALE":        "/nonexistent/agentdeck-gotest-tailscale",
	}
	if v := os.Getenv("TMUX_TMPDIR"); v != "" {
		full["TMUX_TMPDIR"] = v
	}
	for k, v := range env {
		full[k] = v
	}
	if _, ok := full["TMUX_SOCKET"]; !ok {
		full["TMUX_SOCKET"] = bootSocket(t)
	}
	if _, ok := full["AGENTDECK_PORT"]; !ok {
		full["AGENTDECK_PORT"] = strconv.Itoa(bootFreePort(t))
	}
	if _, ok := full["AGENTDECK_REPO"]; !ok {
		full["AGENTDECK_REPO"] = bootTemp(t)
	}
	p := &bootProc{exited: make(chan struct{})}
	p.cmd = exec.Command(bin)
	for k, v := range full {
		p.cmd.Env = append(p.cmd.Env, k+"="+v)
	}
	p.cmd.Stdout = bootWriter{p, &p.stdout}
	p.cmd.Stderr = bootWriter{p, &p.stderr}
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = p.cmd.Wait()
		p.state = p.cmd.ProcessState
		close(p.exited)
	}()
	t.Cleanup(func() { p.kill(syscall.SIGKILL) })
	deadline := time.After(20 * time.Second)
	for {
		if out, _ := p.out(); strings.Contains(out, "listening on") {
			return p
		}
		select {
		case <-p.exited:
			return p
		case <-deadline:
			out, errOut := p.out()
			t.Fatalf("the server neither listened nor exited within 20s\n%s\n%s", out, errOut)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func (p *bootProc) kill(sig syscall.Signal) {
	select {
	case <-p.exited:
		return
	default:
	}
	_ = p.cmd.Process.Signal(sig)
	<-p.exited
}

func (p *bootProc) listened() bool {
	out, _ := p.out()
	return strings.Contains(out, "listening on 127.0.0.1")
}

// bootOnce boots, stops a server that listened with SIGTERM, and reports how it ended.
func bootOnce(t *testing.T, env map[string]string) (code int, signalled bool, stdout, stderr string) {
	t.Helper()
	p := bootStart(t, env)
	p.kill(syscall.SIGTERM)
	stdout, stderr = p.out()
	ws, _ := p.state.Sys().(syscall.WaitStatus)
	return p.state.ExitCode(), ws.Signaled() && ws.Signal() == syscall.SIGTERM, stdout, stderr
}

func bootPanes(socket string) []string {
	out, err := exec.Command("tmux", "-L", socket, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}").Output()
	if err != nil {
		return nil
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	return lines
}

func bootHas(lines []string, pred func(string) bool) bool {
	for _, l := range lines {
		if pred(l) {
			return true
		}
	}
	return false
}

type bootClient struct {
	t     *testing.T
	port  int
	token string
}

func (c bootClient) do(method, path string, body any, headers map[string]string) (int, map[string]any) {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", c.port, path), r)
	if c.token != "" {
		req.Header.Set("authorization", "Bearer "+c.token)
	}
	req.Header.Set("content-type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

type bootSession struct {
	ID                   string `json:"id"`
	Cwd                  string `json:"cwd"`
	Agent                string `json:"agent"`
	State                string `json:"state"`
	WaitingDetectionLost bool   `json:"waitingDetectionLost"`
}

func (c bootClient) sessions() []bootSession {
	c.t.Helper()
	_, body := c.do("GET", "/api/sessions", nil, nil)
	raw, _ := json.Marshal(body["sessions"])
	var out []bootSession
	_ = json.Unmarshal(raw, &out)
	return out
}

func (c bootClient) ids() []string {
	ids := []string{}
	for _, s := range c.sessions() {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	return ids
}

// sessionsIn is the ids /api/cwds reports for one directory, and false if it names no such directory.
func (c bootClient) sessionsIn(path string) ([]string, bool) {
	c.t.Helper()
	_, body := c.do("GET", "/api/cwds", nil, nil)
	raw, _ := json.Marshal(body["cwds"])
	var cwds []struct {
		Path     string   `json:"path"`
		Sessions []string `json:"sessions"`
	}
	_ = json.Unmarshal(raw, &cwds)
	for _, cwd := range cwds {
		if cwd.Path == path {
			ids := append([]string{}, cwd.Sessions...)
			sort.Strings(ids)
			return ids, true
		}
	}
	return nil, false
}

func (c bootClient) create(cwd, agent string) (string, string) {
	c.t.Helper()
	status, body := c.do("POST", "/api/sessions", map[string]string{"cwd": cwd, "agent": agent}, nil)
	if status != 201 {
		c.t.Fatalf("create failed: %d %v", status, body)
	}
	warning, _ := body["warning"].(string)
	return body["session"].(map[string]any)["id"].(string), warning
}

// hook posts as the agent does: unauthenticated, the secret in the header is the whole assertion.
func (c bootClient) hook(id, secret string) int {
	c.t.Helper()
	anon := bootClient{t: c.t, port: c.port}
	status, _ := anon.do("POST", "/api/hooks/"+id, map[string]string{"hook_event_name": "Notification"},
		map[string]string{"x-agentdeck-secret": secret})
	return status
}

func bootReadSecret(t *testing.T, path string) string {
	t.Helper()
	for i := 0; i < 200; i++ {
		if b, err := os.ReadFile(path); err == nil && strings.TrimSpace(string(b)) != "" {
			return strings.TrimSpace(string(b))
		}
		time.Sleep(25 * time.Millisecond)
	}
	return ""
}

var bootSecretShape = regexp.MustCompile(`^[A-Za-z0-9_-]{20,}$`)

func TestBoot_SupervisorCrash(t *testing.T) {
	// Nothing restarts the server: every restart below is this test doing by hand what a person would.
	home, work, conf := bootTemp(t), bootTemp(t), bootTemp(t)
	secretFile := filepath.Join(conf, "secret-seen-by-the-agent")
	profiles := filepath.Join(conf, "agents.json")
	spec, _ := json.Marshal(map[string]any{
		"shell":     map[string]any{"command": "/bin/sh", "args": []string{"-c", "printenv AGENTDECK_SECRET > " + secretFile + "; exec sleep 100000"}},
		"neighbour": map[string]any{"command": "/bin/sh", "args": []string{"-c", "exec sleep 100000"}},
	})
	if err := os.WriteFile(profiles, spec, 0o644); err != nil {
		t.Fatal(err)
	}
	socket := bootSocket(t)
	port := bootFreePort(t)
	tokenFile := filepath.Join(conf, "token")
	env := map[string]string{
		"HOME": home, "TMUX_SOCKET": socket, "AGENTDECK_PORT": strconv.Itoa(port),
		"AGENTDECK_MOUNTS": work, "AGENTDECK_PROFILES": profiles, "AGENTDECK_TOKEN_FILE": tokenFile,
		"AGENTDECK_AGENT_STATE_DIR": filepath.Join(conf, "agent-state"),
	}
	// Started on the parent test, so a server outlives the subtest that started it.
	outer := t
	start := func(t *testing.T) *bootProc {
		p := bootStart(outer, env)
		if !p.listened() {
			out, errOut := p.out()
			t.Fatalf("the server did not listen\n%s\n%s", out, errOut)
		}
		return p
	}
	var c bootClient
	var id, paneLine, secret string

	t.Run("a session created beforehand is listed, in /api/cwds, and its hooks are accepted", func(t *testing.T) {
		first := start(t)
		token, _ := os.ReadFile(tokenFile)
		c = bootClient{t: t, port: port, token: strings.TrimSpace(string(token))}
		id, _ = c.create(work, "shell")
		for _, l := range bootPanes(socket) {
			if strings.HasPrefix(l, id+" ") {
				paneLine = l
			}
		}
		if paneLine == "" {
			t.Fatal("tmux has no pane for the session it just created")
		}
		if got := c.ids(); len(got) != 1 || got[0] != id {
			t.Fatalf("listed %v, want [%s]", got, id)
		}
		if got, _ := c.sessionsIn(work); len(got) != 1 || got[0] != id {
			t.Fatalf("/api/cwds has %v for the work tree", got)
		}
		secret = bootReadSecret(t, secretFile)
		if !bootSecretShape.MatchString(secret) {
			t.Fatalf("the pane never saw a secret: %q", secret)
		}
		if got := c.hook(id, secret); got != 200 {
			t.Fatalf("the hook route rejected the secret its own session was given: %d", got)
		}
		first.kill(syscall.SIGKILL)
		if ws, _ := first.state.Sys().(syscall.WaitStatus); !ws.Signaled() || ws.Signal() != syscall.SIGKILL {
			t.Fatalf("the server ended %v, not by SIGKILL", first.state)
		}
	})

	t.Run("nothing is listening afterwards, because nothing supervises the node process", func(t *testing.T) {
		if res, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", port)); err == nil {
			res.Body.Close()
			t.Fatal("something answered the port after the server was killed")
		}
	})

	t.Run("the tmux session and its process survive the crash unchanged", func(t *testing.T) {
		if panes := bootPanes(socket); !bootHas(panes, func(l string) bool { return l == paneLine }) {
			t.Fatalf("the session did not survive; tmux holds %v", panes)
		}
	})

	t.Run("started again by hand, the survivor is adopted: listed, with the right cwd and agent", func(t *testing.T) {
		start(t)
		c.t = t
		if got := c.ids(); len(got) != 1 || got[0] != id {
			t.Fatalf("the surviving session was not adopted: %v", got)
		}
		if got, _ := c.sessionsIn(work); len(got) != 1 || got[0] != id {
			t.Fatalf("GET /api/cwds does not count the survivor: %v", got)
		}
		s := c.sessions()[0]
		if s.Cwd != work || s.Agent != "shell" || s.State == "exited" {
			t.Fatalf("adopted as %+v", s)
		}
		if !bootHas(bootPanes(socket), func(l string) bool { return l == paneLine }) {
			t.Fatal("the restart disturbed the session it adopted")
		}
	})

	t.Run("the adopted session KEEPS its hook path, because the secret is derived", func(t *testing.T) {
		c.t = t
		if c.sessions()[0].WaitingDetectionLost {
			t.Fatal("an adopted session is still reported as having lost its hook path")
		}
		if got := c.hook(id, secret); got != 200 {
			t.Fatalf("the survivor's own secret no longer authenticates: %d", got)
		}
	})

	t.Run("and a hook with the WRONG secret is still refused", func(t *testing.T) {
		c.t = t
		if got := c.hook(id, "not-the-secret-at-all"); got != 401 {
			t.Fatalf("a wrong secret got %d", got)
		}
	})

	t.Run("a session outside the allowlist is NOT adopted, however it is named", func(t *testing.T) {
		c.t = t
		outside := bootTemp(t)
		forged := sessionID(outside, "shell")
		if out, err := exec.Command("tmux", "-L", socket, "new-session", "-d", "-s", forged, "-c", outside,
			"--", "/bin/sh", "-c", "exec sleep 100000").CombinedOutput(); err != nil {
			t.Fatalf("could not create the forged session: %v %s", err, out)
		}
		defer func() { _ = exec.Command("tmux", "-L", socket, "kill-session", "-t", "="+forged).Run() }()
		forgedPane := func(l string) bool { return strings.HasPrefix(l, forged+" ") }
		if !bootHas(bootPanes(socket), forgedPane) {
			t.Fatal("the forged session was not created, so this test proves nothing")
		}
		if got := c.ids(); len(got) != 1 || got[0] != id {
			t.Fatalf("a session outside the allowlist was adopted: %v", got)
		}
		if _, ok := c.sessionsIn(outside); ok {
			t.Fatal("the outside directory became a cwd")
		}
		if !bootHas(bootPanes(socket), forgedPane) {
			t.Fatal("the server killed a session it refuses to list")
		}
	})

	t.Run("an attach the client had before the crash is answered with a snapshot, not `no session`", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws", port),
			&websocket.DialOptions{Subprotocols: []string{wsProtocol, c.token}})
		if err != nil {
			t.Fatalf("the socket refused the token: %v", err)
		}
		defer conn.CloseNow()
		msg, _ := json.Marshal(map[string]any{"t": "attach", "sessionId": id, "cols": 80, "rows": 24})
		if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
			t.Fatal(err)
		}
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				t.Fatalf("nothing answered the attach: %v", err)
			}
			var frame map[string]any
			_ = json.Unmarshal(raw, &frame)
			if tt := frame["t"]; tt == "ping" || tt == "sessions" || tt == "hello" {
				continue
			}
			if frame["t"] != "snapshot" {
				t.Fatalf("the re-attach was answered %s", raw)
			}
			return
		}
	})

	t.Run("a second agent in the same tree SEES the survivor in the lists", func(t *testing.T) {
		c.t = t
		other, warning := c.create(work, "neighbour")
		if warning != "" {
			t.Fatalf("a neighbouring session warned: %s", warning)
		}
		if !bootHas(bootPanes(socket), func(l string) bool { return l == paneLine }) {
			t.Fatal("the second agent disturbed the surviving session")
		}
		want := []string{id, other}
		sort.Strings(want)
		if got, _ := c.sessionsIn(work); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("/api/cwds has %v, want %v", got, want)
		}
		if status, _ := c.do("DELETE", "/api/sessions/"+other, nil, nil); status != 200 {
			t.Fatalf("DELETE answered %d", status)
		}
		if bootHas(bootPanes(socket), func(l string) bool { return strings.HasPrefix(l, other+" ") }) {
			t.Fatal("DELETE left the session it does own")
		}
	})

	t.Run("recreating reattaches to the same process, hook path intact", func(t *testing.T) {
		c.t = t
		again, warning := c.create(work, "shell")
		if again != id {
			t.Fatalf("the id is not stable across a restart: %s vs %s", again, id)
		}
		if !strings.Contains(warning, "already running") {
			t.Fatalf("this was a new session, not a reattach: %q", warning)
		}
		if !bootHas(bootPanes(socket), func(l string) bool { return l == paneLine }) {
			t.Fatal("the reattach replaced the running process")
		}
		if got := c.ids(); len(got) != 1 || got[0] != id {
			t.Fatalf("listed %v", got)
		}
		if got := c.hook(id, secret); got != 200 {
			t.Fatalf("the surviving process's secret stopped working after a recreate: %d", got)
		}
	})

	t.Run("a refused hook moves no state, and marks the tab muted", func(t *testing.T) {
		c.t = t
		before := c.sessions()[0].State
		if got := c.hook(id, "a-secret-from-the-old-scheme"); got != 401 {
			t.Fatalf("a wrong secret got %d", got)
		}
		s := c.sessions()[0]
		if s.State != before {
			t.Fatalf("an unauthenticated hook moved the state from %s to %s", before, s.State)
		}
		if !s.WaitingDetectionLost {
			t.Fatal("a session whose hooks are refused still claims it can report waiting")
		}
	})

	t.Run("restarting the AGENT clears a detected loss - and does NOT rotate the secret", func(t *testing.T) {
		c.t = t
		if status, _ := c.do("DELETE", "/api/sessions/"+id, nil, nil); status != 200 {
			t.Fatalf("DELETE answered %d", status)
		}
		if bootHas(bootPanes(socket), func(l string) bool { return strings.HasPrefix(l, id+" ") }) {
			t.Fatal("DELETE left the session it had adopted")
		}
		// Removed, so the secret read below is the one the NEW pane wrote.
		_ = os.Remove(secretFile)
		restarted, warning := c.create(work, "shell")
		if restarted != id {
			t.Fatal("the id is not a function of (cwd, agent) after all")
		}
		if warning != "" {
			t.Fatalf("this reattached instead of starting a new agent: %s", warning)
		}
		fresh := bootReadSecret(t, secretFile)
		if !bootSecretShape.MatchString(fresh) {
			t.Fatalf("the restarted pane never saw a secret: %q", fresh)
		}
		if fresh != secret {
			t.Fatal("the derived secret changed across an agent restart")
		}
		if got := c.hook(id, fresh); got != 200 {
			t.Fatalf("restarting the agent did not restore the hook path: %d", got)
		}
		s := c.sessions()[0]
		if s.WaitingDetectionLost {
			t.Fatal("a session whose agent was restarted is still reported as deaf")
		}
		if s.State != "waiting" {
			t.Fatalf("the hook it accepted changed no state: %s", s.State)
		}
	})
}

func TestBoot_CleanHost(t *testing.T) {
	// HOME is a fresh directory, which is what a clean Mac is to the defaults.
	t.Run("`pnpm start` reaches the port with nothing set, and leaves a 0600 token", func(t *testing.T) {
		home := bootTemp(t)
		code, signalled, stdout, stderr := bootOnce(t, map[string]string{"HOME": home})
		if !strings.Contains(stdout, "listening on 127.0.0.1") {
			t.Fatalf("the server did not reach the port\n%s\n%s", stdout, stderr)
		}
		if code != 0 && !signalled {
			t.Fatalf("boot exited %d", code)
		}
		tokenPath := filepath.Join(home, ".agentdeck", "token")
		info, err := os.Stat(tokenPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("the token is %v on first run", info.Mode().Perm())
		}
		b, _ := os.ReadFile(tokenPath)
		if !bootSecretShape.MatchString(strings.TrimSpace(string(b))) {
			t.Fatal("the token is not a wire-safe string")
		}
	})

	t.Run("the same token is reused on the next boot rather than rotated", func(t *testing.T) {
		home := bootTemp(t)
		tokenPath := filepath.Join(home, ".agentdeck", "token")
		bootOnce(t, map[string]string{"HOME": home})
		first, _ := os.ReadFile(tokenPath)
		bootOnce(t, map[string]string{"HOME": home})
		second, _ := os.ReadFile(tokenPath)
		if len(first) == 0 || string(first) != string(second) {
			t.Fatalf("the token changed across a restart: %q -> %q", first, second)
		}
	})

	t.Run("the agent-state directory is agentdeck's own, and a live Claude config is untouched", func(t *testing.T) {
		home, claude := bootTemp(t), bootTemp(t)
		_, _, _, stderr := bootOnce(t, map[string]string{"HOME": home, "CLAUDE_CONFIG_DIR": claude})
		if !strings.Contains(stderr, "AGENTDECK_AGENT_STATE_DIR is not set") {
			t.Fatalf("no warning that the state dir is unset:\n%s", stderr)
		}
		if !strings.Contains(stderr, filepath.Join(home, ".agentdeck", "agent-state")) {
			t.Fatalf("the warning does not name agentdeck's own directory:\n%s", stderr)
		}
		if strings.Contains(stderr, claude) {
			t.Fatal("the boot pointed at the live config")
		}
		if entries, _ := os.ReadDir(claude); len(entries) != 0 {
			t.Fatal("agentdeck wrote into the operator's live Claude config")
		}
	})

	t.Run("the Origin check being off is said at boot, not only in a comment", func(t *testing.T) {
		_, _, _, stderr := bootOnce(t, map[string]string{"HOME": bootTemp(t)})
		if !strings.Contains(stderr, "AGENTDECK_ORIGIN is not set") {
			t.Fatalf("the boot did not say the Origin check is off:\n%s", stderr)
		}
	})
}

func TestBoot_TokenNeverInsideASessionTree(t *testing.T) {
	t.Run("a token under an allowlisted directory is a refusal to start, not a warning", func(t *testing.T) {
		home := bootTemp(t)
		code, _, stdout, stderr := bootOnce(t, map[string]string{"HOME": home, "AGENTDECK_MOUNTS": home})
		if code != 1 || strings.Contains(stdout, "listening on") {
			t.Fatalf("the server started with its token inside an allowlisted tree: %d\n%s", code, stdout)
		}
		for _, want := range []string{filepath.Join(home, ".agentdeck", "token"), home, "AGENTDECK_MOUNTS", "grep -rn token"} {
			if !strings.Contains(stderr, want) {
				t.Errorf("the refusal does not say %q:\n%s", want, stderr)
			}
		}
	})

	t.Run("the refusal happens before the token file is created", func(t *testing.T) {
		home := bootTemp(t)
		bootOnce(t, map[string]string{"HOME": home, "AGENTDECK_MOUNTS": home})
		if _, err := os.Stat(filepath.Join(home, ".agentdeck", "token")); !os.IsNotExist(err) {
			t.Fatal("a token was written into the tree the refusal exists to keep it out of")
		}
	})

	t.Run("an allowlist that does not contain the token is an ordinary boot", func(t *testing.T) {
		code, signalled, stdout, stderr := bootOnce(t, map[string]string{"HOME": bootTemp(t), "AGENTDECK_MOUNTS": bootTemp(t)})
		if !strings.Contains(stdout, "listening on 127.0.0.1") || (code != 0 && !signalled) {
			t.Fatalf("boot exited %d\n%s\n%s", code, stdout, stderr)
		}
	})
}

func TestBoot_ProfilesFileIsAnExecutionSurface(t *testing.T) {
	t.Run("a profiles file inside an allowlisted tree refuses the boot", func(t *testing.T) {
		work := bootTemp(t)
		profiles := filepath.Join(work, "agents.json")
		_ = os.WriteFile(profiles, []byte(`{"shell":{"command":"/bin/sh"}}`), 0o644)
		code, _, _, stderr := bootOnce(t, map[string]string{"HOME": bootTemp(t), "AGENTDECK_MOUNTS": work, "AGENTDECK_PROFILES": profiles})
		if code != 1 {
			t.Fatalf("boot should have refused: %d\n%s", code, stderr)
		}
		if !regexp.MustCompile(`(?i)profiles file`).MatchString(stderr) || !strings.Contains(stderr, "AGENTDECK_MOUNTS") {
			t.Fatalf("the refusal does not name the file and the variable:\n%s", stderr)
		}
	})

	t.Run("a profiles file outside every entry is an ordinary boot", func(t *testing.T) {
		profiles := filepath.Join(bootTemp(t), "agents.json")
		_ = os.WriteFile(profiles, []byte(`{"shell":{"command":"/bin/sh"}}`), 0o644)
		code, signalled, stdout, stderr := bootOnce(t, map[string]string{"HOME": bootTemp(t), "AGENTDECK_MOUNTS": bootTemp(t), "AGENTDECK_PROFILES": profiles})
		if !strings.Contains(stdout, "listening on 127.0.0.1") || (code != 0 && !signalled) {
			t.Fatalf("boot exited %d\n%s\n%s", code, stdout, stderr)
		}
	})
}

func TestBoot_PublishedDirectoryHoldsNoSecret(t *testing.T) {
	// The default client directory, <repo>/dist/client, served unauthenticated.
	published := func(t *testing.T) (repo, clientDir string) {
		repo = bootTemp(t)
		clientDir = filepath.Join(repo, "dist", "client")
		if err := os.MkdirAll(clientDir, 0o755); err != nil {
			t.Fatal(err)
		}
		return repo, clientDir
	}

	t.Run("a token file inside it is a refusal, not a warning", func(t *testing.T) {
		repo, clientDir := published(t)
		code, _, _, stderr := bootOnce(t, map[string]string{"HOME": bootTemp(t), "AGENTDECK_REPO": repo, "AGENTDECK_TOKEN_FILE": filepath.Join(clientDir, "token")})
		if code == 0 {
			t.Fatal("the server started with its token in a published directory")
		}
		if !strings.Contains(stderr, "UNAUTHENTICATED") || !strings.Contains(stderr, "dist/client") {
			t.Fatalf("the refusal does not say why:\n%s", stderr)
		}
	})

	t.Run("a symlink at the token path cannot smuggle it in either", func(t *testing.T) {
		repo, clientDir := published(t)
		home := bootTemp(t)
		planted := filepath.Join(clientDir, "smuggled")
		_ = os.MkdirAll(filepath.Join(home, ".agentdeck"), 0o755)
		if err := os.Symlink(planted, filepath.Join(home, ".agentdeck", "token")); err != nil {
			t.Fatal(err)
		}
		code, _, _, stderr := bootOnce(t, map[string]string{"HOME": home, "AGENTDECK_REPO": repo})
		if code == 0 || !strings.Contains(stderr, "UNAUTHENTICATED") {
			t.Fatalf("a symlinked token path started the server: %d\n%s", code, stderr)
		}
		if _, err := os.Lstat(planted); !os.IsNotExist(err) {
			t.Fatal("the token was written into the publish root")
		}
	})

	t.Run("so is a profiles file, which is the more direct execution surface", func(t *testing.T) {
		repo, clientDir := published(t)
		code, _, _, stderr := bootOnce(t, map[string]string{"HOME": bootTemp(t), "AGENTDECK_REPO": repo, "AGENTDECK_PROFILES": filepath.Join(clientDir, "agents.json")})
		if code == 0 || !strings.Contains(stderr, "UNAUTHENTICATED") {
			t.Fatalf("the server started with its profiles in a published directory: %d\n%s", code, stderr)
		}
	})
}

func TestBoot_EveryVariableTheServerReadsIsInTheReadme(t *testing.T) {
	// So the table cannot drift: the names serve() reads, against the README's Environment section.
	readme, err := os.ReadFile(filepath.Join("..", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(readme)
	start := strings.Index(text, "## Environment")
	if start < 0 {
		t.Fatal("the README has no Environment section")
	}
	section := text[start:]
	if end := strings.Index(section[1:], "\n## "); end >= 0 {
		section = section[:end+1]
	}
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	reads := regexp.MustCompile(`(?:Getenv|getenv|LookupEnv|envMs|pathList)\("([A-Z_]+)"`).FindAllStringSubmatch(string(src), -1)
	if len(reads) == 0 {
		t.Fatal("found no environment reads in main.go, so this test proves nothing")
	}
	for _, m := range reads {
		if !strings.Contains(section, m[1]) {
			t.Errorf("main.go reads %s; the README's Environment section does not", m[1])
		}
	}
}

func TestBoot_TokenPlacement(t *testing.T) {
	t.Run("the default token home is one a clean Mac already has, and no session is pointed at", func(t *testing.T) {
		home := bootTemp(t)
		t.Setenv("HOME", home)
		if got := defaultTokenFile(); got != filepath.Join(home, ".agentdeck", "token") {
			t.Fatalf("defaultTokenFile() = %s", got)
		}
		repo, _ := filepath.Abs("..")
		if clash := tokenInsideAllowlist(defaultTokenFile(), []string{repo}); clash != "" {
			t.Fatalf("the default token lands inside %s", clash)
		}
	})

	t.Run("a token inside an allowlisted tree is caught, at the root and below it", func(t *testing.T) {
		allowed := []string{"/workspace/web", "/workspace/agentdeck"}
		for path, want := range map[string]string{
			"/workspace/web/token":         "/workspace/web",
			"/workspace/web/a/b/token":     "/workspace/web",
			"/workspace/web":               "/workspace/web",
			"/workspace/web-secrets/token": "",
			"/var/lib/agentdeck/token":     "",
		} {
			if got := tokenInsideAllowlist(path, allowed); got != want {
				t.Errorf("tokenInsideAllowlist(%s) = %q, want %q", path, got, want)
			}
		}
	})

	t.Run("an unwritable token path is a sentence naming AGENTDECK_TOKEN_FILE", func(t *testing.T) {
		dir := bootTemp(t)
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
		_, err := loadToken(filepath.Join(dir, "nested", "token"))
		if err == nil {
			t.Fatal("a token was written under an unwritable directory")
		}
		if !strings.Contains(err.Error(), "AGENTDECK_TOKEN_FILE") || !strings.Contains(err.Error(), "session is pointed at") {
			t.Fatalf("the error does not say what to change: %v", err)
		}
	})
}

func TestBoot_HealthReportsTheTmuxHalf(t *testing.T) {
	// The server half of scripts/healthcheck.mjs: /api/health is 200 ok:true only while tmux answers.
	socket := bootSocket(t)
	port := bootFreePort(t)
	conf := bootTemp(t)
	p := bootStart(t, map[string]string{"HOME": bootTemp(t), "TMUX_SOCKET": socket, "AGENTDECK_PORT": strconv.Itoa(port), "AGENTDECK_TOKEN_FILE": filepath.Join(conf, "token")})
	if !p.listened() {
		t.Fatal("the server did not listen")
	}
	c := bootClient{t: t, port: port}

	t.Run("a live tmux server and a live /api/health is healthy", func(t *testing.T) {
		c.t = t
		if status, body := c.do("GET", "/api/health", nil, nil); status != 200 || body["ok"] != true {
			t.Fatalf("health answered %d %v", status, body)
		}
	})

	t.Run("a 200 carrying ok:false is a different sentence from no answer at all", func(t *testing.T) {
		c.t = t
		if err := exec.Command("tmux", "-L", socket, "kill-server").Run(); err != nil {
			t.Fatal(err)
		}
		status, body := c.do("GET", "/api/health", nil, nil)
		if status != 503 || body["ok"] != false {
			t.Fatalf("health answered %d %v with tmux gone", status, body)
		}
	})
}

func TestBoot_ProbeTellsAnEmptyTmuxFromAMissingOne(t *testing.T) {
	// tmux's two non-zero exits mean opposite things; a stub on PATH is the only way to reach the text.
	stubbed := func(t *testing.T, stderr string) bool {
		dir := bootTemp(t)
		script := fmt.Sprintf("#!/bin/sh\necho '%s' >&2\nexit 1\n", stderr)
		if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
		return probeTmux(context.Background(), "agentdeck-gotest-probe-unused")
	}
	t.Run("no sessions is a healthy server with nothing running in it yet", func(t *testing.T) {
		if !stubbed(t, "no sessions") {
			t.Fatal("an empty tmux server was called unhealthy")
		}
	})
	t.Run("no server running took every session with it and is unhealthy", func(t *testing.T) {
		if stubbed(t, "no server running on /tmp/tmux-501/agentdeck") {
			t.Fatal("a missing tmux server passed the probe")
		}
	})
}

func bootRow(pid, ppid int, command string, rss int) ProcessRow {
	return ProcessRow{Pid: pid, Ppid: ppid, AgeSeconds: 60, RssKb: rss, Command: command}
}

var bootTable = []ProcessRow{
	bootRow(100, 1, "tmux", 100),
	bootRow(200, 100, "claude", 800),
	bootRow(300, 200, "npm exec mcp", 40),
	bootRow(400, 300, "node mcp-server", 30),
	bootRow(500, 1, "something else entirely", 999),
}

// bootProcessesServer is the API with only what /api/processes uses, counting each ps read.
func bootProcessesServer(t *testing.T, panes func(context.Context) ([]PaneRef, error), rows func(context.Context) []ProcessRow) *httptest.Server {
	t.Helper()
	reg, err := newRegistry(newTmux("agentdeck-gotest-processes-unused", ""), map[string]*AgentProfile{}, newAllowlist(nil, nil), "test-secret-key")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newAPIHandler(HTTPDeps{
		Registry: reg, Profiles: map[string]*AgentProfile{}, Allowlist: newAllowlist(nil, nil), Token: "processes-test-token",
		Version: "0.0.0-test", Probe: func(context.Context) bool { return true }, PanePids: panes, ReadProcesses: rows,
	}))
	t.Cleanup(srv.Close)
	return srv
}

func bootGetProcesses(t *testing.T, srv *httptest.Server, token string) (int, []SessionProcesses) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/processes", nil)
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct {
		Sessions []SessionProcesses `json:"sessions"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	return res.StatusCode, body.Sessions
}

func TestBoot_Processes(t *testing.T) {
	t.Run("every shape ps prints, and a refusal for one it does not", func(t *testing.T) {
		for in, want := range map[string]int{"00:05": 5, "02:03": 123, "01:00:00": 3600, "2-01:00:00": 2*86400 + 3600, "nonsense": -1} {
			if got := parseEtime(in); got != want {
				t.Errorf("parseEtime(%q) = %d, want %d", in, got, want)
			}
		}
	})

	t.Run("is the pane and everything below it, and nothing beside it", func(t *testing.T) {
		tree := treeOf(bootTable, 200)
		var got []string
		for _, r := range tree {
			got = append(got, fmt.Sprintf("%d@%d", r.Pid, r.Depth))
		}
		if strings.Join(got, " ") != "200@0 300@1 400@2" {
			t.Fatalf("tree = %v", got)
		}
	})

	t.Run("is empty when the pane is already gone, rather than throwing", func(t *testing.T) {
		if tree := treeOf(bootTable, 999); len(tree) != 0 {
			t.Fatalf("tree = %v", tree)
		}
	})

	t.Run("counts and sizes only what is BELOW the pane", func(t *testing.T) {
		s := sessionProcesses([]PaneRef{{SessionID: "repo-claude-abc", PanePid: 200}}, bootTable)
		if len(s) != 1 || s[0].ChildCount != 2 || s[0].ChildRssKb != 70 {
			t.Fatalf("got %+v, want 2 children of 70kB", s)
		}
	})

	t.Run("asks ps once however many sessions there are", func(t *testing.T) {
		var mu sync.Mutex
		reads := 0
		srv := bootProcessesServer(t, func(context.Context) ([]PaneRef, error) {
			return []PaneRef{{SessionID: "a", PanePid: 200}, {SessionID: "b", PanePid: 300}, {SessionID: "c", PanePid: 400}}, nil
		}, func(context.Context) []ProcessRow { mu.Lock(); reads++; mu.Unlock(); return bootTable })
		if status, sessions := bootGetProcesses(t, srv, "processes-test-token"); status != 200 || len(sessions) != 3 {
			t.Fatalf("answered %d %v", status, sessions)
		}
		if reads != 1 {
			t.Fatalf("ps was read %d times for three sessions", reads)
		}
	})

	t.Run("no panes means no ps at all", func(t *testing.T) {
		reads := 0
		srv := bootProcessesServer(t, func(context.Context) ([]PaneRef, error) { return nil, nil },
			func(context.Context) []ProcessRow { reads++; return bootTable })
		if status, sessions := bootGetProcesses(t, srv, "processes-test-token"); status != 200 || len(sessions) != 0 {
			t.Fatalf("answered %d %v", status, sessions)
		}
		if reads != 0 {
			t.Fatalf("ps was read %d times with no panes", reads)
		}
	})

	t.Run("this process and its parent are both in the table, parsed", func(t *testing.T) {
		var self *ProcessRow
		rows := readProcessTable(context.Background())
		for i := range rows {
			if rows[i].Pid == os.Getpid() {
				self = &rows[i]
			}
		}
		if self == nil {
			t.Fatal("the running test is not in the table ps printed")
		}
		if self.Ppid != os.Getppid() || self.RssKb <= 0 {
			t.Fatalf("parsed as %+v", self)
		}
		// The command has spaces in it and is last, so a parse that split on whitespace loses it.
		if !strings.Contains(self.Command, filepath.Base(os.Args[0])) || !strings.Contains(self.Command, " -test.") {
			t.Fatalf("the command column came back as %q", self.Command)
		}
	})

	t.Run("a real child appears under this process's tree", func(t *testing.T) {
		child := exec.Command("/bin/sleep", "5")
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
		tree := treeOf(readProcessTable(context.Background()), os.Getpid())
		if len(tree) == 0 || tree[0].Pid != os.Getpid() {
			t.Fatal("the root of its own tree is missing")
		}
		found := false
		for _, r := range tree {
			if r.Pid == child.Process.Pid && r.Depth == 1 {
				found = true
			}
		}
		if !found {
			t.Fatalf("the child %d is not in this process's tree", child.Process.Pid)
		}
	})

	panes := func(context.Context) ([]PaneRef, error) {
		return []PaneRef{{SessionID: "repo-claude-abc", PanePid: os.Getpid()}}, nil
	}

	t.Run("needs the bearer token, like every route but health and hooks", func(t *testing.T) {
		if status, _ := bootGetProcesses(t, bootProcessesServer(t, panes, nil), ""); status != 401 {
			t.Fatalf("answered %d without a token", status)
		}
	})

	t.Run("answers each session's tree", func(t *testing.T) {
		status, sessions := bootGetProcesses(t, bootProcessesServer(t, panes, nil), "processes-test-token")
		if status != 200 || len(sessions) != 1 || sessions[0].SessionID != "repo-claude-abc" || sessions[0].PanePid != os.Getpid() {
			t.Fatalf("answered %d %+v", status, sessions)
		}
		if len(sessions[0].Processes) == 0 || sessions[0].Processes[0].Pid != os.Getpid() {
			t.Fatal("the pane process is missing from its own tree")
		}
	})

	t.Run("the route answers an empty list rather than failing", func(t *testing.T) {
		status, sessions := bootGetProcesses(t, bootProcessesServer(t, nil, nil), "processes-test-token")
		if status != 200 || sessions == nil || len(sessions) != 0 {
			t.Fatalf("answered %d %v", status, sessions)
		}
	})
}
