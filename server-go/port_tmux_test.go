package main

// Port of src/tmux.test.ts, src/pty.test.ts, src/pane-modes.test.ts and src/session-id.test.ts.

import (
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
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

// tmxFake records every tmux invocation and replays canned stdout, chosen by membership in args.
type tmxFake struct {
	tmux  *Tmux
	calls [][]string
	envs  []map[string]string
}

func tmxNewFake(responses map[string]any) *tmxFake {
	f := &tmxFake{}
	f.tmux = &Tmux{Socket: "test"}
	f.tmux.exec = func(_ context.Context, args []string, extra map[string]string) (string, error) {
		f.calls = append(f.calls, append([]string(nil), args...))
		f.envs = append(f.envs, extra)
		keys := make([]string, 0, len(responses))
		for k := range responses {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if contains(args, k) {
				switch r := responses[k].(type) {
				case error:
					return "", r
				case string:
					return r, nil
				}
			}
		}
		return "", nil
	}
	return f
}

func tmxStderr(stderr string) error {
	return &TmuxError{Stderr: stderr, Err: errors.New("exit status 1")}
}

func tmxCommandsOf(args []string) [][]string {
	out := [][]string{{}}
	for _, a := range args {
		if a == ";" {
			out = append(out, []string{})
		} else {
			out[len(out)-1] = append(out[len(out)-1], a)
		}
	}
	return out
}

func tmxFind(calls [][]string, name string) []string {
	for _, c := range calls {
		if contains(c, name) {
			return c
		}
	}
	return nil
}

func tmxEqual(t *testing.T, got, want any, what string) {
	t.Helper()
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	if string(g) != string(w) {
		t.Fatalf("%s: got %s, want %s", what, g, w)
	}
}

func tmxLine(id, dead, status string) string {
	return strings.Join([]string{id, dead, status, "1700000000"}, sep)
}

var tmxBG = context.Background()

func TestTmux_ListingSessions(t *testing.T) {
	t.Run("reads the fields the state machine needs", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": tmxLine("a-claude-1", "0", "") + "\n"})
		s, err := f.tmux.List(tmxBG)
		if err != nil || len(s) != 1 || s[0].ID != "a-claude-1" || s[0].Dead || s[0].StartedAt != 1_700_000_000_000 {
			t.Fatalf("%+v %v", s, err)
		}
	})
	t.Run("a dead pane reports its exit code", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": tmxLine("a-claude-1", "1", "137") + "\n"})
		s, _ := f.tmux.List(tmxBG)
		if len(s) != 1 || !s[0].Dead || s[0].ExitCode == nil || *s[0].ExitCode != 137 {
			t.Fatalf("%+v", s)
		}
	})
	t.Run("a live pane has no exit code, rather than exit code zero", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": tmxLine("a-claude-1", "0", "") + "\n"})
		s, _ := f.tmux.List(tmxBG)
		if len(s) != 1 || s[0].ExitCode != nil {
			t.Fatalf("%+v", s)
		}
	})
	for name, stderr := range map[string]string{
		"no server running is an empty list, not a throw":        "no server running on /tmp/tmux-1000/test",
		"no sessions is an empty list too":                       "no sessions",
		"and so is the wording tmux 3.7b on macOS actually uses": "error connecting to /private/tmp/tmux-501/agentdeck (No such file or directory)\n",
	} {
		t.Run(name, func(t *testing.T) {
			f := tmxNewFake(map[string]any{"list-sessions": tmxStderr(stderr)})
			s, err := f.tmux.List(tmxBG)
			if err != nil || len(s) != 0 {
				t.Fatalf("%+v %v", s, err)
			}
		})
	}
	t.Run("mangled output fails the whole list rather than being read as sessions", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": "a-claude-1_0__1700000000_/a\nrepo-sh-df464c46_0__1786113059_/x\n"})
		s, err := f.tmux.List(tmxBG)
		if err == nil || !regexp.MustCompile(`(?s)field separator.*UTF-8`).MatchString(err.Error()) || len(s) != 0 {
			t.Fatalf("%+v %v", s, err)
		}
	})
	t.Run("a newline in one session's path costs that session, not the whole list", func(t *testing.T) {
		out := tmxLine("a-claude-1", "0", "") + sep + "/tmp/ro\ngue\n" + tmxLine("b-claude-2", "0", "") + sep + "/tmp/ok\n"
		s, err := tmxList(t, out)
		if err != nil || len(s) != 2 || s[0].ID != "a-claude-1" || s[1].ID != "b-claude-2" {
			t.Fatalf("%+v %v", s, err)
		}
	})
	t.Run("a session name containing the separator is still parsed, not called mangled", func(t *testing.T) {
		s, err := tmxList(t, tmxLine("odd"+sep+"name", "0", "")+"\n")
		if err != nil || len(s) != 1 || s[0].ID != "odd" {
			t.Fatalf("%+v %v", s, err)
		}
	})
	t.Run("any other failure propagates", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": tmxStderr("permission denied")})
		if _, err := f.tmux.List(tmxBG); err == nil {
			t.Fatal("a permission failure was read as an empty list")
		}
	})
}

func tmxList(t *testing.T, out string) ([]TmuxSession, error) {
	t.Helper()
	return tmxNewFake(map[string]any{"list-sessions": out}).tmux.List(tmxBG)
}

