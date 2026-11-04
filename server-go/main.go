package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Port of src/server.ts. Subcommands: `agentdeck` serves, `agentdeck reap` is one reaper pass,
// `agentdeck hook` is what an agent's hook runs.

const version = "0.0.0"
const healthTimeout = 3 * time.Second
const syncInterval = 2 * time.Second

var sigHUP = syscall.SIGHUP

func logf(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }
func outf(format string, a ...any) { fmt.Fprintf(os.Stdout, format+"\n", a...) }

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "reap":
			os.Exit(runReap(os.Args[2:], os.Stdout, os.Stderr))
		case "hook":
			runHook(os.Stdin)
			return
		case "version", "--version":
			fmt.Println(version)
			return
		}
	}
	if err := serve(); err != nil {
		logf("agentdeck: %v", err)
		os.Exit(1)
	}
}

func homeDir() string {
	h, _ := os.UserHomeDir()
	return h
}

func defaultTokenFile() string { return filepath.Join(homeDir(), ".agentdeck", "token") }

// wouldLandOn is where a write to p actually lands, following symlinks including a dangling leaf.
func wouldLandOn(p string, hops int) string {
	full := resolvePath(p)
	if real, err := filepath.EvalSymlinks(full); err == nil {
		return real
	}
	if info, err := os.Lstat(full); err == nil && info.Mode()&os.ModeSymlink != 0 && hops < 32 {
		if target, err := os.Readlink(full); err == nil {
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(full), target)
			}
			return wouldLandOn(target, hops+1)
		}
	}
	parts := []string{filepath.Base(full)}
	dir := filepath.Dir(full)
	for {
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
				parts[i], parts[j] = parts[j], parts[i]
			}
			return filepath.Join(append([]string{real}, parts...)...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return full
		}
		parts = append(parts, filepath.Base(dir))
		dir = parent
	}
}

// tokenInsideAllowlist is the allowed tree a file would land inside, or "".
func tokenInsideAllowlist(path string, allowed []string) string {
	target := wouldLandOn(path, 0)
	for _, a := range allowed {
		root := wouldLandOn(a, 0)
		if target == root || strings.HasPrefix(target, root+"/") {
			return a
		}
	}
	return ""
}

func loadToken(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		if t := strings.TrimSpace(string(b)); t != "" {
			return t, nil
		}
	}
	token := generateToken()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", tokenWriteError(path, err)
	}
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return "", tokenWriteError(path, err)
	}
	return token, nil
}

func tokenWriteError(path string, err error) error {
	return fmt.Errorf("could not write the bearer token to %s: %v. Set AGENTDECK_TOKEN_FILE to a path this user can write. "+
		"Not inside a directory a session is pointed at: an agent's own `ls -la` or `grep -rn token .` would put the token in a transcript.", path, err)
}

// probeTmux is liveness: a hard-timed round trip, where an empty server is healthy.
func probeTmux(ctx context.Context, socket string) bool {
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", "-L", socket, "list-sessions")
	cmd.Env = envList(baseEnv(os.LookupEnv))
	out, err := cmd.CombinedOutput()
	if err == nil {
		return true
	}
	return ctx.Err() == nil && strings.Contains(strings.ToLower(string(out)), "no sessions")
}

func pathList(name string) []string {
	var out []string
	for _, e := range strings.Split(os.Getenv(name), ":") {
		if e != "" {
			out = append(out, e)
		}
	}
	return out
}

// repoRoot is the checkout this binary belongs to: bin/agentdeck's parent, or AGENTDECK_REPO.
func repoRoot() string {
	if r := os.Getenv("AGENTDECK_REPO"); r != "" {
		return resolvePath(r)
	}
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		return filepath.Dir(filepath.Dir(exe))
	}
	wd, _ := os.Getwd()
	return wd
}

