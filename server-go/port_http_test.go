package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Port of src/http.test.ts, static.test.ts, pwa.test.ts, origin-check.test.ts, uploads.test.ts,
// token.test.ts and serve-client.test.ts. Each subtest carries the TS test's name.

const htpToken = "test-token-value"
const htpCwd = "/workspace/agentdeck"
const htpSecretKey = "test-secret-key"

// htpFakeTmux is the TS fakeTmux: list, create and kill against a map, nothing else.
func htpFakeTmux(listErr error) *Tmux {
	type sess struct{ path string }
	var mu sync.Mutex
	sessions := map[string]sess{}
	t := &Tmux{Socket: "test"}
	t.exec = func(_ context.Context, args []string, _ map[string]string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		verb, at := "", -1
		for _, n := range []string{"list-sessions", "new-session", "kill-session"} {
			for i, a := range args {
				if a == n && verb == "" {
					verb, at = n, i
				}
			}
		}
		rest := args[at+1:]
		arg := func(flag string) string {
			for i, a := range rest {
				if a == flag && i+1 < len(rest) {
					return rest[i+1]
				}
			}
			return ""
		}
		switch verb {
		case "list-sessions":
			if listErr != nil {
				return "", listErr
			}
			if len(sessions) == 0 {
				return "", &TmuxError{Args: args, Stderr: "no sessions", Err: errors.New("exit 1")}
			}
			ids := make([]string, 0, len(sessions))
			for id := range sessions {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			var out strings.Builder
			for _, id := range ids {
				out.WriteString(strings.Join([]string{id, "0", "", "1700000000", sessions[id].path}, sep) + "\n")
			}
			return out.String(), nil
		case "new-session":
			sessions[arg("-s")] = sess{arg("-c")}
		case "kill-session":
			delete(sessions, strings.TrimPrefix(arg("-t"), "="))
		default:
			if contains(args, "list-panes") || contains(args, "display-message") {
				return "", &TmuxError{Args: args, Stderr: "no sessions", Err: errors.New("exit 1")}
			}
		}
		return "", nil
	}
	return t
}

func htpProfiles(t *testing.T, raw string) map[string]*AgentProfile {
	t.Helper()
	p, rejected := parseProfiles([]byte(raw))
	if len(rejected) > 0 {
		t.Fatalf("profiles rejected: %v", rejected)
	}
	return p
}

type htpAPI struct {
	t    *testing.T
	srv  *httptest.Server
	reg  *Registry
	deps HTTPDeps
}

// htpServeAPI is createHandler over the fake tmux; tweak adjusts the deps before the handler is built.
func htpServeAPI(t *testing.T, listErr error, tweak func(*HTTPDeps)) *htpAPI {
	t.Helper()
	profiles := htpProfiles(t, `{"claude":{"command":"/bin/sh","name":"Claude Code"}}`)
	allow := newAllowlist([]string{htpCwd}, nil)
	reg, err := newRegistry(htpFakeTmux(listErr), profiles, allow, htpSecretKey)
	if err != nil {
		t.Fatal(err)
	}
	d := HTTPDeps{Registry: reg, Profiles: profiles, Allowlist: allow, Token: htpToken, Version: "0.0.0-test",
		Probe: func(context.Context) bool { return true }}
	if tweak != nil {
		tweak(&d)
	}
	srv := httptest.NewServer(newAPIHandler(d))
	t.Cleanup(srv.Close)
	return &htpAPI{t: t, srv: srv, reg: reg, deps: d}
}

// call sends a request; auth adds the bearer token, headers are name/value pairs.
func (a *htpAPI) call(method, path string, auth bool, body io.Reader, headers ...string) (int, map[string]any, http.Header) {
	a.t.Helper()
	req, err := http.NewRequest(method, a.srv.URL+path, body)
	if err != nil {
		a.t.Fatal(err)
	}
	if auth {
		req.Header.Set("authorization", "Bearer "+htpToken)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out, res.Header
}

func htpJSON(v any) io.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}

type htpAnswer struct {
	status int
	body   string
	header http.Header
}

// htpRaw writes the request onto the socket by hand, because net/http's client cleans what it sends.
func htpRaw(t *testing.T, addr, method, target string, headers ...string) htpAnswer {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	lines := []string{method + " " + target + " HTTP/1.1", "Host: 127.0.0.1"}
	for i := 0; i+1 < len(headers); i += 2 {
		lines = append(lines, headers[i]+": "+headers[i+1])
	}
	lines = append(lines, "Connection: close")
	if _, err := conn.Write([]byte(strings.Join(lines, "\r\n") + "\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: method})
	if err != nil {
		t.Fatalf("%s %s got no response: %v", method, target, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return htpAnswer{res.StatusCode, string(b), res.Header}
}

func htpAddr(srv *httptest.Server) string { return strings.TrimPrefix(srv.URL, "http://") }

// ---- src/token.test.ts

func TestHTTP_Token(t *testing.T) {
	t.Run("every generated token survives Sec-WebSocket-Protocol", func(t *testing.T) {
		bad := regexp.MustCompile(`[/+=\s]`)
		for i := 0; i < 500; i++ {
			tok := generateToken()
			if !isWireSafe(tok) || bad.MatchString(tok) {
				t.Fatalf("%s is not an RFC 7230 token", tok)
			}
		}
	})
	t.Run("padded base64 is what the alphabet check exists to reject", func(t *testing.T) {
		if isWireSafe("abc/def+ghi=") {
			t.Fatal("padded base64 passed the alphabet check")
		}
	})
	t.Run("tokens are unique and long enough to be worth having", func(t *testing.T) {
		seen := map[string]bool{}
		for i := 0; i < 200; i++ {
			seen[generateToken()] = true
		}
		if len(seen) != 200 || len(generateToken()) < 40 {
			t.Fatalf("unique %d, length %d", len(seen), len(generateToken()))
		}
	})
	t.Run("matches itself and nothing else", func(t *testing.T) {
		tok := generateToken()
		if !tokenMatches(tok, tok) || tokenMatches(generateToken(), tok) {
			t.Fatal("comparison is wrong")
		}
	})
	t.Run("a length mismatch is false rather than a throw", func(t *testing.T) {
		if tokenMatches("short", generateToken()) || tokenMatches("", generateToken()) {
			t.Fatal("a shorter token matched")
		}
	})
	t.Run("a prefix of the real token does not match", func(t *testing.T) {
		tok := generateToken()
		if tokenMatches(tok[:len(tok)-1], tok) {
			t.Fatal("a prefix matched")
		}
	})
	t.Run("reads a well-formed header", func(t *testing.T) {
		if got := bearerFrom("Bearer abc123"); got != "abc123" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("rejects everything else", func(t *testing.T) {
		for _, h := range []string{"", "abc123", "bearer abc123", "Bearer", "Bearer a b"} {
			if got := bearerFrom(h); got != "" {
				t.Fatalf("accepted %q as %q", h, got)
			}
		}
	})
}

// ---- src/http.test.ts

func TestHTTP_API(t *testing.T) {
	healthy := true
	var healthMu sync.Mutex
	a := htpServeAPI(t, nil, func(d *HTTPDeps) {
		d.Origin = "https://mac.example.ts.net"
		d.Probe = func(context.Context) bool { healthMu.Lock(); defer healthMu.Unlock(); return healthy }
	})
	setHealthy := func(v bool) { healthMu.Lock(); healthy = v; healthMu.Unlock() }
	jsonType := []string{"content-type", "application/json"}

	// The TS server answered 400 from the WHATWG parser; Go's parser takes `//` and `/\` as paths.
	for _, target := range []string{"//", "/\\", "http://["} {
		t.Run(target+" is a 400, not the process", func(t *testing.T) {
			res := htpRaw(t, htpAddr(a.srv), "GET", target)
			if res.status >= 500 || res.status < 400 {
				t.Fatalf("%s answered %d", target, res.status)
			}
			if target == "http://[" && res.status != 400 {
				t.Fatalf("an unparseable target answered %d", res.status)
			}
			if s, _, _ := a.call("GET", "/api/health", false, nil); s != 200 {
				t.Fatalf("the server did not survive %s", target)
			}
		})
	}

	t.Run("is unauthenticated, because the probe must not need the token that starts processes", func(t *testing.T) {
		s, b, _ := a.call("GET", "/api/health", false, nil)
		if s != 200 || b["ok"] != true || b["version"] != "0.0.0-test" {
			t.Fatalf("%d %v", s, b)
		}
	})
	t.Run("reports 503 when the event loop cannot answer", func(t *testing.T) {
		setHealthy(false)
		defer setHealthy(true)
		s, b, _ := a.call("GET", "/api/health", false, nil)
		if s != 503 || b["ok"] != false {
			t.Fatalf("%d %v", s, b)
		}
	})

	t.Run("every real route refuses without a token", func(t *testing.T) {
		for _, p := range []string{"/api/sessions", "/api/agents", "/api/cwds"} {
			if s, _, _ := a.call("GET", p, false, nil); s != 401 {
				t.Fatalf("%s answered %d without a token", p, s)
			}
		}
	})
	t.Run("a wrong token is refused", func(t *testing.T) {
		if s, _, _ := a.call("GET", "/api/sessions", false, nil, "authorization", "Bearer not-the-token"); s != 401 {
			t.Fatal(s)
		}
	})
	t.Run("a token in the query string does not work", func(t *testing.T) {
		if s, _, _ := a.call("GET", "/api/sessions?token="+htpToken, false, nil); s != 401 {
			t.Fatal(s)
		}
	})
	t.Run("a foreign Origin is refused, so a page the phone visits cannot drive the API", func(t *testing.T) {
		if s, _, _ := a.call("GET", "/api/sessions", true, nil, "origin", "https://evil.example"); s != 403 {
			t.Fatal(s)
		}
	})
	t.Run("POST /api/probe answers ok, needs the token, and is refused for a foreign Origin", func(t *testing.T) {
		if s, _, _ := a.call("POST", "/api/probe", false, nil); s != 401 {
			t.Fatalf("unauthenticated %d", s)
		}
		if s, _, _ := a.call("POST", "/api/probe", true, nil, "origin", "https://evil.example"); s != 403 {
			t.Fatalf("foreign %d", s)
		}
		_, before, _ := a.call("GET", "/api/sessions", true, nil)
		s, b, _ := a.call("POST", "/api/probe", true, nil, "origin", "https://mac.example.ts.net")
		if s != 200 || b["ok"] != true {
			t.Fatalf("%d %v", s, b)
		}
		_, after, _ := a.call("GET", "/api/sessions", true, nil)
		if len(before["sessions"].([]any)) != len(after["sessions"].([]any)) {
			t.Fatal("the probe changed the session list")
		}
	})
	t.Run("the expected Origin is allowed", func(t *testing.T) {
		if s, _, _ := a.call("GET", "/api/sessions", true, nil, "origin", "https://mac.example.ts.net"); s != 200 {
			t.Fatal(s)
		}
	})

	t.Run("creating takes a profile id and never a command line", func(t *testing.T) {
		s, b, _ := a.call("POST", "/api/sessions", true, htpJSON(map[string]string{"cwd": htpCwd, "agent": "claude"}), jsonType...)
		if s != 201 {
			t.Fatalf("%d %v", s, b)
		}
		sess := b["session"].(map[string]any)
		if sess["agent"] != "claude" || sess["cwd"] != htpCwd {
			t.Fatalf("%v", sess)
		}
	})
	t.Run("a command in the body is ignored rather than honoured", func(t *testing.T) {
		s, b, _ := a.call("POST", "/api/sessions", true,
			htpJSON(map[string]string{"cwd": htpCwd, "agent": "claude", "command": "/bin/evil"}), jsonType...)
		raw, _ := json.Marshal(b)
		if s != 201 || strings.Contains(string(raw), "evil") {
			t.Fatalf("%d %s", s, raw)
		}
	})
	t.Run("a cwd off the mount list is 403 with a sentence, not a bare code", func(t *testing.T) {
		s, b, _ := a.call("POST", "/api/sessions", true, htpJSON(map[string]string{"cwd": "/etc", "agent": "claude"}), jsonType...)
		if s != 403 || !strings.Contains(fmt.Sprint(b["error"]), "AGENTDECK_MOUNTS") {
			t.Fatalf("%d %v", s, b)
		}
	})
	t.Run("an unknown agent is 404", func(t *testing.T) {
		if s, _, _ := a.call("POST", "/api/sessions", true, htpJSON(map[string]string{"cwd": htpCwd, "agent": "nope"}), jsonType...); s != 404 {
			t.Fatal(s)
		}
	})
	t.Run("a missing field is 400", func(t *testing.T) {
		if s, _, _ := a.call("POST", "/api/sessions", true, htpJSON(map[string]string{"cwd": htpCwd}), jsonType...); s != 400 {
			t.Fatal(s)
		}
	})
	t.Run("listing never carries a secret", func(t *testing.T) {
		_, b, _ := a.call("GET", "/api/sessions", true, nil)
		raw, _ := json.Marshal(b)
		if regexp.MustCompile(`(?i)secret`).Match(raw) {
			t.Fatalf("%s", raw)
		}
	})

	t.Run("agents report availability and whether they detect waiting", func(t *testing.T) {
		_, b, _ := a.call("GET", "/api/agents", true, nil)
		agent := b["agents"].([]any)[0].(map[string]any)
		if agent["id"] != "claude" || agent["available"] != true || agent["detectsWaiting"] != false {
			t.Fatalf("%v", agent)
		}
	})
	t.Run("cwds serves the mount list with the live sessions in each", func(t *testing.T) {
		_, b, _ := a.call("GET", "/api/cwds", true, nil)
		cwd := b["cwds"].([]any)[0].(map[string]any)
		if cwd["path"] != htpCwd || cwd["name"] != "agentdeck" || len(cwd["sessions"].([]any)) < 1 {
			t.Fatalf("%v", cwd)
		}
	})

	t.Run("does NOT accept the user's bearer token", func(t *testing.T) {
		list, _ := a.reg.List(context.Background())
		if len(list) == 0 {
			t.Fatal("no session to post to")
		}
		if s, _, _ := a.call("POST", "/api/hooks/"+list[0].ID, true, htpJSON(map[string]string{"hook_event_name": "Stop"}), jsonType...); s != 401 {
			t.Fatal(s)
		}
	})
	t.Run("refuses an unknown session", func(t *testing.T) {
		if s, _, _ := a.call("POST", "/api/hooks/no-such-session", false, strings.NewReader("{}"),
			"x-agentdeck-secret", "anything", "content-type", "application/json"); s != 401 {
			t.Fatal(s)
		}
	})

	t.Run("an unknown route is 404 and says what it did not match", func(t *testing.T) {
		s, b, _ := a.call("GET", "/api/nonexistent", true, nil)
		if s != 404 || !strings.Contains(fmt.Sprint(b["error"]), "/api/nonexistent") {
			t.Fatalf("%d %v", s, b)
		}
	})
	t.Run("an oversized body is refused rather than buffered", func(t *testing.T) {
		s, b, _ := a.call("POST", "/api/sessions", true, strings.NewReader(strings.Repeat("x", 200_000)), jsonType...)
		if s != 413 || !strings.Contains(fmt.Sprint(b["error"]), "too large") {
			t.Fatalf("%d %v", s, b)
		}
	})
	t.Run("responses are not cacheable and not sniffable", func(t *testing.T) {
		_, _, h := a.call("GET", "/api/health", false, nil)
		if h.Get("cache-control") != "no-store" || h.Get("x-content-type-options") != "nosniff" {
			t.Fatalf("%v", h)
		}
	})
}

func TestHTTP_HookAuthenticated(t *testing.T) {
	stream := newStream("test")
	var mu sync.Mutex
	type decl struct {
		id    string
		state SessionState
	}
	var declared []decl
	a := htpServeAPI(t, nil, func(d *HTTPDeps) {
		d.StreamFor = func(string) *Stream { return stream }
		d.OnStateDeclared = func(id string, s SessionState) { mu.Lock(); declared = append(declared, decl{id, s}); mu.Unlock() }
	})
	created, err := a.reg.Create(context.Background(), htpCwd, "claude")
	if err != nil {
		t.Fatal(err)
	}
	id := created.Session.ID
	// TS overrode secretMatches; here the real secret is derived the way the registry derives it.
	secret := secretFor(htpSecretKey, id)
	post := func(body io.Reader) (int, map[string]any) {
		s, b, _ := a.call("POST", "/api/hooks/"+id, false, body, "x-agentdeck-secret", secret, "content-type", "application/json")
		return s, b
	}
	event := func(name string) map[string]any {
		_, b := post(htpJSON(map[string]string{"hook_event_name": name, "tool_name": "Bash"}))
		return b
	}
	snapshot := func() []decl { mu.Lock(); defer mu.Unlock(); return append([]decl(nil), declared...) }
	streamState := func() SessionState { s, _ := stream.State(); return s }

	t.Run("Stop declares waiting on the stream and on the list", func(t *testing.T) {
		if b := event("Stop"); b["ok"] != true || b["state"] != "waiting" {
			t.Fatalf("%v", b)
		}
		list, _ := a.reg.List(context.Background())
		if streamState() != StateWaiting || list[0].State != StateWaiting {
			t.Fatalf("stream %s list %s", streamState(), list[0].State)
		}
	})
	t.Run("PreToolUse declares working", func(t *testing.T) {
		if b := event("PreToolUse"); b["ok"] != true || b["state"] != "working" || streamState() != StateWorking {
			t.Fatalf("%v %s", b, streamState())
		}
	})
	t.Run("an unrecognised event name leaves the state alone", func(t *testing.T) {
		event("Stop")
		if b := event("PreCompact"); b["ok"] != true || b["state"] != nil {
			t.Fatalf("%v", b)
		}
		if streamState() != StateWaiting {
			t.Fatal("the previous statement must still stand")
		}
	})
	t.Run("the state it declared is pushed onward, naming the session it belongs to", func(t *testing.T) {
		before := len(snapshot())
		event("Stop")
		got := snapshot()[before:]
		if len(got) != 1 || got[0] != (decl{id, StateWaiting}) {
			t.Fatalf("the hook wrote the state down and told nobody: %v", got)
		}
	})
	t.Run("an event that changes no state announces nothing", func(t *testing.T) {
		event("Stop")
		before := len(snapshot())
		if b := event("PreCompact"); b["state"] != nil {
			t.Fatalf("%v", b)
		}
		if got := snapshot()[before:]; len(got) != 0 {
			t.Fatalf("announced %v", got)
		}
	})
	t.Run("a body that is not JSON is 400 rather than 500", func(t *testing.T) {
		if s, _ := post(strings.NewReader("not json")); s != 400 {
			t.Fatal(s)
		}
	})
	t.Run("a loop is bounded, and told why, rather than fanning out per POST", func(t *testing.T) {
		var statuses []int
		for i := 0; i < 60; i++ {
			name := "PreToolUse"
			if i%2 == 0 {
				name = "Stop"
			}
			s, _ := post(htpJSON(map[string]string{"hook_event_name": name, "tool_name": "Bash"}))
			statuses = append(statuses, s)
		}
		ok, limited := 0, false
		for _, s := range statuses {
			ok += map[bool]int{true: 1}[s == 200]
			limited = limited || s == 429
		}
		if !limited {
			t.Fatal("sixty posts in a tight loop were all accepted, so nothing bounds the fan-out")
		}
		if ok < 10 {
			t.Fatal("the burst was too small")
		}
	})
}

func TestHTTP_HookUnauthenticated(t *testing.T) {
	t.Run("a wrong secret is 401 and announces no state", func(t *testing.T) {
		var mu sync.Mutex
		var declared []SessionState
		a := htpServeAPI(t, nil, func(d *HTTPDeps) {
			d.OnStateDeclared = func(_ string, s SessionState) { mu.Lock(); declared = append(declared, s); mu.Unlock() }
		})
		created, err := a.reg.Create(context.Background(), htpCwd, "claude")
		if err != nil {
			t.Fatal(err)
		}
		s, _, _ := a.call("POST", "/api/hooks/"+created.Session.ID, false, htpJSON(map[string]string{"hook_event_name": "Stop"}),
			"x-agentdeck-secret", "not-the-secret", "content-type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		list, _ := a.reg.List(context.Background())
		if s != 401 || len(declared) != 0 || list[0].State != StateIdle {
			t.Fatalf("%d %v %s", s, declared, list[0].State)
		}
	})
}

func TestHTTP_FailureSaysNothingAboutItself(t *testing.T) {
	t.Run("the 500 body carries a reference, not the error text", func(t *testing.T) {
		a := htpServeAPI(t, errors.New("Command failed: tmux -e AGENTDECK_SECRET=s3cret -e API_KEY=sk-live-xyz"), nil)
		s, b, _ := a.call("GET", "/api/sessions", true, nil)
		text := fmt.Sprint(b["error"])
		if s != 500 || strings.Contains(text, "s3cret") || strings.Contains(text, "sk-live-xyz") ||
			!regexp.MustCompile(`ref [0-9a-f]{12}`).MatchString(text) {
			t.Fatalf("%d %q", s, text)
		}
	})
}

// ---- src/origin-check.test.ts

// htpRepo is the checkout holding server-go/go.mod: AGENTDECK_TEST_REPO, or an ancestor of the cwd.
func htpRepo(t *testing.T) string {
	t.Helper()
	if r := os.Getenv("AGENTDECK_TEST_REPO"); r != "" {
		return r
	}
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "server-go", "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no agentdeck checkout above the working directory; set AGENTDECK_TEST_REPO")
		}
		dir = parent
	}
}

func htpRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestHTTP_OriginCheck(t *testing.T) {
	t.Run("unconfigured, /api accepts a foreign Origin - the ground truth the docs must match", func(t *testing.T) {
		a := htpServeAPI(t, nil, nil)
		if s, _, _ := a.call("GET", "/api/agents", true, nil, "origin", "https://evil.example"); s != 200 {
			t.Fatalf("with no expected origin the check does nothing, got %d", s)
		}
	})
	t.Run("plan 001 says the check is off until AGENTDECK_ORIGIN is set", func(t *testing.T) {
		plan := htpRead(t, filepath.Join(htpRepo(t), "plans", "001-architecture.md"))
		if !strings.Contains(plan, "AGENTDECK_ORIGIN") || !regexp.MustCompile(`[Pp]resent but off until configured`).MatchString(plan) {
			t.Fatal("plan 001 does not carry the caveat")
		}
	})
	t.Run("TODO's ticked m1/auth-token carries the same caveat", func(t *testing.T) {
		todo := htpRead(t, filepath.Join(htpRepo(t), "TODO.md"))
		start := strings.Index(todo, "`m1/auth-token`")
		if start < 0 {
			t.Fatal("no m1/auth-token item")
		}
		item := todo[start:]
		if end := strings.Index(item, "\n\n- "); end >= 0 {
			item = item[:end]
		}
		if !strings.Contains(item, "AGENTDECK_ORIGIN") || !strings.Contains(item, "present but off") {
			t.Fatal("the TODO item does not carry the caveat")
		}
	})
	t.Run("the server warns at boot when it is unset", func(t *testing.T) {
		// What the Go server prints, rather than what a source file says it would print.
		srv := htpSpawn(t, "", htpBuildCopy(t))
		if !regexp.MustCompile(`(?s)AGENTDECK_ORIGIN.*is not set`).MatchString(srv.stderr()) ||
			!strings.Contains(srv.stderr(), "the Origin check plan 001 describes is off") {
			t.Fatalf("no warning at boot:\n%s", srv.stderr())
		}
	})
}

// ---- src/uploads.test.ts

var htpPNG = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}

func TestHTTP_Uploads(t *testing.T) {
	t.Run("the extension comes from the declared type, with parameters ignored", func(t *testing.T) {
		if extensionFor("image/png") != "png" || extensionFor("image/jpeg; charset=binary") != "jpg" || extensionFor("IMAGE/PNG") != "png" {
			t.Fatal("extension mapping is wrong")
		}
	})
	t.Run("anything not an image on the list is refused", func(t *testing.T) {
		for _, ty := range []string{"text/html", "application/x-sh", "image/svg+xml", ""} {
			if extensionFor(ty) != "" {
				t.Fatalf("%q was accepted", ty)
			}
		}
	})
	t.Run("names the file itself and never the client", func(t *testing.T) {
		store := newUploadStore(t.TempDir())
		path, err := store.Save("repo-claude-abcd1234", "image/png", htpPNG)
		if err != nil || !regexp.MustCompile(`/repo-claude-abcd1234/[0-9a-f]{12}\.png$`).MatchString(path) {
			t.Fatalf("%s %v", path, err)
		}
		if b, _ := os.ReadFile(path); !bytes.Equal(b, htpPNG) {
			t.Fatal("bytes differ")
		}
	})
	t.Run("a session id that is not one is still confined to one directory", func(t *testing.T) {
		root := t.TempDir()
		path, err := newUploadStore(root).Save("../../etc/cron.d", "image/png", htpPNG)
		if err != nil || !strings.HasPrefix(path, root+"/") || strings.Contains(path, "..") {
			t.Fatalf("%s escaped %s (%v)", path, root, err)
		}
	})
	t.Run("refuses a type off the safelist without writing anything", func(t *testing.T) {
		root := t.TempDir()
		_, err := newUploadStore(root).Save("s", "text/html", htpPNG)
		var unsupported *UnsupportedImageError
		entries, _ := os.ReadDir(root)
		if !errors.As(err, &unsupported) || len(entries) != 0 {
			t.Fatalf("%v %v", err, entries)
		}
	})
	t.Run("keeps only the newest few", func(t *testing.T) {
		root := t.TempDir()
		store := &UploadStore{root: root, keep: 2}
		var written []string
		for i := 0; i < 4; i++ {
			path, err := store.Save("s", "image/png", htpPNG)
			if err != nil {
				t.Fatal(err)
			}
			// Stamped apart by hand so the test is about the pruning, not the filesystem clock.
			at := time.UnixMilli(1700000000000 + int64(i)*1000)
			_ = os.Chtimes(path, at, at)
			written = append(written, filepath.Base(path))
		}
		entries, _ := os.ReadDir(filepath.Join(root, "s"))
		var left []string
		for _, e := range entries {
			left = append(left, e.Name())
		}
		want := append([]string(nil), written[2:]...)
		sort.Strings(want)
		if fmt.Sprint(left) != fmt.Sprint(want) {
			t.Fatalf("left %v, want %v", left, want)
		}
	})

	root := t.TempDir()
	a := htpServeAPI(t, nil, func(d *HTTPDeps) { d.Uploads = newUploadStore(root) })
	created, err := a.reg.Create(context.Background(), htpCwd, "claude")
	if err != nil {
		t.Fatal(err)
	}
	sid := created.Session.ID
	post := func(id string, body []byte, ty string, auth bool) (int, map[string]any) {
		s, b, _ := a.call("POST", "/api/sessions/"+url.PathEscape(id)+"/uploads", auth, bytes.NewReader(body), "content-type", ty)
		return s, b
	}

	t.Run("writes the bytes and answers with the path", func(t *testing.T) {
		s, b := post(sid, htpPNG, "image/png", true)
		if s != 201 {
			t.Fatalf("%d %v", s, b)
		}
		if got, _ := os.ReadFile(fmt.Sprint(b["path"])); !bytes.Equal(got, htpPNG) {
			t.Fatal("bytes differ")
		}
	})
	t.Run("needs the user's token", func(t *testing.T) {
		if s, _ := post(sid, htpPNG, "image/png", false); s != 401 {
			t.Fatal(s)
		}
	})
	t.Run("refuses a session that is not ours", func(t *testing.T) {
		if s, _ := post("../../../etc", htpPNG, "image/png", true); s != 404 {
			t.Fatal(s)
		}
		entries, _ := os.ReadDir(root)
		for _, e := range entries {
			if e.Name() != safeSegment(sid) {
				t.Fatalf("a directory appeared: %s", e.Name())
			}
		}
	})
	t.Run("refuses a type off the safelist", func(t *testing.T) {
		if s, _ := post(sid, []byte("<script>"), "text/html", true); s != 415 {
			t.Fatal(s)
		}
	})
	t.Run("refuses an empty body rather than writing a zero-byte image", func(t *testing.T) {
		if s, _ := post(sid, nil, "image/png", true); s != 400 {
			t.Fatal(s)
		}
	})
	t.Run("refuses a body above the ceiling", func(t *testing.T) {
		if s, _ := post(sid, make([]byte, 9*1024*1024), "image/png", true); s != 413 {
			t.Fatal(s)
		}
	})
}

// ---- src/static.test.ts

const htpSecret = "not-the-clients-business-9f2c1a"

func htpStubAPI() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"no route"}`))
	})
}

// htpServeClient is withClient over dir, with a real socket server whose plain GETs fall to api.
func htpServeClient(t *testing.T, dir string) *httptest.Server {
	t.Helper()
	api := htpStubAPI()
	ws := newWSServer(WSDeps{NotFound: api})
	srv := httptest.NewServer(withClient(api, ws, dir))
	t.Cleanup(func() { srv.Close(); ws.Close() })
	return srv
}

func htpWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHTTP_Static(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "dist", "client")
	outside := filepath.Join(tmp, "private")
	_ = os.MkdirAll(filepath.Join(root, "assets"), 0o755)
	_ = os.MkdirAll(outside, 0o755)
	secretFile := filepath.Join(outside, "token")
	htpWrite(t, secretFile, htpSecret)
	htpWrite(t, filepath.Join(root, "index.html"), "<!doctype html><div id=app></div>")
	htpWrite(t, filepath.Join(root, "assets", "index-abc123.js"), "export const a = 1;\n")
	htpWrite(t, filepath.Join(root, "café.txt"), "inside the build directory\n")
	_ = os.Symlink(secretFile, filepath.Join(root, "leak"))
	_ = os.Symlink(outside, filepath.Join(root, "assets", "elsewhere"))
	srv := htpServeClient(t, root)
	addr := htpAddr(srv)
	get := func(t *testing.T, p string) htpAnswer { return htpRaw(t, addr, "GET", p) }
	html := "text/html; charset=utf-8"
	stillSecret := func(t *testing.T) {
		if htpRead(t, secretFile) != htpSecret {
			t.Fatal("the secret file changed")
		}
	}

	t.Run("the root serves index.html, uncached, with nothing injected", func(t *testing.T) {
		r := get(t, "/")
		if r.status != 200 || r.header.Get("content-type") != html || r.header.Get("cache-control") != "no-cache" ||
			r.body != htpRead(t, filepath.Join(root, "index.html")) {
			t.Fatalf("%d %v %q", r.status, r.header, r.body)
		}
	})
	t.Run("a hashed asset gets its own MIME type and an immutable cache", func(t *testing.T) {
		r := get(t, "/assets/index-abc123.js")
		if r.status != 200 || r.header.Get("content-type") != "text/javascript; charset=utf-8" ||
			!strings.Contains(r.header.Get("cache-control"), "immutable") {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})
	t.Run("an unknown path falls back to index.html so client routes work", func(t *testing.T) {
		if r := get(t, "/session/abc"); r.status != 200 || r.header.Get("content-type") != html {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})
	t.Run("a missing asset is a 404, not the HTML page", func(t *testing.T) {
		if r := get(t, "/assets/index-gone.js"); r.status != 404 || strings.Contains(strings.ToLower(r.body), "doctype") {
			t.Fatalf("%d %q", r.status, r.body)
		}
	})

	escapes := []string{
		"/../private/token",
		"/assets/../../private/token",
		"/%2e%2e/private/token",
		"/%2e%2e%2f%2e%2e%2fprivate%2ftoken",
		"/" + url.QueryEscape("/etc/passwd"),
		"/leak",
		"/assets/elsewhere/token",
		"/index.html%00.png",
		"/..\\..\\private\\token",
		"/%2e%2e%5c%2e%2e%5cprivate%5ctoken",
	}
	for _, p := range escapes {
		t.Run(p+" is refused rather than served", func(t *testing.T) {
			r := get(t, p)
			stillSecret(t)
			if strings.Contains(r.body, htpSecret) || (r.status != 403 && r.status != 404) {
				t.Fatalf("%s answered %d %q", p, r.status, r.body)
			}
		})
	}
	for _, p := range []string{"/....//....//private/token", "//private/token", "/./private/token"} {
		t.Run(p+" lands inside the build directory", func(t *testing.T) {
			r := get(t, p)
			stillSecret(t)
			if strings.Contains(r.body, htpSecret) || r.status != 200 || r.header.Get("content-type") != html {
				t.Fatalf("%s answered %d %v", p, r.status, r.header)
			}
		})
	}
	for _, p := range []string{"//", "/\\", "http://["} {
		t.Run(p+" is answered rather than taking the process down", func(t *testing.T) {
			r := get(t, p)
			if r.status == 0 || strings.Contains(r.body, htpSecret) {
				t.Fatalf("%s answered %d", p, r.status)
			}
			if after := get(t, "/"); after.status != 200 {
				t.Fatalf("the server did not survive %s", p)
			}
		})
	}
	t.Run("a double-encoded climb is a filename, and lands inside the build directory", func(t *testing.T) {
		r := get(t, "/..%252fprivate/token")
		if r.status != 200 || strings.Contains(r.body, htpSecret) || r.header.Get("content-type") != html {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})

	t.Run("a decomposed unicode spelling lands inside the build directory or is refused", func(t *testing.T) {
		r := get(t, "/"+url.PathEscape("café.txt"))
		if (r.status != 200 && r.status != 404) || strings.Contains(r.body, htpSecret) {
			t.Fatalf("answered %d", r.status)
		}
	})
	t.Run("HEAD gets the headers and no body", func(t *testing.T) {
		r := htpRaw(t, addr, "HEAD", "/assets/index-abc123.js")
		if r.status != 200 || !strings.Contains(r.header.Get("content-type"), "javascript") || r.body != "" {
			t.Fatalf("%d %v %q", r.status, r.header, r.body)
		}
	})
	t.Run("a write method is refused rather than routed into the build directory", func(t *testing.T) {
		r := htpRaw(t, addr, "DELETE", "/index.html")
		if r.status != 405 || strings.Contains(strings.ToLower(r.body), "doctype") {
			t.Fatalf("%d %q", r.status, r.body)
		}
	})
	t.Run("every answer says nosniff, so a served type is the type the browser uses", func(t *testing.T) {
		for _, p := range []string{"/", "/assets/index-abc123.js"} {
			if get(t, p).header.Get("x-content-type-options") != "nosniff" {
				t.Fatalf("%s is sniffable", p)
			}
		}
	})
	t.Run("no answer can be framed, and none may load or talk off-origin", func(t *testing.T) {
		for _, p := range []string{"/", "/assets/index-abc123.js", "/../private/token", "/assets/gone.js"} {
			r := get(t, p)
			csp := r.header.Get("content-security-policy")
			if r.header.Get("x-frame-options") != "DENY" || !strings.Contains(csp, "frame-ancestors 'none'") ||
				!strings.Contains(csp, "default-src 'self'") {
				t.Fatalf("%s: %v", p, r.header)
			}
		}
	})

	t.Run("a file that vanishes mid-request is a 404, not a dead process", func(t *testing.T) {
		churn := filepath.Join(root, "assets", "churn.js")
		away := filepath.Join(root, "assets", "churn.away")
		htpWrite(t, churn, "export const churn = 1;\n")
		stop := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				select {
				case <-stop:
					return
				default:
				}
				_ = os.Rename(churn, away)
				runtime.Gosched()
				_ = os.Rename(away, churn)
				runtime.Gosched()
			}
		}()
		var mu sync.Mutex
		bad := map[int]int{}
		for round := 0; round < 40; round++ {
			var wg sync.WaitGroup
			for i := 0; i < 8; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					res, err := http.Get(srv.URL + "/assets/churn.js")
					if err != nil {
						return
					}
					_, _ = io.Copy(io.Discard, res.Body)
					res.Body.Close()
					if res.StatusCode != 200 && res.StatusCode != 404 {
						mu.Lock()
						bad[res.StatusCode]++
						mu.Unlock()
					}
				}()
			}
			wg.Wait()
		}
		close(stop)
		<-done
		if len(bad) > 0 {
			t.Fatalf("a vanished file was answered with %v rather than a 404", bad)
		}
		if r := get(t, "/"); r.status != 200 || r.header.Get("content-type") != html {
			t.Fatalf("%d", r.status)
		}
	})
	t.Run("an aborted download does not leak the descriptor it opened", func(t *testing.T) {
		big := filepath.Join(root, "assets", "big-0000.js")
		htpWrite(t, big, `export const big = "`+strings.Repeat("x", 24<<20)+"\";\n")
		abort := func() {
			conn, err := net.Dial("tcp", addr)
			if err != nil {
				return
			}
			_, _ = conn.Write([]byte("GET /assets/big-0000.js HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"))
			time.Sleep(25 * time.Millisecond)
			_ = conn.Close()
		}
		for round := 0; round < 6; round++ {
			var wg sync.WaitGroup
			for i := 0; i < 20; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); abort() }()
			}
			wg.Wait()
		}
		time.Sleep(250 * time.Millisecond)
		out, err := exec.Command("lsof", "-p", strconv.Itoa(os.Getpid()), "-Fn").Output()
		if err != nil {
			return // No lsof here; nothing to measure against.
		}
		open := 0
		for _, l := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(l, "n") && strings.HasSuffix(l, "/big-0000.js") {
				open++
			}
		}
		if open > 5 {
			t.Fatalf("%d descriptors still open on an aborted download", open)
		}
	})

	t.Run("a 404 from the API stays a JSON 404", func(t *testing.T) {
		r := get(t, "/api/nope")
		if r.status != 404 || r.header.Get("content-type") != "application/json" || r.body != `{"error":"no route"}` {
			t.Fatalf("%d %v %q", r.status, r.header, r.body)
		}
	})
	t.Run("/ws is the socket route's, not the page's", func(t *testing.T) {
		if r := get(t, "/ws"); r.status != 404 || r.header.Get("content-type") != "application/json" {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})

	unbuilt := htpServeClient(t, filepath.Join(tmp, "agentdeck-no-such-build"))
	t.Run("serves a sentence naming the command to run, not a silent 404", func(t *testing.T) {
		r := htpRaw(t, htpAddr(unbuilt), "GET", "/")
		if r.status != 503 || !strings.Contains(r.body, "pnpm build") || strings.Contains(r.body, "/") {
			t.Fatalf("%d %q", r.status, r.body)
		}
	})
	t.Run("the API still answers", func(t *testing.T) {
		r := htpRaw(t, htpAddr(unbuilt), "GET", "/api/nope")
		if r.status != 404 || r.header.Get("content-type") != "application/json" {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})
}

// ---- src/pwa.test.ts

// htpClientDir is the real build, built when absent rather than skipped, as the TS suite does.
func htpClientDir(t *testing.T) string {
	t.Helper()
	repo := htpRepo(t)
	dir := filepath.Join(repo, "dist", "client")
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		cmd := exec.Command("pnpm", "build")
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("pnpm build: %v\n%s", err, out)
		}
	}
	return dir
}