func TestTmux_CreateOrAttach(t *testing.T) {
	t.Run("creates when absent, and sets remain-on-exit", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": ""})
		attached, err := f.tmux.CreateOrAttach(tmxBG, "web-claude-abc", "/workspace/web", "claude", nil, map[string]string{})
		if err != nil || attached {
			t.Fatal(attached, err)
		}
		var create []string
		for _, c := range f.calls {
			if c[0] == "new-session" {
				create = c
			}
		}
		if create == nil || !contains(create, "-A") || !contains(create, "-d") {
			t.Fatalf("no new-session -d -A: %v", f.calls)
		}
		cmds := tmxCommandsOf(create)
		first := cmds[0]
		tmxEqual(t, first[tmxIndex(first, "--"):], []string{"--", "claude"}, "command")
		tmxEqual(t, cmds[1], []string{"set-option", "-t", "=web-claude-abc:", "remain-on-exit", "on"}, "remain-on-exit")
	})
	t.Run("reports attached when the session already exists, and creates nothing", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": tmxLine("web-claude-abc", "0", "") + "\n"})
		attached, err := f.tmux.CreateOrAttach(tmxBG, "web-claude-abc", "/workspace/web", "claude", nil, nil)
		if err != nil || !attached || tmxFind(f.calls, "new-session") != nil {
			t.Fatal(attached, err, f.calls)
		}
	})
	t.Run("passes environment per session rather than through our own", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": ""})
		_, _ = f.tmux.CreateOrAttach(tmxBG, "s", "/w", "claude", nil, map[string]string{"AGENTDECK_SECRET": "abc"})
		found := false
		for i, c := range f.calls {
			if contains(c, "new-session") {
				found = f.envs[i]["AGENTDECK_SECRET"] == "abc"
			} else if _, ok := f.envs[i]["AGENTDECK_SECRET"]; ok {
				t.Fatalf("the secret reached another call: %v", c)
			}
		}
		if !found {
			t.Fatal("the creating client did not carry the secret")
		}
	})
	t.Run("no value is ever an argument, because argv is public", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": ""})
		_, _ = f.tmux.CreateOrAttach(tmxBG, "s", "/w", "claude", nil, map[string]string{
			"AGENTDECK_SECRET": "s3cretvalue", "ANTHROPIC_API_KEY": "sk-ant-live",
		})
		for _, c := range f.calls {
			for _, a := range c {
				if strings.Contains(a, "s3cretvalue") || strings.Contains(a, "sk-ant-live") {
					t.Fatalf("a value reached argv: %s", a)
				}
			}
		}
		var create []string
		var env map[string]string
		for i, c := range f.calls {
			if contains(c, "new-session") {
				create, env = c, f.envs[i]
			}
		}
		cmds := tmxCommandsOf(create)
		tmxEqual(t, cmds[0][:3], []string{"set-option", "-g", "update-environment"}, "first command")
		names := strings.Split(cmds[0][3], " ")
		sort.Strings(names)
		tmxEqual(t, names, []string{"AGENTDECK_SECRET", "ANTHROPIC_API_KEY"}, "names")
		emptied := false
		for _, c := range cmds[1:] {
			if len(c) == 4 && c[0] == "set-option" && c[2] == "update-environment" && c[3] == "" {
				emptied = true
			}
		}
		if !emptied {
			t.Fatal("update-environment is left naming the secrets")
		}
		if env["ANTHROPIC_API_KEY"] != "sk-ant-live" {
			t.Fatal("the value did not ride the client environment")
		}
	})
	t.Run("and takes every one of them back out of the session environment", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": ""})
		_, _ = f.tmux.CreateOrAttach(tmxBG, "s", "/w", "claude", nil, map[string]string{
			"AGENTDECK_SECRET": "abc", "ANTHROPIC_API_KEY": "sk-live", "AGENTDECK_SESSION_ID": "s",
		})
		n := 0
		var create []string
		for _, c := range f.calls {
			if contains(c, "new-session") || contains(c, "set-environment") {
				n++
				create = c
			}
		}
		if n != 1 {
			t.Fatalf("%d invocations create or unset, want one", n)
		}
		var unset []string
		for _, c := range tmxCommandsOf(create) {
			if c[0] == "set-environment" {
				tmxEqual(t, c[:4], []string{"set-environment", "-t", "=s", "-u"}, "unset shape")
				if len(c) != 5 {
					t.Fatalf("unset has %d args", len(c))
				}
				unset = append(unset, c[4])
			}
		}
		sort.Strings(unset)
		tmxEqual(t, unset, []string{"AGENTDECK_SECRET", "AGENTDECK_SESSION_ID", "ANTHROPIC_API_KEY"}, "unset")
	})
	t.Run("a failed create does not put the secret or an API key in the error", func(t *testing.T) {
		f := tmxNewFake(map[string]any{
			"list-sessions": "",
			"new-session": &TmuxError{
				Stderr: "error connecting to /tmp/tmux-501/agdz",
				Err:    errors.New("Command failed: tmux -L agdz new-session -e AGENTDECK_SECRET=s3cret -e ANTHROPIC_API_KEY=sk-live-xyz -- /bin/sh"),
			},
		})
		_, err := f.tmux.CreateOrAttach(tmxBG, "x", "/tmp", "/bin/sh", nil, map[string]string{
			"AGENTDECK_SECRET": "s3cret", "ANTHROPIC_API_KEY": "sk-live-xyz",
		})
		if err == nil {
			t.Fatal("the failure was swallowed")
		}
		msg := err.Error()
		if strings.Contains(msg, "s3cret") || strings.Contains(msg, "sk-live-xyz") || !strings.Contains(msg, "error connecting to") {
			t.Fatalf("message: %s", msg)
		}
	})
	t.Run("the command is passed after --, so an argument cannot become a tmux flag", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-sessions": ""})
		_, _ = f.tmux.CreateOrAttach(tmxBG, "s", "/w", "claude", []string{"--dangerous"}, nil)
		first := tmxCommandsOf(tmxFind(f.calls, "new-session"))[0]
		tmxEqual(t, first[tmxIndex(first, "--")+1:], []string{"claude", "--dangerous"}, "command")
	})
}

func tmxIndex(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}

func TestTmux_EnsureServer(t *testing.T) {
	t.Run("starts one and turns exit-empty off", func(t *testing.T) {
		f := tmxNewFake(nil)
		if err := f.tmux.EnsureServer(tmxBG); err != nil {
			t.Fatal(err)
		}
		tmxEqual(t, tmxCommandsOf(f.calls[0]), [][]string{
			{"start-server"},
			{"set-option", "-g", "exit-empty", "off"},
			{"set-option", "-g", "update-environment", ""},
			{"set-option", "-g", "prefix", "none"},
			{"set-option", "-g", "prefix2", "none"},
			{"set-option", "-g", "status", "off"},
			{"set-option", "-g", "mouse", "off"},
			{"set-option", "-g", "history-limit", "10000"},
		}, "ensureServer")
	})
	t.Run("empties update-environment, which is the client half of a built environment", func(t *testing.T) {
		f := tmxNewFake(nil)
		_ = f.tmux.EnsureServer(tmxBG)
		for _, c := range tmxCommandsOf(f.calls[0]) {
			if len(c) == 4 && c[0] == "set-option" && c[2] == "update-environment" && c[3] == "" {
				return
			}
		}
		t.Fatal("update-environment was not emptied")
	})
}