func serve() error {
	socket := getenv("TMUX_SOCKET", "agentdeck")
	port, err := strconv.Atoi(getenv("AGENTDECK_PORT", "7777"))
	if err != nil {
		return fmt.Errorf("AGENTDECK_PORT is not a number: %s", os.Getenv("AGENTDECK_PORT"))
	}
	tokenFile := getenv("AGENTDECK_TOKEN_FILE", defaultTokenFile())
	agentStateDir := getenv("AGENTDECK_AGENT_STATE_DIR", filepath.Join(homeDir(), ".agentdeck", "agent-state"))
	origin := os.Getenv("AGENTDECK_ORIGIN")
	root := repoRoot()
	clientDir := getenv("AGENTDECK_CLIENT_DIR", filepath.Join(root, "dist", "client"))
	configFile := filepath.Join(root, "tmux.conf")
	if _, err := os.Stat(configFile); err != nil {
		configFile = ""
	}

	if _, ok := os.LookupEnv("AGENTDECK_AGENT_STATE_DIR"); !ok {
		logf("agentdeck: AGENTDECK_AGENT_STATE_DIR is not set, so hook settings go to %s. An agent only reads them if it is "+
			"pointed there - for claude, CLAUDE_CONFIG_DIR in its profile's env. Until then, agents configured with "+
			"waiting.via=hook report \"detects waiting\" and never report waiting.", agentStateDir)
	}
	tailnet := readTailnet(context.Background())
	if origin == "" {
		logf("agentdeck: AGENTDECK_ORIGIN is not set, so the Origin check plan 001 describes is off. Any page a browser " +
			"visits can call /api and open /ws with a token it has. Set it to the https://<host>.ts.net origin the phone loads.")
	}
	for _, line := range tailnetAdvice(tailnet, port, origin) {
		logf("%s", line)
	}

	uploads := newUploadStore(getenv("AGENTDECK_UPLOAD_DIR", filepath.Join(homeDir(), ".agentdeck", "uploads")))
	mounts, roots := pathList("AGENTDECK_MOUNTS"), pathList("AGENTDECK_ROOTS")
	allowlist := newAllowlist(mounts, roots)
	if len(mounts) == 0 && len(roots) == 0 {
		logf("agentdeck: neither AGENTDECK_MOUNTS nor AGENTDECK_ROOTS is set, so the allowlist is empty: no session can " +
			"start and every live one is filtered off /api/sessions. Set AGENTDECK_ROOTS to a directory holding " +
			"repositories - `ghq root` is one - and clones under it become startable with no restart.")
	}

	profilesPath, hasProfiles := os.LookupEnv("AGENTDECK_PROFILES")
	published := []string{tokenFile}
	if hasProfiles {
		published = append(published, profilesPath)
	}
	for _, p := range published {
		if tokenInsideAllowlist(p, []string{clientDir}) != "" {
			return fmt.Errorf("%s is inside %s, which this server publishes UNAUTHENTICATED on every path that is not an API "+
				"route - the page has to load before a token exists. Anything under that directory is downloadable by any "+
				"device that can reach the port, at a URL equal to its filename. Move it - the default, %s, is outside it.",
				resolvePath(p), clientDir, defaultTokenFile())
		}
	}
	trees := append(append([]string{}, allowlist.Paths()...), allowlist.Roots()...)
	source := func(tree string) string {
		if contains(allowlist.Roots(), tree) {
			return "AGENTDECK_ROOTS"
		}
		return "AGENTDECK_MOUNTS"
	}
	if clash := tokenInsideAllowlist(tokenFile, trees); clash != "" {
		return fmt.Errorf("the bearer token file %s is inside %s, which sessions are started in. An agent started there "+
			"meets the token in an ordinary `ls -la` or `grep -rn token .`, and that token starts sessions in every "+
			"allowed repository, kills live ones, and attaches to every other agent's terminal. Move it - the default, "+
			"%s, is outside every allowlist entry - or take that entry off %s.", resolvePath(tokenFile), clash, defaultTokenFile(), source(clash))
	}

	profilesRaw := []byte("{}")
	if hasProfiles {
		if clash := tokenInsideAllowlist(profilesPath, trees); clash != "" {
			return fmt.Errorf("the agent profiles file %s is inside %s, which sessions are started in. That file decides what "+
				"command every session runs, as this user, so an agent started there can choose what the next session "+
				"executes. Move it outside every allowlist entry, or take that entry off %s.", resolvePath(profilesPath), clash, source(clash))
		}
		if b, err := os.ReadFile(profilesPath); err != nil {
			logf("agentdeck: could not read %s: %v", profilesPath, err)
		} else {
			profilesRaw = b
		}
	}
	profiles, rejected := parseProfiles(profilesRaw)
	for _, r := range rejected {
		logf("agentdeck: profile %s rejected: %s", r.ID, r.Reason)
	}
	for _, p := range profiles {
		if p.WaitingDisabledReason != "" {
			logf("agentdeck: %s waiting mechanism disabled: %s", p.ID, p.WaitingDisabledReason)
		}
	}
	if exe, err := os.Executable(); err == nil {
		command, err := hookCommand(port, exe)
		for _, p := range profiles {
			if p.Waiting == nil || p.Waiting.Via != "hook" {
				continue
			}
			settings := filepath.Join(agentStateDir, p.Waiting.Settings)
			if err != nil {
				logf("agentdeck: %s hook install failed for %s: %v", p.ID, settings, err)
				continue
			}
			changed, ierr := installHookSettings(settings, command)
			switch {
			case ierr != nil:
				logf("agentdeck: %s hook install failed for %s: %v", p.ID, settings, ierr)
			case changed:
				outf("agentdeck: %s hooks merged into %s", p.ID, settings)
			default:
				outf("agentdeck: %s hooks already present in %s", p.ID, settings)
			}
		}
	}

	token, err := loadToken(tokenFile)
	if err != nil {
		return err
	}

	ctx := context.Background()
	tmux := newTmux(socket, configFile)
	if err := tmux.EnsureServer(ctx); err != nil {
		logf("agentdeck: could not start the tmux server: %v", err)
	}
	registry, err := newRegistry(tmux, profiles, allowlist, token)
	if err != nil {
		return err
	}
	var ws *WSServer
	hub := newHub(tmux, registry, func(id string, state SessionState, code *int) {
		if ws != nil {
			ws.PushState(id, state, code)
		}
	})
	if reaped, err := registry.Reap(ctx); err != nil {
		logf("agentdeck: reap at boot failed, continuing: %v", err)
	} else if len(reaped) > 0 {
		outf("agentdeck: reaped %d dead session(s)", len(reaped))
	}

	syncNow := func() {
		go func() {
			if err := hub.Sync(context.Background()); err != nil {
				logf("agentdeck: sync failed: %v", err)
			}
		}()
	}
	api := newAPIHandler(HTTPDeps{
		Registry: registry, Profiles: profiles, Allowlist: allowlist, Token: token, Version: version, Origin: origin,
		Probe:            func(ctx context.Context) bool { return probeTmux(ctx, socket) },
		OnSessionsChange: syncNow,
		StreamFor:        hub.StreamFor,
		Uploads:          uploads,
		PanePids:         tmux.PanePids,
		OnStateDeclared: func(id string, state SessionState) {
			if hub.Attached(id) {
				hub.Announce(id, state, nil)
			}
		},
	})
	ws = newWSServer(WSDeps{
		Token: token, Origin: origin, StreamFor: hub.StreamFor,
		CaptureHistory: func(ctx context.Context, id string) (string, error) {
			return tmux.CaptureHistory(ctx, id, historyLines)
		},
		IsAlternate: tmux.IsAlternateScreen,
		PaneModes: func(ctx context.Context, id string) (string, error) {
			m, err := tmux.PaneModes(ctx, id)
			return modeBytes(m), err
		},
		Repaint:       hub.Repaint,
		ListSessions:  registry.List,
		SendInput:     hub.SendInput,
		ApplyPaneRows: hub.ApplyPaneRows,
		NotFound:      api,
	})

	if err := hub.Sync(ctx); err != nil {
		logf("agentdeck: initial sync failed, retrying on the next tick: %v", err)
	}
	syncTicker := time.NewTicker(syncInterval)
	go func() {
		for range syncTicker.C {
			if err := hub.Sync(context.Background()); err != nil {
				logf("agentdeck: sync failed: %v", err)
			}
		}
	}()

	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			return fmt.Errorf("port %d is already in use. Another agentdeck, or something else on this Mac. Stop it, or set AGENTDECK_PORT to a free port.", port)
		}
		return fmt.Errorf("server error: %v", err)
	}
	server := &http.Server{Handler: withClient(api, ws, clientDir), ReadHeaderTimeout: 30 * time.Second}
	outf("agentdeck: listening on 127.0.0.1:%d", port)
	outf("agentdeck: %d agent profile(s), %d startable directory(ies) from %d mount(s) and %d root(s)",
		len(profiles), len(allowlist.Paths()), len(mounts), len(roots))

	stopReaping := func() {}
	reapEvery := envMs("AGENTDECK_REAP_INTERVAL_MS", time.Hour)
	if v := os.Getenv("AGENTDECK_REAP_INTERVAL_MS"); v == "0" {
		reapEvery = 0
	}
	if reapEvery > 0 && len(roots)+len(mounts) > 0 {
		stopReaping = startReaping(reapEvery, runReaperProcess, func(line string) { outf("%s", line) })
		every := fmt.Sprintf("%d minute(s)", int((reapEvery+30*time.Second)/time.Minute))
		if reapEvery < time.Minute {
			every = fmt.Sprintf("%d second(s)", int((reapEvery+500*time.Millisecond)/time.Second))
		}
		outf("agentdeck: collecting abandoned processes under the roots every %s. AGENTDECK_REAP_INTERVAL_MS=0 turns it off; `make reap` shows what it would take without taking it.", every)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		syncTicker.Stop()
		stopReaping()
		ws.Close()
		hub.DisposeAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