func htpGet(t *testing.T, u string) (int, string, http.Header) {
	t.Helper()
	res, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b), res.Header
}

// htpIsPictographic covers the Extended_Pictographic blocks Go's regexp has no class for.
func htpIsPictographic(r rune) bool {
	return (r >= 0x1F000 && r <= 0x1FAFF) || (r >= 0x2600 && r <= 0x27BF) || (r >= 0x2B00 && r <= 0x2BFF) ||
		r == 0x203C || r == 0x2049 || r == 0x2122 || r == 0x2139 || (r >= 0x2194 && r <= 0x21AA) ||
		(r >= 0x231A && r <= 0x23FF) || (r >= 0x25AA && r <= 0x25FE) || r == 0x3030 || r == 0x303D || r == 0x3297 || r == 0x3299
}

func TestHTTP_PWA(t *testing.T) {
	clientDir := htpClientDir(t)
	srv := htpServeClient(t, clientDir)
	base := srv.URL
	served := func(t *testing.T, p string) string { _, b, _ := htpGet(t, base+p); return b }
	page := htpRead(t, filepath.Join(clientDir, "index.html"))
	assetName := func(t *testing.T, ext string) string {
		for _, m := range regexp.MustCompile(`/assets/([^"]+)`).FindAllStringSubmatch(page, -1) {
			if strings.HasSuffix(m[1], ext) {
				return m[1]
			}
		}
		t.Fatalf("the built page names no %s asset", ext)
		return ""
	}
	asset := func(t *testing.T, ext string) string { return served(t, "/assets/"+assetName(t, ext)) }
	type manifest struct {
		Display  string `json:"display"`
		Scope    string `json:"scope"`
		StartURL string `json:"start_url"`
		Icons    []struct{ Src, Sizes, Type string }
	}
	pngSize := func(t *testing.T, file string) (uint32, uint32) {
		b, err := os.ReadFile(file)
		if err != nil || len(b) < 24 || !bytes.Equal(b[:8], htpPNG) || string(b[12:16]) != "IHDR" {
			t.Fatalf("%s is not a PNG", file)
		}
		return binary.BigEndian.Uint32(b[16:20]), binary.BigEndian.Uint32(b[20:24])
	}
	weakCache := regexp.MustCompile(`no-cache|no-store|max-age=0`)

	t.Run("it is served with the type that makes a browser read it, and it parses", func(t *testing.T) {
		s, body, h := htpGet(t, base+"/manifest.webmanifest")
		var m manifest
		if s != 200 || !strings.HasPrefix(h.Get("content-type"), "application/manifest+json") || json.Unmarshal([]byte(body), &m) != nil {
			t.Fatalf("%d %v", s, h)
		}
		if m.Display != "standalone" || m.Scope != "/" || m.StartURL != "/" {
			t.Fatalf("%+v", m)
		}
	})
	t.Run("the page links it, and asks for the viewport the safe-area insets need", func(t *testing.T) {
		p := served(t, "/")
		if !strings.Contains(p, `<link rel="manifest" href="/manifest.webmanifest"`) || !strings.Contains(p, "viewport-fit=cover") ||
			!strings.Contains(p, `apple-mobile-web-app-capable" content="yes"`) {
			t.Fatal("the page does not link the manifest or the viewport")
		}
	})
	t.Run("every icon it names exists, at the size it claims", func(t *testing.T) {
		var m manifest
		_ = json.Unmarshal([]byte(served(t, "/manifest.webmanifest")), &m)
		if len(m.Icons) == 0 {
			t.Fatal("a manifest with no icons is not installable")
		}
		for _, icon := range m.Icons {
			s, _, h := htpGet(t, base+icon.Src)
			if s != 200 || h.Get("content-type") != icon.Type {
				t.Fatalf("%s is declared and answered %d %s", icon.Src, s, h.Get("content-type"))
			}
			w, hgt := pngSize(t, filepath.Join(clientDir, icon.Src))
			if fmt.Sprintf("%dx%d", w, hgt) != icon.Sizes {
				t.Fatalf("%s claims %s and is %dx%d", icon.Src, icon.Sizes, w, hgt)
			}
		}
	})
	t.Run("the apple-touch-icon the page names is served too", func(t *testing.T) {
		m := regexp.MustCompile(`<link rel="apple-touch-icon" href="([^"]+)"`).FindStringSubmatch(served(t, "/"))
		if m == nil {
			t.Fatal("no apple-touch-icon")
		}
		if s, _, h := htpGet(t, base+m[1]); s != 200 || h.Get("content-type") != "image/png" {
			t.Fatalf("%d %v", s, h)
		}
	})
	t.Run("it is not cached hard either, so a changed manifest reaches the phone", func(t *testing.T) {
		_, _, h := htpGet(t, base+"/manifest.webmanifest")
		if c := h.Get("cache-control"); strings.Contains(c, "immutable") || !weakCache.MatchString(c) {
			t.Fatal(c)
		}
	})
	t.Run("the CSP the server sends does not forbid the worker or the manifest", func(t *testing.T) {
		_, _, h := htpGet(t, base+"/")
		csp := h.Get("content-security-policy")
		if !strings.Contains(csp, "default-src 'self'") {
			t.Fatal(csp)
		}
		for _, d := range []string{"worker-src", "manifest-src", "child-src"} {
			if m := regexp.MustCompile(d + `([^;]*)`).FindStringSubmatch(csp); m != nil && !strings.Contains(m[1], "'self'") {
				t.Fatalf("%s is declared without 'self'", d)
			}
		}
	})
	t.Run("no emoji anywhere in what gets installed", func(t *testing.T) {
		for _, f := range []string{"manifest.webmanifest", "index.html", "sw.mjs"} {
			for _, r := range htpRead(t, filepath.Join(clientDir, f)) {
				if htpIsPictographic(r) {
					t.Fatalf("%s contains an emoji %U", f, r)
				}
			}
		}
	})

	t.Run("it is served from the root, as JavaScript, so its scope is the whole app", func(t *testing.T) {
		s, _, h := htpGet(t, base+"/sw.mjs")
		if s != 200 || !strings.Contains(h.Get("content-type"), "javascript") {
			t.Fatalf("%d %v", s, h)
		}
		bundle := asset(t, ".js")
		if !regexp.MustCompile("register\\(\\s*[\"`']/sw\\.mjs[\"`']").MatchString(bundle) ||
			!regexp.MustCompile("scope:\\s*[\"`']/[\"`']").MatchString(bundle) {
			t.Fatal("the bundle does not register /sw.mjs at scope /")
		}
	})
	t.Run("it is not cached hard, so a replacement can never be locked out", func(t *testing.T) {
		_, _, h := htpGet(t, base+"/sw.mjs")
		if c := h.Get("cache-control"); strings.Contains(c, "immutable") || !weakCache.MatchString(c) {
			t.Fatal(c)
		}
		if !regexp.MustCompile("updateViaCache:\\s*[\"`']none[\"`']").MatchString(asset(t, ".js")) {
			t.Fatal("no updateViaCache: none")
		}
	})
	t.Run("it cannot intercept /api or /ws, or anything else, because it answers nothing", func(t *testing.T) {
		source := regexp.MustCompile(`(?m)//.*$`).ReplaceAllString(served(t, "/sw.mjs"), "")
		for _, banned := range []string{`respondWith`, `\bcaches\b|CacheStorage|cache\.put|cache\.match`, `importScripts|\bimport\s*\(`, `new Response\b`} {
			if regexp.MustCompile(banned).MatchString(source) {
				t.Fatalf("the worker matches %s", banned)
			}
		}
		if !strings.Contains(source, "skipWaiting") || !regexp.MustCompile(`clients\.claim`).MatchString(source) {
			t.Fatal("the worker does not take over immediately")
		}
	})
	t.Run("the worker is the whole of it - no second worker is registered anywhere", func(t *testing.T) {
		if n := len(regexp.MustCompile(`serviceWorker\s*\.\s*register\s*\(`).FindAllString(asset(t, ".js"), -1)); n != 1 {
			t.Fatalf("%d registrations", n)
		}
	})
	t.Run("the shell it would have cached is still the server's to invalidate", func(t *testing.T) {
		if _, _, h := htpGet(t, base+"/"); !weakCache.MatchString(h.Get("cache-control")) {
			t.Fatal(h.Get("cache-control"))
		}
	})
	t.Run("deleting it from the build 404s, which is what evicts it from the phone", func(t *testing.T) {
		root := t.TempDir()
		htpWrite(t, filepath.Join(root, "index.html"), "<!doctype html><title>deck</title>")
		bare := htpServeClient(t, root)
		for _, p := range []string{"/sw.mjs", "/manifest.webmanifest", "/icons/icon-192.png"} {
			if s, body, _ := htpGet(t, bare.URL+p); s != 404 || strings.Contains(strings.ToLower(body), "<!doctype html>") {
				t.Fatalf("%s is absent and was answered %d", p, s)
			}
		}
		if s, _, h := htpGet(t, bare.URL+"/sessions/abc"); s != 200 || !strings.Contains(h.Get("content-type"), "text/html") {
			t.Fatalf("%d %v", s, h)
		}
	})

	t.Run("the insets are declared and used on the edges that have hardware", func(t *testing.T) {
		css := asset(t, ".css")
		for _, side := range []string{"top", "right", "bottom", "left"} {
			if !strings.Contains(css, "env(safe-area-inset-"+side) {
				t.Fatalf("no %s inset survived", side)
			}
		}
		for _, re := range []string{`--safe-top:[^;]*safe-area-inset-top`, `--safe-bottom:[^;]*safe-area-inset-bottom`, `padding:[^;]*var\(--safe-bottom\)`} {
			if !regexp.MustCompile(re).MatchString(css) {
				t.Fatalf("css lacks %s", re)
			}
		}
	})
	t.Run("the touch targets survive the build at 44px or more", func(t *testing.T) {
		css := asset(t, ".css")
		if !regexp.MustCompile(`--touch-target:\s*44px`).MatchString(css) {
			t.Fatal("no 44px touch target")
		}
		if n := len(regexp.MustCompile(`min-height:\s*var\(--touch-target\)`).FindAllString(css, -1)); n < 3 {
			t.Fatalf("only %d control claims a touch target", n)
		}
	})
}