func tmxLookup(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func tmxKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestTmux_BaseEnv(t *testing.T) {
	t.Run("is built from named variables, not inherited from the launching shell", func(t *testing.T) {
		built := baseEnv(tmxLookup(map[string]string{
			"PATH": "/usr/bin", "HOME": "/Users/x", "SSH_AUTH_SOCK": "/private/tmp/agent.sock",
			"AWS_SECRET_ACCESS_KEY": "sk-live", "SEKRIT": "marker",
		}))
		tmxEqual(t, tmxKeys(built), []string{"HOME", "LC_CTYPE", "PATH", "TERM"}, "names")
		if built["LC_CTYPE"] != "UTF-8" {
			t.Fatal(built)
		}
		if _, ok := baseEnv(tmxLookup(map[string]string{"PATH": "/usr/bin", "LANG": "ja_JP.UTF-8"}))["LC_CTYPE"]; ok {
			t.Fatal("LC_CTYPE was forced over a UTF-8 LANG")
		}
	})
	t.Run("nothing on the list is a credential", func(t *testing.T) {
		re := regexp.MustCompile(`(?i)KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL`)
		for _, n := range baseEnvNames {
			if re.MatchString(n) {
				t.Fatal(n)
			}
		}
	})
	t.Run("an operator's own UTF-8 locale is kept, in whichever variable declares it", func(t *testing.T) {
		for _, name := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
			built := baseEnv(tmxLookup(map[string]string{"PATH": "/usr/bin", name: "ja_JP.UTF-8"}))
			if built[name] != "ja_JP.UTF-8" {
				t.Fatal(name, built)
			}
			ctype, ok := built["LC_CTYPE"]
			if name == "LC_CTYPE" && ctype != "ja_JP.UTF-8" || name != "LC_CTYPE" && ok {
				t.Fatal(name, built)
			}
		}
		if _, ok := baseEnv(tmxLookup(map[string]string{"PATH": "/usr/bin", "LANG": "en_US.utf8"}))["LC_CTYPE"]; ok {
			t.Fatal("utf8 without a dash was not read as UTF-8")
		}
	})
	t.Run("a non-UTF-8 locale is fixed in the variable that actually wins", func(t *testing.T) {
		allC := baseEnv(tmxLookup(map[string]string{"PATH": "/usr/bin", "LC_ALL": "C"}))
		if _, ok := allC["LC_ALL"]; ok || allC["LC_CTYPE"] != "UTF-8" {
			t.Fatal(allC)
		}
		ctypeC := baseEnv(tmxLookup(map[string]string{"PATH": "/usr/bin", "LANG": "en_US.UTF-8", "LC_CTYPE": "C"}))
		if _, ok := ctypeC["LC_ALL"]; ok || ctypeC["LC_CTYPE"] != "UTF-8" {
			t.Fatal(ctypeC)
		}
		allUTF8 := baseEnv(tmxLookup(map[string]string{"PATH": "/usr/bin", "LC_ALL": "C.UTF-8", "LC_CTYPE": "C"}))
		if allUTF8["LC_ALL"] != "C.UTF-8" || allUTF8["LC_CTYPE"] != "C" {
			t.Fatal(allUTF8)
		}
	})
	t.Run("LC_CTYPE is on the name list, so the global-environment sweep does not strip it", func(t *testing.T) {
		if !contains(baseEnvNames, "LC_CTYPE") {
			t.Fatal(baseEnvNames)
		}
	})
	t.Run("a process started with no TERM still gets a usable terminal", func(t *testing.T) {
		if baseEnv(tmxLookup(map[string]string{"PATH": "/usr/bin"}))["TERM"] != "xterm-256color" {
			t.Fatal("no TERM default")
		}
	})
}

func TestTmux_KillIsIdempotent(t *testing.T) {
	t.Run("a missing session is the desired end state, not a failure", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"kill-session": tmxStderr("can't find session: gone")})
		if err := f.tmux.Kill(tmxBG, "gone"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("a real failure still propagates", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"kill-session": tmxStderr("permission denied")})
		if err := f.tmux.Kill(tmxBG, "s"); err == nil {
			t.Fatal("swallowed")
		}
	})
}

func TestTmux_CaptureAndRepaint(t *testing.T) {
	t.Run("capture-pane asks for escapes and a bounded history", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"capture-pane": "old output\n"})
		out, err := f.tmux.CaptureHistory(tmxBG, "s", 2000)
		if err != nil || out != "old output\r\n" {
			t.Fatalf("%q %v", out, err)
		}
		c := f.calls[0]
		if !contains(c, "-e") || !contains(c, "-p") || contains(c, "-J") {
			t.Fatal(c)
		}
		i := tmxIndex(c, "-S")
		tmxEqual(t, c[i:i+2], []string{"-S", "-2000"}, "history bound")
	})
	t.Run("capturing a session that has gone returns nothing rather than throwing", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"capture-pane": tmxStderr("can't find session: s")})
		if out, err := f.tmux.CaptureHistory(tmxBG, "s", 100); err != nil || out != "" {
			t.Fatal(out, err)
		}
	})
	t.Run("repaint targets the client tty, because refresh-client takes nothing else", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-clients": "/dev/ttys010\n", "refresh-client": ""})
		if err := f.tmux.Repaint(tmxBG, "s"); err != nil {
			t.Fatal(err)
		}
		c0, c1 := f.calls[0], f.calls[1]
		tmxEqual(t, c0[len(c0)-4:], []string{"-t", "=s", "-F", "#{client_tty}"}, "list-clients")
		tmxEqual(t, c1[len(c1)-3:], []string{"-t", "/dev/ttys010", "-R"}, "refresh-client")
	})
	t.Run("every attached client is refreshed, not the concatenated list as one target", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-clients": "/dev/ttys010\n/dev/ttys012\n", "refresh-client": ""})
		_ = f.tmux.Repaint(tmxBG, "s")
		if len(f.calls) != 3 {
			t.Fatal(f.calls)
		}
		c1, c2 := f.calls[1], f.calls[2]
		tmxEqual(t, c1[len(c1)-3:], []string{"-t", "/dev/ttys010", "-R"}, "first")
		tmxEqual(t, c2[len(c2)-3:], []string{"-t", "/dev/ttys012", "-R"}, "second")
	})
	t.Run("a session with no attached client cannot repaint, and says so", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"list-clients": ""})
		err := f.tmux.Repaint(tmxBG, "s")
		if err == nil || !strings.Contains(err.Error(), "no tmux client is attached to s") {
			t.Fatal(err)
		}
	})
}

