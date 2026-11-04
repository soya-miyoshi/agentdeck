package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Port of src/session-id.ts, src/agent-profiles.ts, src/cwds.ts, src/repo-scan.ts and
// src/registry.ts. The registry keeps no list of its own: tmux is the authority.

var nonName = regexp.MustCompile(`[^A-Za-z0-9_-]+`)
var edgeDashes = regexp.MustCompile(`^-+|-+$`)

func sanitise(v string) string {
	f := edgeDashes.ReplaceAllString(nonName.ReplaceAllString(v, "-"), "")
	if f == "" {
		return "repo"
	}
	return f
}

// sessionID is `<basename>-<agent>-<8 hex of sha256(path)>`, identical to the TS server's.
func sessionID(absCwd, agent string) string {
	sum := sha256.Sum256([]byte(absCwd))
	return sanitise(nodeBasename(absCwd)) + "-" + sanitise(agent) + "-" + hex.EncodeToString(sum[:])[:8]
}

// nodeBasename matches Node's path.basename: trailing slashes ignored, "/" gives "".
func nodeBasename(p string) string {
	p = strings.TrimRight(p, "/")
	if p == "" {
		return ""
	}
	return p[strings.LastIndex(p, "/")+1:]
}

func sessionName(absCwd string) string { return nodeBasename(absCwd) }

// resolvePath matches Node's path.resolve: absolute, cleaned, "" meaning the working directory.
func resolvePath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return abs
}

// ---- agent profiles

type WaitingMechanism struct {
	Via      string `json:"via"`
	Settings string `json:"settings,omitempty"`
	Path     string `json:"path,omitempty"`
	Match    string `json:"match,omitempty"`
}

type AgentProfile struct {
	ID                    string
	Name                  string
	Command               string
	Args                  []string
	Env                   []string
	Waiting               *WaitingMechanism
	WaitingDisabledReason string
}

type AgentSummary struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Available      bool   `json:"available"`
	DetectsWaiting bool   `json:"detectsWaiting"`
}

type Rejected struct{ ID, Reason string }

func parseWaiting(raw json.RawMessage) (*WaitingMechanism, string) {
	if raw == nil {
		return nil, ""
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return nil, "waiting is not an object"
	}
	str := func(k string) (string, bool) { s, ok := obj[k].(string); return s, ok }
	switch obj["via"] {
	case "hook":
		s, ok := str("settings")
		if !ok {
			return nil, "waiting.via=hook needs a settings path"
		}
		if filepath.IsAbs(s) || contains(strings.Split(s, "/"), "..") {
			return nil, "waiting.settings must be relative to the agent-state directory and stay inside it, not " + s
		}
		return &WaitingMechanism{Via: "hook", Settings: s}, ""
	case "log":
		s, ok := str("path")
		if !ok {
			return nil, "waiting.via=log needs a path"
		}
		return &WaitingMechanism{Via: "log", Path: s}, ""
	case "screen":
		s, ok := str("match")
		if !ok {
			return nil, "waiting.via=screen needs a match"
		}
		if _, err := regexp.Compile(s); err != nil {
			return nil, "waiting.via=screen match is not a valid regex"
		}
		return &WaitingMechanism{Via: "screen", Match: s}, ""
	}
	return nil, fmt.Sprintf("unknown waiting.via: %v", obj["via"])
}

// parseProfiles reads the profiles file; a bad profile is rejected alone, never the file.
func parseProfiles(data []byte) (map[string]*AgentProfile, []Rejected) {
	profiles := map[string]*AgentProfile{}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return profiles, []Rejected{{"<file>", "not an object"}}
	}
	var rejected []Rejected
	ids := make([]string, 0, len(raw))
	for id := range raw {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		var v map[string]json.RawMessage
		if json.Unmarshal(raw[id], &v) != nil || v == nil {
			rejected = append(rejected, Rejected{id, "profile is not an object"})
			continue
		}
		var command string
		if json.Unmarshal(v["command"], &command) != nil || command == "" {
			rejected = append(rejected, Rejected{id, "profile has no command"})
			continue
		}
		args := []string{}
		if v["args"] != nil && json.Unmarshal(v["args"], &args) != nil {
			rejected = append(rejected, Rejected{id, "args must be an array of strings"})
			continue
		}
		env := []string{}
		if v["env"] != nil && json.Unmarshal(v["env"], &env) != nil {
			rejected = append(rejected, Rejected{id, "env must be an array of variable NAMES"})
			continue
		}
		var name string
		_ = json.Unmarshal(v["name"], &name)
		if name == "" {
			name = id
		}
		waiting, reason := parseWaiting(v["waiting"])
		profiles[id] = &AgentProfile{ID: id, Name: name, Command: command, Args: args, Env: env, Waiting: waiting, WaitingDisabledReason: reason}
	}
	return profiles, rejected
}