// ---- src/serve-client.test.ts

type htpProc struct {
	port  int
	home  string
	mu    sync.Mutex
	errs  bytes.Buffer
	token string
}

func (p *htpProc) stderr() string { p.mu.Lock(); defer p.mu.Unlock(); return p.errs.String() }

type htpLockedWriter struct{ p *htpProc }

func (w htpLockedWriter) Write(b []byte) (int, error) {
	w.p.mu.Lock()
	defer w.p.mu.Unlock()
	return w.p.errs.Write(b)
}

// htpBuildCopy copies the real build somewhere this test may plant files, leaving dist/client alone.
func htpBuildCopy(t *testing.T) string {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "client")
	if out, err := exec.Command("cp", "-R", htpClientDir(t), dst).CombinedOutput(); err != nil {
		t.Fatalf("copy build: %v %s", err, out)
	}
	return dst
}

// htpSpawn builds this package and runs it as the deck would run, on a throwaway tmux socket.
func htpSpawn(t *testing.T, origin, clientDir string) *htpProc {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	bin := filepath.Join(tmp, "agentdeck")
	if out, err := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	home := filepath.Join(tmp, "home")
	work := filepath.Join(tmp, "work")
	_ = os.MkdirAll(home, 0o755)
	_ = os.MkdirAll(work, 0o755)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	socket := fmt.Sprintf("agentdeck-gotest-htp-%d-%d", os.Getpid(), time.Now().UnixNano()%1000000)
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "TERM=xterm-256color", "LC_ALL=en_US.UTF-8",
		"TMUX_SOCKET=" + socket, "AGENTDECK_PORT=" + strconv.Itoa(port), "AGENTDECK_MOUNTS=" + work,
		"AGENTDECK_CLIENT_DIR=" + clientDir, "AGENTDECK_REAP_INTERVAL_MS=0", "AGENTDECK_REPO=" + tmp,
		"AGENTDECK_AGENT_STATE_DIR=" + filepath.Join(home, "agent-state"), "AGENTDECK_UPLOAD_DIR=" + filepath.Join(home, "uploads")}
	if origin != "" {
		env = append(env, "AGENTDECK_ORIGIN="+origin)
	}
	p := &htpProc{port: port, home: home}
	cmd := exec.Command(bin)
	cmd.Env = env
	cmd.Stderr = htpLockedWriter{p}
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		// The tmux server outlives the deck (`exit-empty off`), and kill-server leaves the socket file.
		_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
		dir := os.Getenv("TMUX_TMPDIR")
		if dir == "" {
			dir = "/tmp"
		}
		_ = os.Remove(filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()), socket))
	})
	listening := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		said := false
		for scanner.Scan() {
			if !said && strings.Contains(scanner.Text(), "listening on") {
				said = true
				close(listening)
			}
		}
	}()
	select {
	case <-listening:
	case <-time.After(20 * time.Second):
		t.Fatalf("the server did not listen within 20s\n%s", p.stderr())
	}
	b, err := os.ReadFile(filepath.Join(home, ".agentdeck", "token"))
	if err != nil || strings.TrimSpace(string(b)) == "" {
		t.Fatal("the server did not write a token to steal")
	}
	p.token = strings.TrimSpace(string(b))
	return p
}