func TestTmux_AlternateScreen(t *testing.T) {
	t.Run("reports the pane's mode from #{alternate_on}", func(t *testing.T) {
		on := tmxNewFake(map[string]any{"display-message": "1\n"})
		if v, err := on.tmux.IsAlternateScreen(tmxBG, "s"); !v || err != nil || !contains(on.calls[0], "#{alternate_on}") {
			t.Fatal(v, err, on.calls)
		}
		off := tmxNewFake(map[string]any{"display-message": "0\n"})
		if v, _ := off.tmux.IsAlternateScreen(tmxBG, "s"); v {
			t.Fatal("0 read as on")
		}
	})
	t.Run("a session that has gone is not on the alternate screen", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"display-message": tmxStderr("can't find session: s")})
		if v, err := f.tmux.IsAlternateScreen(tmxBG, "s"); v || err != nil {
			t.Fatal(v, err)
		}
	})
}

func TestTmux_ThePanesModes(t *testing.T) {
	t.Run("reads the five flags in one call", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"display-message": "10011\n"})
		m, err := f.tmux.PaneModes(tmxBG, "s")
		if err != nil || m != (PaneModes{Alternate: true, Tracking: 1003, SGR: true}) || len(f.calls) != 1 ||
			!strings.Contains(strings.Join(f.calls[0], " "), "#{mouse_all_flag}") {
			t.Fatal(m, err, f.calls)
		}
	})
	t.Run("a session that has gone has no modes to state", func(t *testing.T) {
		f := tmxNewFake(map[string]any{"display-message": tmxStderr("can't find session: s")})
		if m, err := f.tmux.PaneModes(tmxBG, "s"); err != nil || m != (PaneModes{}) {
			t.Fatal(m, err)
		}
	})
}

func TestTmux_ErrorClassification(t *testing.T) {
	t.Run("distinguishes an empty server from a missing session", func(t *testing.T) {
		empty, missing := tmxStderr("no server running on /tmp/x"), tmxStderr("can't find session: abc")
		if !isEmptyTmux(empty) || isMissingSession(empty) || !isMissingSession(missing) || isEmptyTmux(missing) {
			t.Fatal("misclassified")
		}
	})
	t.Run("survives a non-object error", func(t *testing.T) {
		if isEmptyTmux(errors.New("boom")) || isMissingSession(nil) || isEmptyTmux(nil) {
			t.Fatal("misclassified")
		}
	})
	t.Run("an empty pane list is not an error", func(t *testing.T) {
		if !isEmptyTmux(tmxStderr("no current target")) || isMissingSession(tmxStderr("no current target")) {
			t.Fatal("misclassified")
		}
		f := tmxNewFake(map[string]any{"list-panes": errors.New("no current target")})
		if p, err := f.tmux.PanePids(tmxBG); err != nil || len(p) != 0 {
			t.Fatal(p, err)
		}
	})
}

// --- Against a real tmux server ---

// tmxServer is a Tmux on its own agentdeck-gotest- socket, reading no config, killed and unlinked after.
func tmxServer(t *testing.T, suffix string) *Tmux {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	socket := fmt.Sprintf("agentdeck-gotest-tmx-%s-%d-%d", suffix, os.Getpid(), time.Now().UnixNano()%1000000)
	tm := newTmux(socket, "/dev/null")
	t.Cleanup(func() {
		path, _ := tm.run(tmxBG, "display-message", "-p", "#{socket_path}")
		_, _ = tm.run(tmxBG, "kill-server")
		if path = strings.TrimSpace(path); strings.Contains(path, socket) {
			_ = os.Remove(path)
		}
	})
	return tm
}

func tmxWaitFile(path string) string {
	for i := 0; i < 100; i++ {
		if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
			return string(b)
		}
		time.Sleep(50 * time.Millisecond)
	}
	return ""
}

