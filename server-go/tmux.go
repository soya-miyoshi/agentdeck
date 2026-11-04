package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Port of src/tmux.ts: every call names agentdeck's socket and config, runs with a built
// environment, and parses `-F` output split on U+001F (or tmux 3.5a's escaped form of it).

var baseEnvNames = []string{"PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME"}

// baseEnv is the only environment a tmux server we start carries; TERM and a UTF-8 LC_CTYPE are defaulted.
func baseEnv(lookup func(string) (string, bool)) map[string]string {
	out := map[string]string{}
	for _, name := range baseEnvNames {
		if v, ok := lookup(name); ok {
			out[name] = v
		}
	}
	if _, ok := out["TERM"]; !ok {
		out["TERM"] = "xterm-256color"
	}
	winner := ""
	for _, name := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		if _, ok := out[name]; ok {
			winner = name
			break
		}
	}
	if winner == "" || !utf8Locale.MatchString(out[winner]) {
		delete(out, "LC_ALL")
		out["LC_CTYPE"] = "UTF-8"
	}
	return out
}

var utf8Locale = regexp.MustCompile(`(?i)utf-?8`)

func envList(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

func exactTarget(id string) string       { return "=" + id }
func exactWindowTarget(id string) string { return "=" + id + ":" }

const sep = "\x1f"
const sepEscaped = `\037`

func hasFields(line string) bool {
	return strings.Contains(line, sep) || strings.Contains(line, sepEscaped)
}

func splitFields(line string) []string {
	if strings.Contains(line, sep) {
		return strings.Split(line, sep)
	}
	return strings.Split(line, sepEscaped)
}

var trailingSpaces = regexp.MustCompile(` +((?:\x1b\[[0-9;]*m)*)$`)

// forTerminal turns capture-pane's LF-separated lines into CRLF, trimming trailing padding.
func forTerminal(captured string) string {
	lines := strings.Split(captured, "\n")
	for i, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		lines[i] = trailingSpaces.ReplaceAllString(line, "$1")
	}
	return strings.Join(lines, "\r\n")
}

// TmuxError carries stderr so callers can classify "no server" and "no session".
type TmuxError struct {
	Args   []string
	Stderr string
	Err    error
}

func (e *TmuxError) Error() string { return fmt.Sprintf("tmux failed: %v: %s", e.Err, e.Stderr) }

var emptyTmux = regexp.MustCompile(`(?i)no server running|no sessions|no current target|error connecting to`)
var missingSession = regexp.MustCompile(`(?i)can't find session|session not found`)

func isEmptyTmux(err error) bool { return err != nil && emptyTmux.MatchString(err.Error()) }
func isMissingSession(err error) bool {
	return err != nil && missingSession.MatchString(err.Error())
}

type TmuxSession struct {
	ID        string
	Dead      bool
	ExitCode  *int
	StartedAt int64 // ms
	Path      string
}

// Execer runs tmux with extra environment; swapped in tests.
type Execer func(ctx context.Context, args []string, extra map[string]string) (string, error)

type Tmux struct {
	Socket     string
	ConfigFile string
	exec       Execer
}

func newTmux(socket, configFile string) *Tmux {
	t := &Tmux{Socket: socket, ConfigFile: configFile}
	t.exec = func(ctx context.Context, args []string, extra map[string]string) (string, error) {
		full := []string{"-L", socket}
		if configFile != "" {
			full = append([]string{"-f", configFile}, full...)
		}
		cmd := exec.CommandContext(ctx, "tmux", append(full, args...)...)
		env := baseEnv(os.LookupEnv)
		for k, v := range extra {
			env[k] = v
		}
		cmd.Env = envList(env)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			return stdout.String(), &TmuxError{Args: args, Stderr: stderr.String(), Err: err}
		}
		return stdout.String(), nil
	}
	return t
}

func (t *Tmux) run(ctx context.Context, args ...string) (string, error) {
	return t.exec(ctx, args, nil)
}

