package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The whole server against a real tmux on a throwaway socket, driven the way the phone drives it.

type deck struct {
	t       *testing.T
	srv     *httptest.Server
	tmux    *Tmux
	hub     *Hub
	reg     *Registry
	token   string
	repo    string
	clients string
}

func newDeck(t *testing.T) *deck {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "roots")
	repo := filepath.Join(root, "host", "owner", "demo")
	_ = os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	clientDir := filepath.Join(tmp, "client")
	_ = os.MkdirAll(filepath.Join(clientDir, "assets"), 0o755)
	_ = os.WriteFile(filepath.Join(clientDir, "index.html"), []byte("<!doctype html>deck"), 0o644)
	_ = os.WriteFile(filepath.Join(clientDir, "assets", "app-1.js"), []byte("console.log(1)"), 0o644)
	_ = os.WriteFile(filepath.Join(tmp, "secret.txt"), []byte("nope"), 0o644)
	_ = os.Symlink(filepath.Join(tmp, "secret.txt"), filepath.Join(clientDir, "leak.txt"))

	socket := fmt.Sprintf("agentdeck-gotest-%d-%d", os.Getpid(), time.Now().UnixNano()%100000)
	tmux := newTmux(socket, "")
	t.Cleanup(func() {
		// kill-server leaves the socket file behind, and an accumulating pile of them is litter.
		path, _ := tmux.run(context.Background(), "display-message", "-p", "#{socket_path}")
		_, _ = tmux.run(context.Background(), "kill-server")
		if path = strings.TrimSpace(path); strings.Contains(path, socket) {
			_ = os.Remove(path)
		}
	})
	if err := tmux.EnsureServer(context.Background()); err != nil {
		t.Fatal(err)
	}
	profiles, _ := parseProfiles([]byte(`{"sh":{"command":"/bin/sh","waiting":{"via":"hook","settings":"sh.json"}}}`))
	allow := newAllowlist(nil, []string{root})
	token := generateToken()
	reg, _ := newRegistry(tmux, profiles, allow, token)
	d := &deck{t: t, tmux: tmux, reg: reg, token: token, repo: repo, clients: clientDir}
	var ws *WSServer
	d.hub = newHub(tmux, reg, func(id string, st SessionState, c *int) {
		if ws != nil {
			ws.PushState(id, st, c)
		}
	})
	api := newAPIHandler(HTTPDeps{
		Registry: reg, Profiles: profiles, Allowlist: allow, Token: token, Version: version,
		Probe:            func(ctx context.Context) bool { return probeTmux(ctx, socket) },
		OnSessionsChange: func() { _ = d.hub.Sync(context.Background()) },
		StreamFor:        d.hub.StreamFor, Uploads: newUploadStore(filepath.Join(tmp, "uploads")), PanePids: tmux.PanePids,
		OnStateDeclared: func(id string, st SessionState) { d.hub.Announce(id, st, nil) },
	})
	ws = newWSServer(WSDeps{
		Token: token, StreamFor: d.hub.StreamFor,
		CaptureHistory: func(ctx context.Context, id string) (string, error) {
			return tmux.CaptureHistory(ctx, id, historyLines)
		},
		IsAlternate: tmux.IsAlternateScreen,
		PaneModes: func(ctx context.Context, id string) (string, error) {
			m, err := tmux.PaneModes(ctx, id)
			return modeBytes(m), err
		},
		Repaint: d.hub.Repaint, ListSessions: reg.List, SendInput: d.hub.SendInput, ApplyPaneRows: d.hub.ApplyPaneRows,
		NotFound: api,
	})
	d.srv = httptest.NewServer(withClient(api, ws, clientDir))
	t.Cleanup(func() { d.srv.Close(); ws.Close(); d.hub.DisposeAll() })
	return d
}

func (d *deck) do(method, path, token string, body any, headers ...string) (int, map[string]any) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, d.srv.URL+path, r)
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		d.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (d *deck) create() string {
	status, body := d.do("POST", "/api/sessions", d.token, map[string]string{"cwd": d.repo, "agent": "sh"})
	if status != 201 {
		d.t.Fatalf("create: %d %v", status, body)
	}
	return body["session"].(map[string]any)["id"].(string)
}

type wsConn struct {
	t    *testing.T
	c    *websocket.Conn
	msgs chan map[string]any
}