func tmxShow(t *testing.T, tm *Tmux, args ...string) string {
	t.Helper()
	out, err := tm.run(tmxBG, args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTmux_RealServerPaneEnvironment(t *testing.T) {
	t.Run("the pane has the secret, and show-environment does not", func(t *testing.T) {
		tm := tmxServer(t, "env")
		t.Setenv("SEKRIT_MARKER", "the-launching-shell")
		t.Setenv("SSH_AUTH_SOCK", "/tmp/agentdeck-test-agent.sock")
		out := filepath.Join(t.TempDir(), "env")
		if err := tm.EnsureServer(tmxBG); err != nil {
			t.Fatal(err)
		}
		if _, err := tm.CreateOrAttach(tmxBG, "envprobe", os.TempDir(), "/bin/sh", []string{"-c", "env > " + out + "; sleep 5"},
			map[string]string{"AGENTDECK_SECRET": "s3cret-value", "AGENTDECK_SESSION_ID": "envprobe"}); err != nil {
			t.Fatal(err)
		}
		env := tmxWaitFile(out)
		if env == "" {
			t.Fatal("the pane never wrote its environment")
		}
		if !regexp.MustCompile(`(?m)^AGENTDECK_SECRET=s3cret-value$`).MatchString(env) {
			t.Fatal("the agent did not get its secret")
		}
		if regexp.MustCompile(`(?m)^SEKRIT_MARKER=`).MatchString(env) || regexp.MustCompile(`(?m)^SSH_AUTH_SOCK=`).MatchString(env) {
			t.Fatal("the pane inherited the launching shell")
		}
		shown := tmxShow(t, tm, "show-environment", "-t", "envprobe")
		if strings.Contains(shown, "s3cret-value") || strings.Contains(shown, "SSH_AUTH_SOCK=") {
			t.Fatalf("show-environment printed: %s", shown)
		}
	})
	t.Run("the client carrying the secrets never starts the tmux server", func(t *testing.T) {
		tm := tmxServer(t, "nosrv")
		if _, err := tm.CreateOrAttach(tmxBG, "secretprobe", os.TempDir(), "/bin/sh", []string{"-c", "sleep 5"},
			map[string]string{"AGENTDECK_SECRET": "leak-canary-value", "AGENTDECK_SESSION_ID": "secretprobe"}); err != nil {
			t.Fatal(err)
		}
		if g := tmxShow(t, tm, "show-environment", "-g"); strings.Contains(g, "leak-canary-value") {
			t.Fatal("the secret reached the global environment")
		}
	})
	t.Run("the prefix is not a command channel on our socket", func(t *testing.T) {
		tm := tmxServer(t, "prefix")
		if err := tm.EnsureServer(tmxBG); err != nil {
			t.Fatal(err)
		}
		for _, opt := range []string{"prefix", "prefix2"} {
			if s := tmxShow(t, tm, "show-options", "-g", opt); !strings.Contains(strings.ToLower(s), "none") {
				t.Fatalf("%s is still bound: %s", opt, s)
			}
		}
	})
	t.Run("a server we did not start does not hand its environment to our panes", func(t *testing.T) {
		tm := tmxServer(t, "dirty")
		out := filepath.Join(t.TempDir(), "env")
		cmd := exec.Command("tmux", "-f", "/dev/null", "-L", tm.Socket, "new-session", "-d", "-s", "operator", "sleep", "30")
		cmd.Env = append(os.Environ(), "SEKRIT_MARKER=the-operators-shell", "SSH_AUTH_SOCK=/tmp/agentdeck-test-agent.sock")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatal(err, string(b))
		}
		if err := tm.EnsureServer(tmxBG); err != nil {
			t.Fatal(err)
		}
		if _, err := tm.CreateOrAttach(tmxBG, "dirtyprobe", os.TempDir(), "/bin/sh", []string{"-c", "env > " + out + "; sleep 5"},
			map[string]string{"AGENTDECK_SESSION_ID": "dirtyprobe"}); err != nil {
			t.Fatal(err)
		}
		env := tmxWaitFile(out)
		if env == "" {
			t.Fatal("the pane never wrote its environment")
		}
		if regexp.MustCompile(`(?m)^(SEKRIT_MARKER|SSH_AUTH_SOCK)=`).MatchString(env) {
			t.Fatal("the pane inherited the shell that started the pre-existing server")
		}
	})
	t.Run("a login shell in the pane puts the operator's dotfiles back", func(t *testing.T) {
		if _, err := os.Stat("/bin/zsh"); err != nil {
			t.Skip("no /bin/zsh")
		}
		tm := tmxServer(t, "login")
		home := t.TempDir()
		login, plain := filepath.Join(home, "login.env"), filepath.Join(home, "plain.env")
		_ = os.WriteFile(filepath.Join(home, ".zprofile"), []byte("export SSH_AUTH_SOCK=/tmp/from-dotfile.sock\n"), 0o644)
		if err := tm.EnsureServer(tmxBG); err != nil {
			t.Fatal(err)
		}
		dot := map[string]string{"HOME": home, "ZDOTDIR": home}
		if _, err := tm.CreateOrAttach(tmxBG, "loginprobe", os.TempDir(), "/bin/zsh", []string{"-l", "-c", "env > " + login + "; sleep 5"}, dot); err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`(?m)^SSH_AUTH_SOCK=/tmp/from-dotfile\.sock$`).MatchString(tmxWaitFile(login)) {
			t.Fatal("a login shell was expected to source the dotfiles")
		}
		if _, err := tm.CreateOrAttach(tmxBG, "plainprobe", os.TempDir(), "/bin/zsh", []string{"-c", "env > " + plain + "; sleep 5"}, dot); err != nil {
			t.Fatal(err)
		}
		if env := tmxWaitFile(plain); env == "" || strings.Contains(env, "SSH_AUTH_SOCK=") {
			t.Fatalf("plain shell env: %q", env)
		}
	})
}