// EnsureServer starts the server and re-applies the settings that must hold on any server.
func (t *Tmux) EnsureServer(ctx context.Context) error {
	_, err := t.run(ctx, "start-server",
		";", "set-option", "-g", "exit-empty", "off",
		";", "set-option", "-g", "update-environment", "",
		";", "set-option", "-g", "prefix", "none",
		";", "set-option", "-g", "prefix2", "none",
		";", "set-option", "-g", "status", "off",
		";", "set-option", "-g", "mouse", "off",
		";", "set-option", "-g", "history-limit", "10000")
	if err != nil {
		return err
	}
	return t.clearInheritedGlobalEnv(ctx)
}

// clearInheritedGlobalEnv strips what a hand-started server inherited from someone's shell.
func (t *Tmux) clearInheritedGlobalEnv(ctx context.Context) error {
	shown, err := t.run(ctx, "show-environment", "-g")
	if err != nil {
		return nil
	}
	var names []string
	for _, line := range strings.Split(shown, "\n") {
		i := strings.Index(line, "=")
		if i <= 0 || strings.HasPrefix(line, "-") {
			continue
		}
		name := line[:i]
		if name == "PWD" || contains(baseEnvNames, name) {
			continue
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil
	}
	var args []string
	for _, name := range names {
		if len(args) > 0 {
			args = append(args, ";")
		}
		args = append(args, "set-environment", "-g", "-u", name)
	}
	if _, err := t.run(ctx, args...); err != nil {
		return err
	}
	logf("agentdeck: cleared %d inherited variable(s) from the tmux server's global environment: %s",
		len(names), strings.Join(names, ", "))
	return nil
}

// List returns every session on the socket; an empty or absent server is an empty list.
func (t *Tmux) List(ctx context.Context) ([]TmuxSession, error) {
	out, err := t.run(ctx, "list-sessions", "-F",
		strings.Join([]string{"#{session_name}", "#{pane_dead}", "#{pane_dead_status}", "#{session_created}", "#{session_path}"}, sep))
	if err != nil {
		if isEmptyTmux(err) {
			return nil, nil
		}
		return nil, err
	}
	var lines []string
	for _, l := range strings.Split(out, "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	anyFields := false
	for _, l := range lines {
		if hasFields(l) {
			anyFields = true
		}
	}
	if len(lines) > 0 && !anyFields {
		return nil, fmt.Errorf("tmux returned list-sessions output with no field separator: %q. "+
			"tmux replaces non-printable bytes with \"_\" for a client whose locale is not UTF-8; "+
			"set a UTF-8 locale for the process running agentdeck (LC_ALL outranks LC_CTYPE and LANG)", lines[0])
	}
	var sessions []TmuxSession
	for _, l := range lines {
		if !hasFields(l) {
			continue
		}
		f := splitFields(l)
		get := func(i int, d string) string {
			if i < len(f) {
				return f[i]
			}
			return d
		}
		path := ""
		if len(f) > 4 {
			path = strings.Join(f[4:], sep)
		}
		dead := get(1, "0") == "1"
		var exitCode *int
		if status := get(2, ""); dead && status != "" {
			if n, err := strconv.Atoi(status); err == nil {
				exitCode = &n
			}
		}
		created, _ := strconv.ParseInt(get(3, "0"), 10, 64)
		sessions = append(sessions, TmuxSession{ID: get(0, ""), Dead: dead, ExitCode: exitCode, StartedAt: created * 1000, Path: path})
	}
	return sessions, nil
}

func (t *Tmux) Has(ctx context.Context, id string) (bool, error) {
	list, err := t.List(ctx)
	if err != nil {
		return false, err
	}
	for _, s := range list {
		if s.ID == id {
			return true, nil
		}
	}
	return false, nil
}

// CreateOrAttach starts a session unless one exists; secrets ride the client environment, never argv.
func (t *Tmux) CreateOrAttach(ctx context.Context, id, cwd, command string, args []string, env map[string]string) (attached bool, err error) {
	existed, err := t.Has(ctx, id)
	if err != nil || existed {
		return existed, err
	}
	if err := t.EnsureServer(ctx); err != nil {
		return false, err
	}
	names := make([]string, 0, len(env))
	for k := range env {
		names = append(names, k)
	}
	var full []string
	if len(names) > 0 {
		full = append(full, "set-option", "-g", "update-environment", strings.Join(names, " "), ";")
	}
	full = append(full, "new-session", "-d", "-A", "-s", id, "-c", cwd, "--", command)
	full = append(full, args...)
	full = append(full, ";", "set-option", "-t", exactWindowTarget(id), "remain-on-exit", "on",
		";", "set-option", "-g", "update-environment", "")
	for _, k := range names {
		full = append(full, ";", "set-environment", "-t", exactTarget(id), "-u", k)
	}
	if _, err := t.exec(ctx, full, env); err != nil {
		if len(names) > 0 {
			_, _ = t.run(ctx, "set-option", "-g", "update-environment", "")
		}
		values := make([]string, 0, len(env))
		for _, v := range env {
			values = append(values, v)
		}
		return false, errors.New(redactSecrets(err.Error(), values))
	}
	return false, nil
}

func redactSecrets(text string, values []string) string {
	for _, v := range values {
		if v != "" {
			text = strings.ReplaceAll(text, v, "<redacted>")
		}
	}
	return text
}

// Describe reads one session's path and creation time by exact target, or ok=false if tmux cannot say.
func (t *Tmux) Describe(ctx context.Context, id string) (path string, startedAt int64, ok bool) {
	out, err := t.run(ctx, "display-message", "-p", "-t", exactWindowTarget(id), "#{session_path}"+sep+"#{session_created}")
	if err != nil {
		return "", 0, false
	}
	f := splitFields(strings.TrimSpace(out))
	if len(f) < 2 {
		return "", 0, false
	}
	created := f[len(f)-1]
	path = strings.Join(f[:len(f)-1], sep)
	n, err := strconv.ParseInt(created, 10, 64)
	if path == "" || err != nil {
		return "", 0, false
	}
	return path, n * 1000, true
}

type PaneRef struct {
	SessionID string `json:"sessionId"`
	PanePid   int    `json:"panePid"`
}

// PanePids lists each session's pane pid on this socket only.
func (t *Tmux) PanePids(ctx context.Context) ([]PaneRef, error) {
	out, err := t.run(ctx, "list-panes", "-a", "-F", "#{session_name}"+sep+"#{pane_pid}")
	if err != nil {
		if isEmptyTmux(err) {
			return nil, nil
		}
		return nil, err
	}
	var found []PaneRef
	for _, line := range strings.Split(out, "\n") {
		if !hasFields(line) {
			continue
		}
		f := splitFields(line)
		pid, err := strconv.Atoi(strings.TrimSpace(f[len(f)-1]))
		id := strings.Join(f[:len(f)-1], sep)
		if id != "" && err == nil && pid > 1 {
			found = append(found, PaneRef{id, pid})
		}
	}
	return found, nil
}

// Kill ends the session and every process in its pane trees, read before the kill.
func (t *Tmux) Kill(ctx context.Context, id string) error {
	doomed := t.treeOfSession(ctx, id)
	if _, err := t.run(ctx, "kill-session", "-t", exactTarget(id)); err != nil && !isMissingSession(err) && !isEmptyTmux(err) {
		return err
	}
	if len(doomed) == 0 {
		return nil
	}
	if survivors := endTree(doomed, endTreeOptions{}); len(survivors) > 0 {
		logf("agentdeck: closing %s left %d process(es) that refused to die: %v", id, len(survivors), survivors)
	}
	return nil
}

func (t *Tmux) treeOfSession(ctx context.Context, id string) []int {
	panes, err := t.PanePids(ctx)
	if err != nil {
		return nil
	}
	var roots []int
	for _, p := range panes {
		if p.SessionID == id {
			roots = append(roots, p.PanePid)
		}
	}
	if len(roots) == 0 {
		return nil
	}
	rows := readProcessTable(ctx)
	var found []int
	for _, pane := range roots {
		for _, row := range treeOf(rows, pane) {
			if !containsInt(found, row.Pid) {
				found = append(found, row.Pid)
			}
		}
	}
	return found
}

// CaptureHistory returns scrollback that has left the pane, without -J (which welds TUI rows).
func (t *Tmux) CaptureHistory(ctx context.Context, id string, lines int) (string, error) {
	out, err := t.run(ctx, "capture-pane", "-p", "-e", "-t", exactWindowTarget(id), "-S", "-"+strconv.Itoa(lines), "-E", "-1")
	if err != nil {
		if isMissingSession(err) || isEmptyTmux(err) {
			return "", nil
		}
		return "", err
	}
	return forTerminal(out), nil
}

func (t *Tmux) IsAlternateScreen(ctx context.Context, id string) (bool, error) {
	out, err := t.run(ctx, "display-message", "-p", "-t", exactWindowTarget(id), "#{alternate_on}")
	if err != nil {
		if isMissingSession(err) || isEmptyTmux(err) {
			return false, nil
		}
		return false, err
	}
	return strings.TrimSpace(out) == "1", nil
}

func (t *Tmux) PaneModes(ctx context.Context, id string) (PaneModes, error) {
	out, err := t.run(ctx, "display-message", "-p", "-t", exactWindowTarget(id),
		"#{alternate_on}#{mouse_standard_flag}#{mouse_button_flag}#{mouse_all_flag}#{mouse_sgr_flag}")
	if err != nil {
		if isMissingSession(err) || isEmptyTmux(err) {
			return PaneModes{}, nil
		}
		return PaneModes{}, err
	}
	return readPaneModes(out), nil
}

// Repaint asks every attached client to redraw, so the bytes arrive on the stream we read.
func (t *Tmux) Repaint(ctx context.Context, id string) error {
	out, err := t.run(ctx, "list-clients", "-t", exactTarget(id), "-F", "#{client_tty}")
	if err != nil {
		return err
	}
	var ttys []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			ttys = append(ttys, l)
		}
	}
	if len(ttys) == 0 {
		return fmt.Errorf("no tmux client is attached to %s, so it cannot repaint", id)
	}
	for _, tty := range ttys {
		if _, err := t.run(ctx, "refresh-client", "-t", tty, "-R"); err != nil {
			return err
		}
	}
	return nil
}