func (d *deck) dial(protocols ...string) (*wsConn, *http.Response, error) {
	if protocols == nil {
		protocols = []string{wsProtocol, d.token}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(d.srv.URL, "http")+"/ws", &websocket.DialOptions{Subprotocols: protocols})
	if err != nil {
		return nil, res, err
	}
	w := &wsConn{t: d.t, c: c, msgs: make(chan map[string]any, 1024)}
	go func() {
		for {
			_, raw, err := c.Read(context.Background())
			if err != nil {
				close(w.msgs)
				return
			}
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			w.msgs <- m
		}
	}()
	d.t.Cleanup(func() { _ = c.CloseNow() })
	return w, res, nil
}

func (w *wsConn) send(m map[string]any) {
	b, _ := json.Marshal(m)
	if err := w.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		w.t.Fatal(err)
	}
}

// until reads frames until match returns true, failing after the timeout.
func (w *wsConn) until(timeout time.Duration, what string, match func(map[string]any) bool) map[string]any {
	deadline := time.After(timeout)
	for {
		select {
		case m, ok := <-w.msgs:
			if !ok {
				w.t.Fatalf("socket closed waiting for %s", what)
			}
			if match(m) {
				return m
			}
		case <-deadline:
			w.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func isT(t string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["t"] == t }
}

func openPTYs(t *testing.T) int {
	out, _ := exec.Command("lsof", "-p", strconv.Itoa(os.Getpid())).Output()
	n := 0
	for _, l := range strings.Split(string(out), "\n") {
		if strings.Contains(l, "/dev/ptmx") || strings.Contains(l, "/dev/ttys") {
			n++
		}
	}
	return n
}

func TestPhoneFlowAgainstRealTmux(t *testing.T) {
	d := newDeck(t)
	id := d.create()
	if id != sessionID(d.repo, "sh") {
		t.Fatalf("id %s", id)
	}

	if _, res, err := d.dial(wsProtocol, "wrong-token"); err == nil || res == nil || res.StatusCode != 401 {
		t.Fatalf("a wrong token is refused before any socket exists: %v", err)
	}
	w, res, err := d.dial()
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Header.Get("sec-websocket-protocol"); got != wsProtocol {
		t.Fatalf("the server must echo the agentdeck protocol, echoed %q", got)
	}
	hello := w.until(3*time.Second, "hello", isT("hello"))
	if hello["cols"].(float64) != paneCols {
		t.Fatal("hello states the pane width")
	}
	list := w.until(3*time.Second, "sessions", isT("sessions"))
	if len(list["sessions"].([]any)) != 1 {
		t.Fatalf("the session list arrives on connect: %v", list)
	}

	w.send(map[string]any{"t": "attach", "sessionId": id, "cols": 50, "rows": 20})
	snap := w.until(5*time.Second, "snapshot", isT("snapshot"))
	epoch, seq := snap["epoch"].(string), int64(snap["seq"].(float64))
	w.until(3*time.Second, "state after attach", isT("state"))

	w.send(map[string]any{"t": "input", "sessionId": id, "data": "echo go-$((40+2))-ok\r"})
	var got strings.Builder
	w.until(5*time.Second, "echoed output", func(m map[string]any) bool {
		if m["t"] == "chunk" {
			got.WriteString(m["data"].(string))
			seq = int64(m["seq"].(float64))
		}
		return strings.Contains(got.String(), "go-42-ok")
	})
	w.send(map[string]any{"t": "input", "sessionId": id, "data": "printf '\\346\\227\\245\\346\\234\\254'\r"})
	got.Reset()
	w.until(5*time.Second, "multibyte output", func(m map[string]any) bool {
		if m["t"] == "chunk" {
			got.WriteString(m["data"].(string))
			seq = int64(m["seq"].(float64))
		}
		return strings.Contains(got.String(), "日本")
	})
	if strings.Contains(got.String(), "�") {
		t.Fatal("a character was split into replacement characters")
	}
	_ = w.c.Close(websocket.StatusNormalClosure, "")

	// Reconnecting with a covered position gets chunks, not a repaint.
	w2, _, err := d.dial()
	if err != nil {
		t.Fatal(err)
	}
	w2.send(map[string]any{"t": "attach", "sessionId": id, "cols": 50, "rows": 20, "haveEpoch": epoch, "haveSeq": seq})
	m := w2.until(5*time.Second, "position", func(m map[string]any) bool { return m["t"] == "state" || m["t"] == "snapshot" || m["t"] == "chunk" })
	if m["t"] == "snapshot" {
		t.Fatal("a covered client is caught up from the buffer, not repainted")
	}
	w2.send(map[string]any{"t": "attach", "sessionId": id, "cols": 50, "rows": 20, "haveEpoch": "stale", "haveSeq": 3})
	w2.until(5*time.Second, "snapshot for a stale epoch", isT("snapshot"))

	// The hook route: the derived secret is accepted, a wrong one mutes the session.
	status, body := d.do("POST", "/api/hooks/"+id, "", map[string]string{"hook_event_name": "Stop"}, "x-agentdeck-secret", secretFor(d.token, id))
	if status != 200 || body["state"] != "waiting" {
		t.Fatalf("hook: %d %v", status, body)
	}
	w2.until(3*time.Second, "waiting pushed to the socket", func(m map[string]any) bool { return m["t"] == "state" && m["state"] == "waiting" })
	if status, _ := d.do("POST", "/api/hooks/"+id, "", map[string]string{"hook_event_name": "Stop"}, "x-agentdeck-secret", "wrong"); status != 401 {
		t.Fatal("a wrong secret is 401")
	}
	_, listed := d.do("GET", "/api/sessions", d.token, nil)
	if listed["sessions"].([]any)[0].(map[string]any)["waitingDetectionLost"] != true {
		t.Fatal("a refused hook marks the session muted")
	}

	// Close ends the whole tree, including a detached child the shell started.
	w2.send(map[string]any{"t": "input", "sessionId": id, "data": "sleep 3600 & echo bg-$!\r"})
	var bg strings.Builder
	var sleepPid int
	w2.until(5*time.Second, "background pid", func(m map[string]any) bool {
		if m["t"] == "chunk" {
			bg.WriteString(m["data"].(string))
		}
		if i := strings.LastIndex(bg.String(), "bg-"); i >= 0 {
			rest := bg.String()[i+3:]
			end := strings.IndexAny(rest, "\r\n")
			if end > 0 {
				sleepPid, _ = strconv.Atoi(rest[:end])
				return sleepPid > 0
			}
		}
		return false
	})
	_, procs := d.do("GET", "/api/processes", d.token, nil)
	if !strings.Contains(fmt.Sprint(procs), "sleep 3600") {
		t.Fatalf("the processes panel shows what the session runs: %v", procs)
	}
	if status, _ := d.do("DELETE", "/api/sessions/"+id, d.token, nil); status != 200 {
		t.Fatal("close")
	}
	if alive(sleepPid) {
		_ = exec.Command("kill", "-9", strconv.Itoa(sleepPid)).Run()
		t.Fatal("closing a session must end what it started")
	}
}

func TestReattachingLeaksNoPTYs(t *testing.T) {
	d := newDeck(t)
	id := d.create()
	before := openPTYs(t)
	for i := 0; i < 30; i++ {
		p, err := newSessionPTY(d.tmux.Socket, id, 50, 20)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(30 * time.Millisecond)
		p.Dispose()
	}
	// Ten more whose tmux client exits on its own: the agent's session ends under them.
	for i := 0; i < 10; i++ {
		other := fmt.Sprintf("short-%d", i)
		if _, err := d.tmux.run(context.Background(), "new-session", "-d", "-s", other, "sleep 0.3"); err != nil {
			t.Fatal(err)
		}
		if _, err := newSessionPTY(d.tmux.Socket, other, 50, 20); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(2 * time.Second)
	if after := openPTYs(t); after > before {
		t.Fatalf("PTYs leaked: %d before, %d after", before, after)
	}
}

func TestHTTPBoundaries(t *testing.T) {
	d := newDeck(t)
	if s, b := d.do("GET", "/api/health", "", nil); s != 200 || b["ok"] != true {
		t.Fatalf("health is unauthenticated: %d %v", s, b)
	}
	if s, _ := d.do("GET", "/api/sessions", "", nil); s != 401 {
		t.Fatal("no token is 401")
	}
	if s, _ := d.do("GET", "/api/sessions", "nope", nil); s != 401 {
		t.Fatal("a wrong token is 401")
	}
	if s, b := d.do("POST", "/api/sessions", d.token, map[string]string{"cwd": "/etc", "agent": "sh"}); s != 403 || !strings.Contains(b["error"].(string), "not on the allowlist") {
		t.Fatalf("an unlisted cwd is 403 with a sentence: %d %v", s, b)
	}
	if s, _ := d.do("POST", "/api/sessions", d.token, map[string]string{"cwd": d.repo, "agent": "ghost"}); s != 404 {
		t.Fatal("an unknown agent is 404")
	}
	if s, _ := d.do("POST", "/api/sessions", d.token, map[string]string{"cwd": d.repo}); s != 400 {
		t.Fatal("both fields are required")
	}
	if s, b := d.do("GET", "/api/cwds", d.token, nil); s != 200 || !strings.Contains(fmt.Sprint(b), d.repo) {
		t.Fatalf("cwds lists the scanned repo: %v", b)
	}
	if s, b := d.do("GET", "/api/agents", d.token, nil); s != 200 || !strings.Contains(fmt.Sprint(b), "detectsWaiting:true") {
		t.Fatalf("agents: %v", b)
	}
	if s, _ := d.do("GET", "/api/nothing", d.token, nil); s != 404 {
		t.Fatal("unknown api route is a JSON 404")
	}
	if s, _ := d.do("GET", "/ws", d.token, nil); s != 404 {
		t.Fatal("a plain GET of /ws is the API's 404")
	}

	get := func(path string) (int, string, http.Header) {
		res, err := http.Get(d.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b), res.Header
	}
	if s, body, h := get("/some/client/route"); s != 200 || body != "<!doctype html>deck" || !strings.Contains(h.Get("content-security-policy"), "frame-ancestors 'none'") {
		t.Fatalf("client routes fall back to index.html with the safety headers: %d %q", s, body)
	}
	if s, _, h := get("/assets/app-1.js"); s != 200 || !strings.Contains(h.Get("cache-control"), "immutable") || !strings.HasPrefix(h.Get("content-type"), "text/javascript") {
		t.Fatal("hashed assets are immutable and served as script")
	}
	if s, _, _ := get("/assets/missing.js"); s != 404 {
		t.Fatal("a missing file is 404, not index.html")
	}
	if s, _, _ := get("/leak.txt"); s != 403 {
		t.Fatal("a symlink out of the client dir is refused")
	}
	if s, _, _ := get("/%2e%2e/secret.txt"); s != 403 && s != 404 {
		t.Fatalf("traversal is refused, got %d", s)
	}
}

func TestOriginCheck(t *testing.T) {
	d := newDeck(t)
	h := d.srv.Config.Handler
	_ = h
	api := newAPIHandler(HTTPDeps{Registry: d.reg, Allowlist: newAllowlist(nil, nil), Token: d.token, Origin: "https://deck.ts.net",
		Probe: func(context.Context) bool { return true }})
	srv := httptest.NewServer(api)
	defer srv.Close()
	req, _ := http.NewRequest("POST", srv.URL+"/api/probe", nil)
	req.Header.Set("authorization", "Bearer "+d.token)
	req.Header.Set("origin", "https://evil.example")
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 403 {
		t.Fatalf("a foreign origin is 403, got %d", res.StatusCode)
	}
	req.Header.Set("origin", "https://deck.ts.net")
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != 200 {
		t.Fatal("the configured origin passes")
	}
}

func TestRestartAdoptsRunningSessions(t *testing.T) {
	d := newDeck(t)
	id := d.create()
	// A second registry over the same tmux is a restarted server: no memory, same derived secret.
	profiles, _ := parseProfiles([]byte(`{"sh":{"command":"/bin/sh"}}`))
	fresh, _ := newRegistry(d.tmux, profiles, newAllowlist(nil, d.reg.allowlist.Roots()), d.token)
	list, err := fresh.List(context.Background())
	if err != nil || len(list) != 1 || list[0].ID != id || list[0].Agent != "sh" {
		t.Fatalf("adopted %v %v", list, err)
	}
	if !fresh.SecretMatches(id, secretFor(d.token, id)) {
		t.Fatal("the secret is derived, so hooks survive a restart")
	}
	if reaped, _ := fresh.Reap(context.Background()); len(reaped) != 0 {
		t.Fatal("an adopted session is never reaped at boot")
	}
}
