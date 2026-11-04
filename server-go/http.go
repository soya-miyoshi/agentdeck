package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Port of src/token.ts, src/http.ts and src/static.ts. Every API route but health and hooks needs
// the bearer token; the built client is the one unauthenticated surface.

const maxBodyBytes = 64 * 1024
const uploadMaxBodyBytes = 8 * 1024 * 1024
const hooksPerSecond = 10.0
const hookBurst = 20.0

func generateToken() string {
	var raw [32]byte
	_, _ = rand.Read(raw[:])
	return base64.RawURLEncoding.EncodeToString(raw[:])
}

var rfc7230Token = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+\\-.^_`|~]+$")

func isWireSafe(token string) bool { return rfc7230Token.MatchString(token) }

func tokenMatches(presented, expected string) bool {
	if len(presented) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) == 1
}

var bearerRe = regexp.MustCompile(`^Bearer (\S+)$`)

func bearerFrom(header string) string {
	if m := bearerRe.FindStringSubmatch(header); m != nil {
		return m[1]
	}
	return ""
}

type HTTPDeps struct {
	Registry         *Registry
	Profiles         map[string]*AgentProfile
	Allowlist        *Allowlist
	Token            string
	Version          string
	Origin           string
	Probe            func(ctx context.Context) bool
	OnSessionsChange func()
	StreamFor        func(id string) *Stream
	OnStateDeclared  func(id string, state SessionState)
	Uploads          *UploadStore
	PanePids         func(ctx context.Context) ([]PaneRef, error)
	ReadProcesses    func(ctx context.Context) []ProcessRow
}

type apiHandler struct {
	d         HTTPDeps
	mu        sync.Mutex
	hookTicks map[string]bucket
}

type bucket struct {
	tokens float64
	at     time.Time
}

func newAPIHandler(d HTTPDeps) *apiHandler {
	if d.ReadProcesses == nil {
		d.ReadProcesses = readProcessTable
	}
	return &apiHandler{d: d, hookTicks: map[string]bucket{}}
}

func (h *apiHandler) hookAllowed(id string, now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, ok := h.hookTicks[id]
	if !ok {
		b = bucket{hookBurst, now}
	}
	refilled := b.tokens + now.Sub(b.at).Seconds()*hooksPerSecond
	if refilled > hookBurst {
		refilled = hookBurst
	}
	if refilled < 1 {
		h.hookTicks[id] = bucket{refilled, now}
		return false
	}
	h.hookTicks[id] = bucket{refilled - 1, now}
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	payload, _ := json.Marshal(body)
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("x-content-type-options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

var hookPath = regexp.MustCompile(`^/api/hooks/([^/]+)$`)
var uploadPath = regexp.MustCompile(`^/api/sessions/([^/]+)/uploads$`)
var sessionPath = regexp.MustCompile(`^/api/sessions/([^/]+)$`)

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			h.fail(w, rec)
		}
	}()
	status, body, err := h.handle(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, status, body)
}

// fail answers a fixed sentence and a reference, never the error text, which can quote argv.
func (h *apiHandler) fail(w http.ResponseWriter, err any) {
	var raw [6]byte
	_, _ = rand.Read(raw[:])
	id := hex.EncodeToString(raw[:])
	logf("agentdeck: unhandled request error %s: %v", id, err)
	payload, _ := json.Marshal(ErrorResponse{"the server failed to handle that request (ref " + id + "); see the server log"})
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(500)
	_, _ = w.Write(payload)
}

func decodeSegment(s string) string {
	if v, err := url.PathUnescape(s); err == nil {
		return v
	}
	return s
}

func (h *apiHandler) handle(r *http.Request) (int, any, error) {
	ctx := r.Context()
	method, path := r.Method, r.URL.Path
	d := h.d

	if method == "GET" && path == "/api/health" {
		ok := d.Probe(ctx)
		status := 200
		if !ok {
			status = 503
		}
		return status, HealthResponse{OK: ok, Version: d.Version}, nil
	}

	if m := hookPath.FindStringSubmatch(path); method == "POST" && m != nil {
		id := decodeSegment(m[1])
		secret := r.Header.Get("x-agentdeck-secret")
		if _, present := r.Header["X-Agentdeck-Secret"]; !present || !d.Registry.SecretMatches(id, secret) {
			return 401, ErrorResponse{"bad session secret"}, nil
		}
		if !h.hookAllowed(id, time.Now()) {
			return 429, ErrorResponse{"too many hook posts for this session"}, nil
		}
		raw, err := readBody(r.Body, hookMaxBodyBytes)
		var payload any
		if err == nil && len(raw) > 0 {
			err = json.Unmarshal(raw, &payload)
		}
		if err != nil {
			return 400, ErrorResponse{"hook payload was not JSON"}, nil
		}
		state, reason := mapHookEvent(payload)
		if state == "" {
			logf("agentdeck: hook for %s changed no state: %s", id, reason)
			return 200, HookResponse{OK: true}, nil
		}
		if d.StreamFor != nil {
			if s := d.StreamFor(id); s != nil {
				s.Declare(state, nil)
			}
		}
		d.Registry.Declare(id, state)
		if d.OnStateDeclared != nil {
			d.OnStateDeclared(id, state)
		}
		return 200, HookResponse{OK: true, State: &state}, nil
	}

	presented := bearerFrom(r.Header.Get("authorization"))
	if presented == "" || !tokenMatches(presented, d.Token) {
		return 401, ErrorResponse{"missing or invalid bearer token"}, nil
	}
	if origin := r.Header.Get("origin"); d.Origin != "" && origin != "" && origin != d.Origin {
		return 403, ErrorResponse{"origin not allowed"}, nil
	}

	if method == "POST" && path == "/api/probe" {
		return 200, ProbeResponse{OK: true}, nil
	}
	if method == "GET" && path == "/api/sessions" {
		list, err := d.Registry.List(ctx)
		if err != nil {
			return 0, nil, err
		}
		return 200, SessionsResponse{Sessions: list}, nil
	}
	if method == "POST" && path == "/api/sessions" {
		raw, err := readBody(r.Body, maxBodyBytes)
		if errors.Is(err, errBodyTooLarge) {
			return 413, ErrorResponse{err.Error()}, nil
		}
		var record map[string]any
		if err != nil || len(raw) == 0 || json.Unmarshal(raw, &record) != nil || record == nil {
			return 400, ErrorResponse{"expected a JSON object"}, nil
		}
		cwd, _ := record["cwd"].(string)
		agent, _ := record["agent"].(string)
		if cwd == "" || agent == "" {
			return 400, ErrorResponse{"cwd and agent are both required"}, nil
		}
		created, err := d.Registry.Create(ctx, cwd, agent)
		var notAllowed *CwdNotAllowedError
		var unknown *UnknownAgentError
		switch {
		case errors.As(err, &notAllowed):
			return 403, ErrorResponse{err.Error()}, nil
		case errors.As(err, &unknown):
			return 404, ErrorResponse{err.Error()}, nil
		case err != nil:
			return 0, nil, err
		}
		if d.OnSessionsChange != nil {
			d.OnSessionsChange()
		}
		return 201, created, nil
	}
	if m := uploadPath.FindStringSubmatch(path); method == "POST" && m != nil {
		if d.Uploads == nil {
			return 501, ErrorResponse{"this deck has no upload directory configured"}, nil
		}
		id := decodeSegment(m[1])
		list, err := d.Registry.List(ctx)
		if err != nil {
			return 0, nil, err
		}
		ours := false
		for _, s := range list {
			ours = ours || s.ID == id
		}
		if !ours {
			return 404, ErrorResponse{"no session " + id}, nil
		}
		data, err := readBody(r.Body, uploadMaxBodyBytes)
		if errors.Is(err, errBodyTooLarge) {
			return 413, ErrorResponse{"that image is too large; send under 8MB"}, nil
		}
		if err != nil {
			return 0, nil, err
		}
		if len(data) == 0 {
			return 400, ErrorResponse{"the image body was empty"}, nil
		}
		saved, err := d.Uploads.Save(id, r.Header.Get("content-type"), data)
		var unsupported *UnsupportedImageError
		if errors.As(err, &unsupported) {
			return 415, ErrorResponse{err.Error()}, nil
		}
		if err != nil {
			return 0, nil, err
		}
		return 201, UploadResponse{Path: saved}, nil
	}
	if m := sessionPath.FindStringSubmatch(path); method == "DELETE" && m != nil {
		if err := d.Registry.Close(ctx, decodeSegment(m[1])); err != nil {
			return 0, nil, err
		}
		if d.OnSessionsChange != nil {
			d.OnSessionsChange()
		}
		return 200, ClosedResponse{Closed: true}, nil
	}
	if method == "GET" && path == "/api/agents" {
		ids := make([]string, 0, len(d.Profiles))
		for id := range d.Profiles {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		agents := []AgentSummary{}
		for _, id := range ids {
			agents = append(agents, summarise(d.Profiles[id]))
		}
		return 200, AgentsResponse{Agents: agents}, nil
	}
	if method == "GET" && path == "/api/processes" {
		if d.PanePids == nil {
			return 200, ProcessesResponse{Sessions: []SessionProcesses{}}, nil
		}
		panes, err := d.PanePids(ctx)
		if err != nil {
			return 0, nil, err
		}
		var rows []ProcessRow
		if len(panes) > 0 {
			rows = d.ReadProcesses(ctx)
		}
		return 200, ProcessesResponse{Sessions: sessionProcesses(panes, rows)}, nil
	}
	if method == "GET" && path == "/api/cwds" {
		byCwd, err := d.Registry.SessionsByCwd(ctx)
		if err != nil {
			return 0, nil, err
		}
		return 200, CwdsResponse{Cwds: d.Allowlist.List(byCwd)}, nil
	}
	return 404, ErrorResponse{"no route for " + method + " " + path}, nil
}

// ---- static client

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8", ".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
	".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
}

var safetyHeaders = map[string]string{
	"x-content-type-options": "nosniff",
	"x-frame-options":        "DENY",
	"content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; font-src 'self' data:; base-uri 'none'; object-src 'none'; " +
		"form-action 'none'; frame-ancestors 'none'",
}

func contentTypeFor(p string) string {
	if t, ok := contentTypes[strings.ToLower(filepath.Ext(p))]; ok {
		return t
	}
	return "application/octet-stream"
}

func isAPIPath(p string) bool { return p == "/api" || strings.HasPrefix(p, "/api/") || p == "/ws" }

func sendText(w http.ResponseWriter, r *http.Request, status int, headers map[string]string, body string) {
	h := w.Header()
	h.Set("content-type", "text/plain; charset=utf-8")
	for k, v := range safetyHeaders {
		h.Set(k, v)
	}
	for k, v := range headers {
		h.Set(k, v)
	}
	w.WriteHeader(status)
	if r.Method != "HEAD" {
		_, _ = w.Write([]byte(body))
	}
}

func within(root, candidate string) bool {
	if candidate == root {
		return true
	}
	if !strings.HasSuffix(root, "/") {
		root += "/"
	}
	return strings.HasPrefix(candidate, root)
}

// locate resolves a URL path to a real file inside root: "outside" refuses, "missing" falls back.
func locate(root, urlPath string) (file, reason string) {
	var segments []string
	for _, raw := range strings.Split(urlPath, "/") {
		if raw == "" || raw == "." {
			continue
		}
		piece, err := url.PathUnescape(raw)
		if err != nil || strings.ContainsAny(piece, "\x00/\\") {
			return "", "outside"
		}
		segments = append(segments, piece)
	}
	lexical := filepath.Join(append([]string{root}, segments...)...)
	if !within(root, lexical) {
		return "", "outside"
	}
	real, err := filepath.EvalSymlinks(lexical)
	if err != nil {
		return "", "missing"
	}
	if !within(root, real) {
		return "", "outside"
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", "missing"
	}
	if info.IsDir() {
		return "", "missing"
	}
	if !info.Mode().IsRegular() {
		return "", "outside"
	}
	return real, ""
}

func namesAFile(urlPath string) bool {
	if strings.HasPrefix(urlPath, "/assets/") {
		return true
	}
	parts := strings.Split(urlPath, "/")
	_, ok := contentTypes[strings.ToLower(filepath.Ext(parts[len(parts)-1]))]
	return ok
}

func staticHandler(rootDir string) http.HandlerFunc {
	configured := resolvePath(rootDir)
	notBuilt := "agentdeck: the client is not built, so there is no page to serve. Run `pnpm build`, which writes " + configured + "."
	if _, err := os.Stat(configured); err != nil {
		logf("%s", notBuilt)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			sendText(w, r, 405, map[string]string{"allow": "GET, HEAD"}, "method not allowed\n")
			return
		}
		root, err := filepath.EvalSymlinks(configured)
		if err != nil {
			logf("%s", notBuilt)
			sendText(w, r, 503, map[string]string{"cache-control": "no-store"}, "the client is not built - run `pnpm build`; see the server log\n")
			return
		}
		rawPath := r.URL.EscapedPath()
		file, reason := locate(root, rawPath)
		if reason == "outside" {
			sendText(w, r, 403, map[string]string{"cache-control": "no-store"}, "forbidden\n")
			return
		}
		cache := "no-cache"
		target := file
		if file != "" {
			if strings.HasPrefix(rawPath, "/assets/") {
				cache = "public, max-age=31536000, immutable"
			}
		} else if !namesAFile(rawPath) {
			target, _ = locate(root, "/index.html")
		}
		if target == "" {
			sendText(w, r, 404, map[string]string{"cache-control": "no-store"}, "not found\n")
			return
		}
		data, err := os.ReadFile(target)
		if errors.Is(err, os.ErrNotExist) {
			// Gone between locate and read: `pnpm build` rewrites files under a running server.
			sendText(w, r, 404, map[string]string{"cache-control": "no-store"}, "not found\n")
			return
		}
		if err != nil {
			logf("agentdeck: could not read %s: %v", target, err)
			sendText(w, r, 500, map[string]string{"cache-control": "no-store"}, "internal error\n")
			return
		}
		h := w.Header()
		h.Set("content-type", contentTypeFor(target))
		h.Set("cache-control", cache)
		for k, v := range safetyHeaders {
			h.Set(k, v)
		}
		w.WriteHeader(200)
		if r.Method != "HEAD" {
			_, _ = w.Write(data)
		}
	}
}

// withClient routes API and socket paths to api, everything else to the built client.
func withClient(api, ws http.Handler, clientDir string) http.Handler {
	client := staticHandler(clientDir)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Any path upgrades, as the TS server's did; a plain GET of /ws is the API's 404.
		if strings.EqualFold(r.Header.Get("upgrade"), "websocket") || r.URL.Path == "/ws" {
			ws.ServeHTTP(w, r)
			return
		}
		if isAPIPath(r.URL.Path) {
			api.ServeHTTP(w, r)
			return
		}
		client(w, r)
	})
}