// PaneModes are the terminal modes a repaint does not restate.
type PaneModes struct {
	Alternate bool
	Tracking  int // 0, 1000, 1002, 1003
	SGR       bool
}

var fiveDigits = regexp.MustCompile(`^[01]{5}$`)

func readPaneModes(stdout string) PaneModes {
	d := strings.TrimSpace(stdout)
	if !fiveDigits.MatchString(d) {
		return PaneModes{}
	}
	on := func(i int) bool { return d[i] == '1' }
	tracking := 0
	switch {
	case on(3):
		tracking = 1003
	case on(2):
		tracking = 1002
	case on(1):
		tracking = 1000
	}
	return PaneModes{Alternate: on(0), Tracking: tracking, SGR: on(4)}
}

func modeBytes(m PaneModes) string {
	out := ""
	if m.Alternate {
		out += "\x1b[?1049h"
	}
	if m.Tracking != 0 {
		out += fmt.Sprintf("\x1b[?%dh", m.Tracking)
	}
	if m.SGR {
		out += "\x1b[?1006h"
	}
	return out
}

// defaultConfigFile is tmux.conf beside the server-go directory's parent checkout.
func defaultConfigFile() string {
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "..", "tmux.conf")
		if _, err := os.Stat(candidate); err == nil {
			abs, _ := filepath.Abs(candidate)
			return abs
		}
	}
	if wd, err := os.Getwd(); err == nil {
		for _, c := range []string{filepath.Join(wd, "tmux.conf"), filepath.Join(wd, "..", "tmux.conf")} {
			if _, err := os.Stat(c); err == nil {
				abs, _ := filepath.Abs(c)
				return abs
			}
		}
	}
	return ""
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func containsInt(list []int, n int) bool {
	for _, v := range list {
		if v == n {
			return true
		}
	}
	return false
}