func TestHTTP_ServeClient(t *testing.T) {
	const expected = "https://deck.example.ts.net"
	clientDir := htpBuildCopy(t)
	p := htpSpawn(t, expected, clientDir)
	tokenFile := filepath.Join(p.home, ".agentdeck", "token")
	planted := fmt.Sprintf("planted-%d", os.Getpid())
	if err := os.Symlink(tokenFile, filepath.Join(clientDir, planted)); err != nil {
		t.Fatal(err)
	}
	addr := "127.0.0.1:" + strconv.Itoa(p.port)
	req := func(t *testing.T, path string, headers ...string) htpAnswer {
		return htpRaw(t, addr, "GET", path, headers...)
	}
	html := "text/html; charset=utf-8"
	built := htpRead(t, filepath.Join(htpClientDir(t), "index.html"))
	script := regexp.MustCompile(`<script[^>]+src="([^"]+)"`)

	t.Run("the root loads with no token at all", func(t *testing.T) {
		r := req(t, "/")
		if r.status != 200 || r.header.Get("content-type") != html || r.body != built || strings.Contains(r.body, p.token) ||
			regexp.MustCompile(`AGENTDECK|__INITIAL|window\.`).MatchString(r.body) {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})
	t.Run("index.html is not cached hard, so a deploy is not permanent", func(t *testing.T) {
		c := req(t, "/").header.Get("cache-control")
		if !regexp.MustCompile(`no-cache|no-store|max-age=0`).MatchString(c) || strings.Contains(c, "immutable") {
			t.Fatal(c)
		}
	})
	t.Run("the module the page names is served as JavaScript, and cached by its hash", func(t *testing.T) {
		m := script.FindStringSubmatch(req(t, "/").body)
		if m == nil {
			t.Fatal("the built page names no module to load")
		}
		src := m[1]
		if !strings.HasPrefix(src, "/") {
			src = "/" + src
		}
		r := req(t, src)
		if r.status != 200 || !strings.Contains(r.header.Get("content-type"), "javascript") || !strings.Contains(r.header.Get("cache-control"), "immutable") {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})
	t.Run("the first thing the client shows is the paste field", func(t *testing.T) {
		base := "http://" + addr
		_, page, _ := htpGet(t, base+"/")
		m := script.FindStringSubmatch(page)
		if m == nil {
			t.Fatal("no script")
		}
		ref, _ := url.Parse(base + "/")
		src, _ := url.Parse(m[1])
		_, bundle, _ := htpGet(t, ref.ResolveReference(src).String())
		if !strings.Contains(bundle, "Paste the token the server printed on first run") || !strings.Contains(bundle, "placeholder") ||
			strings.Contains(bundle, p.token) {
			t.Fatal("the bundle does not carry the token gate")
		}
	})
	t.Run("a client route that is not a file gets the page, not a 404", func(t *testing.T) {
		if r := req(t, "/session/anything"); r.status != 200 || r.header.Get("content-type") != html {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})

	escapes := []string{
		"/../../../.agentdeck/token",
		"/assets/../../../../.agentdeck/token",
		"/%2e%2e/%2e%2e/%2e%2e/.agentdeck/token",
		"/..%2f..%2f..%2f.agentdeck%2ftoken",
		"/" + url.QueryEscape(tokenFile),
		"/..\\..\\..\\.agentdeck\\token",
		"/%2e%2e%5c%2e%2e%5c.agentdeck%5ctoken",
		"/....//....//....//.agentdeck/token",
		"/" + planted,
		"/index.html%00.png",
	}
	for _, path := range escapes {
		t.Run(path+" is refused rather than served", func(t *testing.T) {
			r := req(t, path)
			if strings.TrimSpace(htpRead(t, tokenFile)) != p.token {
				t.Fatal("the token on disk changed")
			}
			if strings.Contains(r.body, p.token) || (r.status == 200 && !strings.HasPrefix(r.body, "<!doctype")) {
				t.Fatalf("%s served a file: %d", path, r.status)
			}
		})
	}
	t.Run("an escape is refused, never quietly answered with the page", func(t *testing.T) {
		if r := req(t, "/../../../.agentdeck/token"); r.status != 403 || strings.Contains(strings.ToLower(r.body), "doctype") {
			t.Fatalf("%d %q", r.status, r.body)
		}
	})

	auth := []string{"Authorization", "Bearer " + p.token}
	t.Run("a missing API route stays a JSON 404 rather than becoming the page", func(t *testing.T) {
		r := req(t, "/api/nope", auth...)
		var v map[string]any
		if r.status != 404 || !strings.Contains(r.header.Get("content-type"), "application/json") ||
			strings.Contains(strings.ToLower(r.body), "doctype") || json.Unmarshal([]byte(r.body), &v) != nil {
			t.Fatalf("%d %v %q", r.status, r.header, r.body)
		}
	})
	t.Run("an unauthenticated API call is still refused while the page is not", func(t *testing.T) {
		if r := req(t, "/"); r.status != 200 {
			t.Fatal(r.status)
		}
		if r := req(t, "/api/sessions"); r.status != 401 || !strings.Contains(r.header.Get("content-type"), "application/json") {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})
	t.Run("the Origin check on /api still holds with the page reachable", func(t *testing.T) {
		if r := req(t, "/api/sessions", append(auth, "Origin", "https://evil.example")...); r.status != 403 ||
			!strings.Contains(r.header.Get("content-type"), "application/json") {
			t.Fatalf("%d %v", r.status, r.header)
		}
		if r := req(t, "/api/sessions", append(auth, "Origin", expected)...); r.status != 200 {
			t.Fatal(r.status)
		}
	})
	t.Run("the page itself does not care about Origin - it cannot, and must not", func(t *testing.T) {
		if r := req(t, "/", "Origin", "https://evil.example"); r.status != 200 || r.header.Get("content-type") != html {
			t.Fatalf("%d %v", r.status, r.header)
		}
	})
	t.Run("/ws is the socket route's; a plain GET is not the page", func(t *testing.T) {
		if r := req(t, "/ws"); strings.Contains(strings.ToLower(r.body), "doctype") {
			t.Fatal(r.body)
		}
	})

	t.Run("no entry under src/client/public is a symlink", func(t *testing.T) {
		public := filepath.Join(htpRepo(t), "src", "client", "public")
		var offenders []string
		_ = filepath.WalkDir(public, func(path string, d os.DirEntry, err error) error {
			if err == nil && d.Type()&os.ModeSymlink != 0 {
				offenders = append(offenders, path)
			}
			return nil
		})
		if len(offenders) > 0 {
			t.Fatalf("a symlink here becomes a real file in dist/client: %v", offenders)
		}
	})
}