func TestTmux_ShippedShellDocs(t *testing.T) {
	read := func(t *testing.T, name string) []byte {
		b, err := os.ReadFile(filepath.Join("..", name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	t.Run("the shipped shell profile does not start a login shell", func(t *testing.T) {
		var example map[string]struct {
			Args []string `json:"args"`
		}
		if err := json.Unmarshal(read(t, "agents.example.json"), &example); err != nil {
			t.Fatal(err)
		}
		for id, p := range example {
			for _, a := range p.Args {
				if a == "-l" || a == "--login" {
					t.Fatalf("profile %s starts a login shell", id)
				}
			}
		}
	})
	t.Run("the README says the bound is on inheritance, not on what an rc file re-exports", func(t *testing.T) {
		readme := string(read(t, "README.md"))
		if !regexp.MustCompile(`(?i)dotfiles`).MatchString(readme) {
			t.Fatal("the README does not mention dotfiles")
		}
		i := strings.Index(readme, "built, not inherited")
		if i < 0 {
			i = 0
		}
		para := readme[i:]
		if len(para) > 1200 {
			para = para[:1200]
		}
		if !strings.Contains(para, "dotfiles `HOME` points at") {
			t.Fatal("the README does not say a credential in the dotfiles reaches the session")
		}
	})
}

func TestTmux_ForTerminal(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"a line padded to the pane width comes back its own length", "PADDED-A" + strings.Repeat(" ", 32) + "\nPADDED-B" + strings.Repeat(" ", 32), "PADDED-A\r\nPADDED-B"},
		{"lines are separated the way a PTY separates them", "one\ntwo\nthree", "one\r\ntwo\r\nthree"},
		{"a capture that already ends its lines with CR LF is not given a second CR", "one\r\ntwo", "one\r\ntwo"},
		{"a colour that is closed at the end of the line stays closed", "\x1b[32mgreen   \x1b[0m", "\x1b[32mgreen\x1b[0m"},
		{"spaces inside a line are text and are left alone", "a   b   c", "a   b   c"},
		{"spaces inside a line are text and are left alone (indent)", "  indented", "  indented"},
		{"a blank line stays a blank line rather than becoming nothing to join", "one\n    \ntwo", "one\r\n\r\ntwo"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := forTerminal(c.in); got != c.want {
				t.Fatalf("%q, want %q", got, c.want)
			}
		})
	}
	t.Run("what a client wraps is decided by the text, not by the padding", func(t *testing.T) {
		for _, l := range strings.Split(forTerminal("> ask"+strings.Repeat(" ", 35)+"\nanswer"+strings.Repeat(" ", 34)), "\r\n") {
			if len(l) >= 40 {
				t.Fatalf("%q is still padded to the pane width", l)
			}
		}
	})
}

func tmxRunning(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	out, _ := exec.Command("/bin/ps", "-o", "state=", "-p", strconv.Itoa(pid)).Output()
	return !strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}

func tmxPaneOf(tm *Tmux, id string) int {
	panes, _ := tm.PanePids(tmxBG)
	for _, p := range panes {
		if p.SessionID == id {
			return p.PanePid
		}
	}
	return 0
}

func TestTmux_ClosingTakesProcesses(t *testing.T) {
	t.Run("a detached grandchild is killed, where kill-session alone left it running", func(t *testing.T) {
		tm := tmxServer(t, "close")
		if err := tm.EnsureServer(tmxBG); err != nil {
			t.Fatal(err)
		}
		if _, err := tm.CreateOrAttach(tmxBG, "leftover", os.TempDir(), "/bin/sh",
			[]string{"-c", "nohup /bin/sleep 100000 >/dev/null 2>&1 & exec /bin/sleep 200000"},
			map[string]string{"AGENTDECK_SESSION_ID": "leftover"}); err != nil {
			t.Fatal(err)
		}
		pane, child := 0, 0
		for i := 0; i < 100 && child == 0; i++ {
			if pane = tmxPaneOf(tm, "leftover"); pane > 0 {
				out, _ := exec.Command("/usr/bin/pgrep", "-P", strconv.Itoa(pane)).Output()
				child, _ = strconv.Atoi(strings.Split(strings.TrimSpace(string(out)), "\n")[0])
			}
			if child == 0 {
				time.Sleep(50 * time.Millisecond)
			}
		}
		if pane <= 1 || child <= 1 {
			t.Fatal("the fixture never produced a pane with a child")
		}
		t.Cleanup(func() {
			for _, pid := range []int{pane, child} {
				if tmxRunning(pid) {
					_ = syscall.Kill(pid, syscall.SIGKILL)
				}
			}
		})
		if err := tm.Kill(tmxBG, "leftover"); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 100 && (tmxRunning(pane) || tmxRunning(child)); i++ {
			time.Sleep(50 * time.Millisecond)
		}
		if tmxRunning(pane) || tmxRunning(child) {
			t.Fatalf("pane %d or detached child %d survived the close", pane, child)
		}
	})
	t.Run("a session whose name is a PREFIX of another is not touched", func(t *testing.T) {
		tm := tmxServer(t, "prefixkill")
		if err := tm.EnsureServer(tmxBG); err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{"alpha", "alphabet"} {
			if _, err := tm.CreateOrAttach(tmxBG, id, os.TempDir(), "/bin/sleep", []string{"100000"},
				map[string]string{"AGENTDECK_SESSION_ID": id}); err != nil {
				t.Fatal(err)
			}
		}
		survivor := tmxPaneOf(tm, "alphabet")
		if survivor <= 1 {
			t.Fatal("the session that must survive never started")
		}
		if err := tm.Kill(tmxBG, "alpha"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(300 * time.Millisecond)
		if !tmxRunning(survivor) {
			t.Fatalf("closing alpha killed alphabet's pane %d", survivor)
		}
	})
}

func TestTmux_FieldSeparatorRenderings(t *testing.T) {
	for label, s := range map[string]string{"the raw byte": sep, "the octal escape": `\037`} {
		t.Run("list() reads a session written with "+label, func(t *testing.T) {
			got, err := tmxList(t, strings.Join([]string{"agentdeck-shell-abc", "0", "", "1700000000", "/repo/a"}, s))
			if err != nil || len(got) != 1 || got[0].ID != "agentdeck-shell-abc" || got[0].Path != "/repo/a" ||
				got[0].Dead || got[0].StartedAt != 1_700_000_000_000 {
				t.Fatalf("%+v %v", got, err)
			}
		})
		t.Run("panePids() reads a pane written with "+label, func(t *testing.T) {
			fk := tmxNewFake(map[string]any{"list-panes": "agentdeck-shell-abc" + s + "4242"})
			got, err := fk.tmux.PanePids(tmxBG)
			tmxEqual(t, got, []PaneRef{{"agentdeck-shell-abc", 4242}}, "panes")
			if err != nil {
				t.Fatal(err)
			}
		})
		t.Run("describe() reads a pane written with "+label, func(t *testing.T) {
			fk := tmxNewFake(map[string]any{"display-message": "/repo/a" + s + "1700000000"})
			path, at, ok := fk.tmux.Describe(tmxBG, "agentdeck-shell-abc")
			if !ok || path != "/repo/a" || at != 1_700_000_000_000 {
				t.Fatal(path, at, ok)
			}
		})
		t.Run("a dead session keeps its exit code with "+label, func(t *testing.T) {
			got, _ := tmxList(t, strings.Join([]string{"agentdeck-shell-abc", "1", "7", "1700000000", "/repo/a"}, s))
			if len(got) != 1 || !got[0].Dead || got[0].ExitCode == nil || *got[0].ExitCode != 7 {
				t.Fatalf("%+v", got)
			}
		})
	}
	t.Run("a path shaped like the escape costs that path alone, never the fields before it", func(t *testing.T) {
		got, err := tmxList(t, strings.Join([]string{"agentdeck-shell-abc", "0", "", "1700000000", `/repo/lit\037eral`}, `\037`))
		if err != nil || len(got) != 1 || got[0].ID != "agentdeck-shell-abc" || got[0].Dead ||
			got[0].StartedAt != 1_700_000_000_000 || got[0].Path == "" {
			t.Fatalf("%+v %v", got, err)
		}
	})
}

// --- src/pty.test.ts ---

// tmxSpawned is what newSessionPTY asked to start, before the test swaps in a stand-in program.
type tmxSpawned struct {
	args []string
	env  []string
	size pty.Winsize
}

// tmxBuildPTY attaches a sessionPTY whose process is replaced by script under /bin/sh.
func tmxBuildPTY(t *testing.T, script string) (*sessionPTY, *tmxSpawned) {
	t.Helper()
	got := &tmxSpawned{}
	orig := startPTY
	startPTY = func(cmd *exec.Cmd, ws *pty.Winsize) (*os.File, error) {
		got.args, got.env, got.size = append([]string(nil), cmd.Args...), cmd.Env, *ws
		cmd.Path, cmd.Args = "/bin/sh", []string{"sh", "-c", script}
		return orig(cmd, ws)
	}
	p, err := newSessionPTY("test", "web-claude-abc", 80, 24)
	startPTY = orig
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Dispose)
	return p, got
}

func tmxUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("timed out waiting for " + what)
}

func tmxExited(p *sessionPTY) func() bool {
	return func() bool { st, _ := p.stream.State(); return st == StateExited }
}

func TestTmux_PTYWhatGetsSpawned(t *testing.T) {
	_, got := tmxBuildPTY(t, "exec sleep 30")
	t.Run("attaches to an existing session rather than creating one", func(t *testing.T) {
		if got.args[0] != "tmux" || !contains(got.args, "attach-session") || contains(got.args, "new-session") {
			t.Fatal(got.args)
		}
	})
	t.Run("passes -d, so tmux does not size the pane over clients we do not control", func(t *testing.T) {
		if !contains(got.args, "-d") {
			t.Fatal(got.args)
		}
	})
	t.Run("names the socket and the session", func(t *testing.T) {
		tmxEqual(t, got.args[1:3], []string{"-L", "test"}, "socket")
		if got.args[len(got.args)-1] != "=web-claude-abc" {
			t.Fatal(got.args)
		}
	})
	t.Run("opens at the size it was given", func(t *testing.T) {
		if got.size.Cols != 80 || got.size.Rows != 24 {
			t.Fatal(got.size)
		}
	})
	t.Run("attaches with a built environment, not this process's", func(t *testing.T) {
		if len(got.env) == 0 {
			t.Fatal("the attach inherited this process's whole environment")
		}
		for _, kv := range got.env {
			if name := strings.SplitN(kv, "=", 2)[0]; !contains(baseEnvNames, name) {
				t.Fatalf("%s is not on the list", name)
			}
		}
	})
}

func TestTmux_PTYOutputReachesTheStream(t *testing.T) {
	t.Run("bytes are counted as bytes, not as characters", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "printf '日本語'; exec sleep 30")
		tmxUntil(t, "output", func() bool { _, head := p.stream.Buffered(); return head >= 9 })
		if data, head := p.stream.Buffered(); head != 9 || string(data) != "日本語" {
			t.Fatalf("%q at %d", data, head)
		}
	})
	t.Run("sustained output makes the session working", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "printf '%0200d' 0; exec sleep 30")
		tmxUntil(t, "working", func() bool { st, _ := p.stream.State(); return st == StateWorking })
	})
	t.Run("output flows with nobody attached", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "printf '%0200d' 0; exec sleep 30")
		if p.stream.MinRows() != 0 {
			t.Fatal("a client is attached")
		}
		tmxUntil(t, "working", func() bool { st, _ := p.stream.State(); return st == StateWorking })
	})
}

func TestTmux_PTYExitIsDefinitive(t *testing.T) {
	t.Run("the exit code reaches the stream", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "exit 137")
		tmxUntil(t, "exit", tmxExited(p))
		if _, code := p.stream.State(); code == nil || *code != 137 {
			t.Fatal(code)
		}
	})
	t.Run("bytes draining out of a dead pane do not resurrect it", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "exit 1")
		tmxUntil(t, "exit", tmxExited(p))
		p.stream.Write([]byte(strings.Repeat("z", 500)))
		if st, _ := p.stream.State(); st != StateExited {
			t.Fatal(st)
		}
	})
	t.Run("exit code zero is still an exit", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "exit 0")
		tmxUntil(t, "exit", tmxExited(p))
		if _, code := p.stream.State(); code == nil || *code != 0 {
			t.Fatal(code)
		}
	})
}