func resolvesOnPath(command string, lookup func(string) (string, bool)) bool {
	executable := func(p string) bool {
		info, err := os.Stat(p)
		return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
	}
	if strings.Contains(command, "/") {
		return filepath.IsAbs(command) && executable(command)
	}
	path, ok := lookup("PATH")
	if !ok {
		return false
	}
	for _, dir := range filepath.SplitList(path) {
		if dir != "" && executable(filepath.Join(dir, command)) {
			return true
		}
	}
	return false
}

func summarise(p *AgentProfile) AgentSummary {
	return AgentSummary{ID: p.ID, Name: p.Name, Available: resolvesOnPath(p.Command, os.LookupEnv), DetectsWaiting: p.Waiting != nil}
}

// spawnEnv passes through the profile's variables by name, plus what the server adds.
func spawnEnv(p *AgentProfile, extra map[string]string, lookup func(string) (string, bool)) map[string]string {
	out := map[string]string{}
	for _, name := range p.Env {
		if v, ok := lookup(name); ok {
			out[name] = v
		}
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// ---- allowlist

type Cwd struct {
	Path     string   `json:"path"`
	Name     string   `json:"name"`
	Sessions []string `json:"sessions"`
}

const scanTTL = time.Second
const scanMaxDepth = 4

type Allowlist struct {
	mounts    []string
	roots     []string
	scan      func([]string) []string
	ttl       time.Duration
	mu        sync.Mutex
	scanned   []string
	scannedAt time.Time
}

func newAllowlist(mounts, roots []string) *Allowlist {
	a := &Allowlist{scan: func(r []string) []string { return scanRepos(r, scanMaxDepth) }, ttl: scanTTL}
	for _, m := range mounts {
		a.mounts = append(a.mounts, resolvePath(m))
	}
	for _, r := range roots {
		a.roots = append(a.roots, resolvePath(r))
	}
	return a
}

func (a *Allowlist) Roots() []string { return a.roots }

// Paths is the mounts plus whatever the roots hold now, rescanned at most once a second.
func (a *Allowlist) Paths() []string {
	if len(a.roots) == 0 {
		return a.mounts
	}
	a.mu.Lock()
	if time.Since(a.scannedAt) >= a.ttl {
		a.scanned = a.scan(a.roots)
		a.scannedAt = time.Now()
	}
	scanned := a.scanned
	a.mu.Unlock()
	seen := map[string]bool{}
	var out []string
	for _, p := range append(append([]string{}, a.mounts...), scanned...) {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// Allows is exact membership; "" (unknown location) is never allowed.
func (a *Allowlist) Allows(cwd string) bool {
	if cwd == "" {
		return false
	}
	return contains(a.Paths(), resolvePath(cwd))
}

func (a *Allowlist) Refusal(cwd string) string {
	free := ""
	if len(a.roots) > 0 {
		free = "Clone it under one of " + strings.Join(a.roots, ", ") + " and it is startable at the next tap of New session, with no restart. Otherwise: "
	}
	return resolvePath(cwd) + " is not on the allowlist, so no session can start there. " + free +
		"Add it to AGENTDECK_MOUNTS and restart agentdeck - tmux keeps the running agents across that restart, " +
		"and they are listed, streamed and still able to report waiting afterwards, because the hook secret is " +
		"derived rather than minted. Currently allowed: " + strings.Join(a.Paths(), ", ")
}

// List qualifies a shared basename with its parent so two `dotfiles` are not identical rows.
func (a *Allowlist) List(byCwd map[string][]string) []Cwd {
	paths := a.Paths()
	seen := map[string]int{}
	for _, p := range paths {
		seen[filepath.Base(p)]++
	}
	out := []Cwd{}
	for _, p := range paths {
		name := filepath.Base(p)
		if seen[name] > 1 {
			name = filepath.Join(filepath.Base(filepath.Dir(p)), name)
		}
		sessions := append([]string{}, byCwd[p]...)
		out = append(out, Cwd{Path: p, Name: name, Sessions: sessions})
	}
	return out
}

// scanRepos finds repositories under roots, never descending into one, skipping dot dirs and links.
func scanRepos(roots []string, maxDepth int) []string {
	found := map[string]bool{}
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() || e.Type()&os.ModeSymlink != 0 || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			child := filepath.Join(dir, e.Name())
			if _, err := os.Stat(filepath.Join(child, ".git")); err == nil {
				found[child] = true
			} else if depth < maxDepth {
				walk(child, depth+1)
			}
		}
	}
	for _, r := range roots {
		walk(resolvePath(r), 1)
	}
	out := make([]string, 0, len(found))
	for p := range found {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// ---- registry

type Session struct {
	ID                   string       `json:"id"`
	Name                 string       `json:"name"`
	Cwd                  string       `json:"cwd"`
	Agent                string       `json:"agent"`
	State                SessionState `json:"state"`
	StartedAt            int64        `json:"startedAt"`
	ExitCode             *int         `json:"exitCode,omitempty"`
	WaitingDetectionLost bool         `json:"waitingDetectionLost,omitempty"`
}

type CreateResult struct {
	Session Session `json:"session"`
	Warning string  `json:"warning,omitempty"`
}

type CwdNotAllowedError struct{ msg string }

func (e *CwdNotAllowedError) Error() string { return e.msg }

type UnknownAgentError struct{ msg string }

func (e *UnknownAgentError) Error() string { return e.msg }

// secretFor derives a session's hook secret, so a restarted server recomputes what the agent holds.
func secretFor(key, id string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(id))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

type sessionMeta struct {
	cwd, agent, secret string
	startedHere        bool
}

type Registry struct {
	tmux      *Tmux
	profiles  map[string]*AgentProfile
	allowlist *Allowlist
	secretKey string

	mu     sync.Mutex
	meta   map[string]*sessionMeta
	states map[string]SessionState
	deaf   map[string]bool
	// declared is what a hook last said, kept for a stream that attaches after the hook arrived.
	declared map[string]SessionState
}

func newRegistry(tmux *Tmux, profiles map[string]*AgentProfile, allowlist *Allowlist, secretKey string) (*Registry, error) {
	if secretKey == "" {
		return nil, errors.New("Registry needs a non-empty secret key; it derives every hook secret from it")
	}
	return &Registry{tmux: tmux, profiles: profiles, allowlist: allowlist, secretKey: secretKey,
		meta: map[string]*sessionMeta{}, states: map[string]SessionState{}, deaf: map[string]bool{}, declared: map[string]SessionState{}}, nil
}

func (r *Registry) forget(id string) {
	r.mu.Lock()
	delete(r.meta, id)
	delete(r.states, id)
	delete(r.deaf, id)
	delete(r.declared, id)
	r.mu.Unlock()
}

func (r *Registry) Create(ctx context.Context, rawCwd, agentID string) (*CreateResult, error) {
	cwd := resolvePath(rawCwd)
	if !r.allowlist.Allows(cwd) {
		return nil, &CwdNotAllowedError{r.allowlist.Refusal(cwd)}
	}
	profile, ok := r.profiles[agentID]
	if !ok {
		return nil, &UnknownAgentError{"no agent profile named " + agentID}
	}
	id := sessionID(cwd, agentID)

	// A dead pane under our id at this cwd is cleared, or the 201 would claim a running agent.
	existing, err := r.tmux.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, e := range existing {
		if e.ID == id && e.Dead && e.Path == cwd {
			if err := r.tmux.Kill(ctx, id); err != nil {
				return nil, err
			}
			r.forget(id)
		}
	}

	secret := secretFor(r.secretKey, id)
	startedAfter := time.Now().Unix() * 1000
	attached, err := r.tmux.CreateOrAttach(ctx, id, cwd, profile.Command, profile.Args,
		spawnEnv(profile, map[string]string{"AGENTDECK_SESSION_ID": id, "AGENTDECK_SECRET": secret}, os.LookupEnv))
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.meta[id] = &sessionMeta{cwd: cwd, agent: agentID, secret: secret, startedHere: !attached}
	if !attached {
		r.states[id] = StateIdle
	}
	r.mu.Unlock()

	list, err := r.List(ctx)
	if err != nil {
		if !attached {
			r.undoCreate(ctx, id, cwd, startedAfter)
		}
		return nil, err
	}
	for _, s := range list {
		if s.ID == id {
			res := &CreateResult{Session: s}
			if attached {
				res.Warning = fmt.Sprintf("A %s session was already running in %s; you are attached to it rather than to a new one.", agentID, cwd)
			}
			return res, nil
		}
	}
	if !attached {
		r.undoCreate(ctx, id, cwd, startedAfter)
	}
	return nil, fmt.Errorf("session %s was created but tmux does not list it", id)
}

// undoCreate kills only a session tmux confirms this call started.
func (r *Registry) undoCreate(ctx context.Context, id, cwd string, startedAfter int64) {
	path, startedAt, ok := r.tmux.Describe(ctx, id)
	r.forget(id)
	if !ok || path != cwd || startedAt < startedAfter {
		return
	}
	_ = r.tmux.Kill(ctx, id)
}

// List is what tmux holds, filtered to allowed paths whose name matches (path, a configured agent).
func (r *Registry) List(ctx context.Context) ([]Session, error) {
	live, err := r.tmux.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []Session{}
	for _, e := range live {
		r.mu.Lock()
		meta := r.meta[e.ID]
		r.mu.Unlock()
		if meta == nil {
			meta = r.adopt(e.ID, e.Path)
		}
		if meta == nil || !r.allowlist.Allows(e.Path) || e.Path != meta.cwd {
			continue
		}
		r.mu.Lock()
		state, ok := r.states[e.ID]
		deaf := r.deaf[e.ID]
		r.mu.Unlock()
		if !ok {
			state = StateIdle
		}
		if e.Dead {
			state = StateExited
		}
		out = append(out, Session{ID: e.ID, Name: sessionName(e.Path), Cwd: e.Path, Agent: meta.agent,
			State: state, StartedAt: e.StartedAt, ExitCode: e.ExitCode, WaitingDetectionLost: deaf})
	}
	return out, nil
}

// adopt recovers a session that outlived its creator: the agent is whichever profile reproduces the id.
func (r *Registry) adopt(id, path string) *sessionMeta {
	if path == "" || !r.allowlist.Allows(path) {
		return nil
	}
	agents := make([]string, 0, len(r.profiles))
	for a := range r.profiles {
		agents = append(agents, a)
	}
	sort.Strings(agents)
	for _, agent := range agents {
		if sessionID(path, agent) != id {
			continue
		}
		meta := &sessionMeta{cwd: path, agent: agent, secret: secretFor(r.secretKey, id)}
		r.mu.Lock()
		r.meta[id] = meta
		r.mu.Unlock()
		logf("agentdeck: adopted session %s at %s - this process has no record of creating it. Its hook secret is derived, so waiting detection comes back with it.", id, path)
		return meta
	}
	return nil
}

// Close kills one of our sessions and nothing else; the id is a raw path segment.
func (r *Registry) Close(ctx context.Context, id string) error {
	list, err := r.List(ctx)
	if err != nil {
		return err
	}
	ours := false
	for _, s := range list {
		if s.ID == id {
			ours = true
		}
	}
	if !ours {
		return nil
	}
	if err := r.tmux.Kill(ctx, id); err != nil {
		return err
	}
	r.forget(id)
	return nil
}

// Reap closes corpses this process started; adopted ones keep their `exited N`.
func (r *Registry) Reap(ctx context.Context) ([]string, error) {
	list, err := r.List(ctx)
	if err != nil {
		return nil, err
	}
	var reaped []string
	for _, s := range list {
		r.mu.Lock()
		m := r.meta[s.ID]
		r.mu.Unlock()
		if s.State == StateExited && m != nil && m.startedHere {
			if err := r.Close(ctx, s.ID); err != nil {
				return reaped, err
			}
			reaped = append(reaped, s.ID)
		}
	}
	return reaped, nil
}

func (r *Registry) SetState(id string, state SessionState) {
	r.mu.Lock()
	r.states[id] = state
	r.mu.Unlock()
}

// Declare records a hook's state, which outranks cadence even for a stream not yet attached.
func (r *Registry) Declare(id string, state SessionState) {
	r.mu.Lock()
	r.states[id] = state
	r.declared[id] = state
	r.mu.Unlock()
}

func (r *Registry) Declared(id string) (SessionState, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st, ok := r.declared[id]
	return st, ok
}

// SecretMatches checks a hook call in constant time; a mismatch marks the session deaf (muted).
func (r *Registry) SecretMatches(id, presented string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.meta[id]
	if m == nil {
		return false
	}
	ok := subtle.ConstantTimeCompare([]byte(m.secret), []byte(presented)) == 1
	if !ok {
		r.deaf[id] = true
	}
	return ok
}

func (r *Registry) SessionsByCwd(ctx context.Context) (map[string][]string, error) {
	list, err := r.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, s := range list {
		if s.Cwd != "" {
			out[s.Cwd] = append(out[s.Cwd], s.ID)
		}
	}
	return out, nil
}