func TestTmux_PTYInputResizeDisposal(t *testing.T) {
	t.Run("input is passed through untouched", func(t *testing.T) {
		out := filepath.Join(t.TempDir(), "in")
		p, _ := tmxBuildPTY(t, "stty raw -echo; printf R; head -c 7 > "+out+"; exec sleep 30")
		tmxUntil(t, "ready", func() bool { d, _ := p.stream.Buffered(); return strings.Contains(string(d), "R") })
		p.Write([]byte("ls -la\r"))
		tmxUntil(t, "input", func() bool { b, _ := os.ReadFile(out); return len(b) == 7 })
		if b, _ := os.ReadFile(out); string(b) != "ls -la\r" {
			t.Fatalf("%q", b)
		}
	})
	t.Run("resize reaches the pty", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "exec sleep 30")
		p.Resize(120, 40)
		p.mu.Lock()
		rows, cols, err := pty.Getsize(p.master)
		p.mu.Unlock()
		if err != nil || cols != 120 || rows != 40 {
			t.Fatal(cols, rows, err)
		}
	})
	t.Run("a resize racing a dying agent does not throw", func(t *testing.T) {
		p, _ := tmxBuildPTY(t, "exit 0")
		tmxUntil(t, "exit", tmxExited(p))
		p.Resize(80, 24)
	})
	t.Run("dispose detaches without killing the agent", func(t *testing.T) {
		tm := tmxServer(t, "dispose")
		if _, err := tm.CreateOrAttach(tmxBG, "keep", os.TempDir(), "/bin/sleep", []string{"100000"}, nil); err != nil {
			t.Fatal(err)
		}
		p, err := newSessionPTY(tm.Socket, "keep", 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		tmxUntil(t, "the client to attach", func() bool {
			out, _ := tm.run(tmxBG, "list-clients", "-t", "=keep", "-F", "#{client_tty}")
			return strings.TrimSpace(out) != ""
		})
		p.Dispose()
		if !p.disposed {
			t.Fatal("not marked disposed")
		}
		tmxUntil(t, "the client to detach", func() bool {
			out, _ := tm.run(tmxBG, "list-clients", "-t", "=keep", "-F", "#{client_tty}")
			return strings.TrimSpace(out) == ""
		})
		list, _ := tm.List(tmxBG)
		if len(list) != 1 || list[0].ID != "keep" || list[0].Dead {
			t.Fatalf("the agent did not survive the detach: %+v", list)
		}
	})
	t.Run("dispose is idempotent, and silences later writes", func(t *testing.T) {
		out := filepath.Join(t.TempDir(), "in")
		p, _ := tmxBuildPTY(t, "stty raw -echo; printf R; cat > "+out)
		tmxUntil(t, "ready", func() bool { d, _ := p.stream.Buffered(); return strings.Contains(string(d), "R") })
		p.Dispose()
		p.Dispose()
		p.Write([]byte("too late"))
		p.Resize(10, 10)
		time.Sleep(100 * time.Millisecond)
		if b, _ := os.ReadFile(out); len(b) != 0 {
			t.Fatalf("a write after dispose arrived: %q", b)
		}
	})
}

// --- src/pane-modes.test.ts ---

func TestTmux_PaneModes(t *testing.T) {
	t.Run("an agent on the alternate screen tracking every motion in SGR", func(t *testing.T) {
		if m := readPaneModes("10011\n"); m != (PaneModes{true, 1003, true}) {
			t.Fatal(m)
		}
	})
	t.Run("a shell has set none of them", func(t *testing.T) {
		if m := readPaneModes("00000"); m != (PaneModes{}) {
			t.Fatal(m)
		}
	})
	t.Run("the highest tracking mode wins, since it reports what the lower ones do", func(t *testing.T) {
		for in, want := range map[string]int{"01110": 1003, "01100": 1002, "01000": 1000} {
			if got := readPaneModes(in).Tracking; got != want {
				t.Fatal(in, got)
			}
		}
	})
	t.Run("an answer that is not five digits sets nothing rather than guessing", func(t *testing.T) {
		for _, in := range []string{"", "Tailscale.CLIError", "1001"} {
			if m := readPaneModes(in); m != (PaneModes{}) {
				t.Fatal(in, m)
			}
		}
	})
	t.Run("the alternate screen comes first, so the screen below lands in it", func(t *testing.T) {
		if b := modeBytes(PaneModes{true, 1003, true}); b != "\x1b[?1049h\x1b[?1003h\x1b[?1006h" {
			t.Fatalf("%q", b)
		}
	})
	t.Run("a shell's snapshot carries no modes at all", func(t *testing.T) {
		if b := modeBytes(PaneModes{}); b != "" {
			t.Fatalf("%q", b)
		}
	})
}

// --- src/session-id.test.ts ---

func TestTmux_SessionID(t *testing.T) {
	t.Run("is a pure function of (path, agent), so it survives a restart", func(t *testing.T) {
		if sessionID("/workspace/agentdeck", "claude") != sessionID("/workspace/agentdeck", "claude") {
			t.Fatal("not pure")
		}
	})
	t.Run("two checkouts with the same basename under different parents do not collide", func(t *testing.T) {
		a, b := sessionID("/workspace/acme/web", "claude"), sessionID("/workspace/other/web", "claude")
		if a == b || !strings.HasPrefix(a, "web-claude-") || !strings.HasPrefix(b, "web-claude-") {
			t.Fatal(a, b)
		}
	})
	t.Run("the same path under two agents produces two ids", func(t *testing.T) {
		if sessionID("/workspace/agentdeck", "claude") == sessionID("/workspace/agentdeck", "gemini") {
			t.Fatal("collided")
		}
	})
	t.Run("the same path and agent produce the same id, so -A reattaches", func(t *testing.T) {
		if sessionID("/workspace/agentdeck", "claude") != sessionID("/workspace/agentdeck", "claude") {
			t.Fatal("differ")
		}
	})
	t.Run("characters tmux rejects never reach the name", func(t *testing.T) {
		for _, cwd := range []string{"/workspace/my.repo", "/workspace/host:port", "/workspace/a b"} {
			if id := sessionID(cwd, "claude"); regexp.MustCompile(`[.:\s]`).MatchString(id) {
				t.Fatal(id)
			}
		}
	})
	t.Run("names differing only in punctuation still produce different ids", func(t *testing.T) {
		if sessionID("/workspace/my.repo", "claude") == sessionID("/workspace/my-repo", "claude") {
			t.Fatal("folded together")
		}
	})
	t.Run("a path with nothing left after sanitising still yields a usable name", func(t *testing.T) {
		if id := sessionID("/", "claude"); id == "" || strings.HasPrefix(id, "-") {
			t.Fatal(id)
		}
	})
	t.Run("the tab shows the unsanitised basename", func(t *testing.T) {
		if n := sessionName("/workspace/my.repo"); n != "my.repo" {
			t.Fatal(n)
		}
	})
}
