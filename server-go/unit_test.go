package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Properties carried over from the TS suite, plus parity values computed from the TS code itself.

func TestSessionIDMatchesTheTypeScriptServer(t *testing.T) {
	// A Go server must recognise the sessions a TS server left in tmux, so the ids are byte-identical.
	cases := [][3]string{
		{"/Users/x/ghq/github.com/o/agentdeck", "claude", "agentdeck-claude-e2f1b229"},
		{"/", "sh", "repo-sh-8a5edab2"},
		{"/tmp/my.repo:v2", "co dex", "my-repo-v2-co-dex-67bc365a"},
		{"/a/-lead-", ".x.", "lead-x-11c71a58"},
		{"/a/日本", "claude", "repo-claude-454229a6"},
	}
	for _, c := range cases {
		if got := sessionID(c[0], c[1]); got != c[2] {
			t.Errorf("sessionID(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestHookSecretMatchesTheTypeScriptServer(t *testing.T) {
	// An agent started by the TS server holds this value; a Go restart must derive the same one.
	if got := secretFor("k3y", "agentdeck-claude-1234abcd"); got != "di03noPHJbuJ2Gx1u1YfaumNL3mcR5dypTrcnD0OLxU" {
		t.Fatalf("secretFor = %q", got)
	}
}

func TestForTerminalMatchesTheTypeScriptServer(t *testing.T) {
	if got := forTerminal("a  \nb\x1b[0m  \x1b[31m\r\nc"); got != "a\r\nb\x1b[0m\x1b[31m\r\nc" {
		t.Fatalf("forTerminal = %q", got)
	}
}

func TestRingBufferCoverage(t *testing.T) {
	b := newRingBuffer("e1", 10)
	b.append([]byte("hello"))
	b.append([]byte("world!!"))
	if b.headSeq != 12 || b.tailSeq() != 2 {
		t.Fatalf("head %d tail %d", b.headSeq, b.tailSeq())
	}
	if !b.covers("e1", 2, true) || b.covers("e1", 1, true) || b.covers("e1", 13, true) {
		t.Fatal("coverage must be exactly tail..head")
	}
	if b.covers("other", 5, true) || b.covers("e1", 5, false) {
		t.Fatal("a different epoch or no seq is never covered")
	}
	if got := string(b.since(5)); got != "world!!" {
		t.Fatalf("since(5) = %q", got)
	}
	if string(b.snapshot()) != "lloworld!!" {
		t.Fatalf("snapshot = %q", b.snapshot())
	}
}

func TestStreamState(t *testing.T) {
	s := newStream("x")
	if st, _ := s.State(); st != StateIdle {
		t.Fatalf("fresh stream is %s", st)
	}
	s.Write([]byte("a"))
	if st, _ := s.State(); st != StateIdle {
		t.Fatal("one echoed keystroke is not working")
	}
	s.Write([]byte(strings.Repeat("x", 200)))
	if st, _ := s.State(); st != StateWorking {
		t.Fatal("sustained output is working")
	}
	s.Declare(StateWaiting, nil)
	if st, _ := s.State(); st != StateWaiting {
		t.Fatal("a declared state outranks cadence")
	}
	s.Write([]byte("more"))
	if st, _ := s.State(); st == StateWaiting {
		t.Fatal("output contradicts waiting")
	}
	code := 137
	s.Declare(StateExited, &code)
	s.Write([]byte(strings.Repeat("z", 500)))
	s.Declare(StateWorking, nil)
	if st, c := s.State(); st != StateExited || c == nil || *c != 137 {
		t.Fatal("exited is sticky and keeps its code")
	}
}

func TestStreamRowsAreTheMinimumOverAttachedClients(t *testing.T) {
	s := newStream("x")
	if s.MinRows() != 0 {
		t.Fatal("nobody attached resizes nothing")
	}
	s.Attach("a", 50, 40)
	s.Attach("b", 50, 20)
	s.Resize("ghost", 50, 5)
	if s.MinRows() != 20 {
		t.Fatalf("min rows %d", s.MinRows())
	}
	s.Detach("b")
	if s.MinRows() != 40 {
		t.Fatal("a detached tab stops constraining the pane")
	}
}

func TestCompleteUTF8HoldsBackASplitCharacter(t *testing.T) {
	full := []byte("ab日")
	for cut := 3; cut < len(full); cut++ {
		if got := completeUTF8(full[:cut]); got != 2 {
			t.Errorf("prefix %d: complete %d, want 2", cut, got)
		}
	}
	if completeUTF8(full) != len(full) {
		t.Fatal("a complete string is complete")
	}
}

func TestParseClientMessage(t *testing.T) {
	bad := map[string]string{
		`nope`:          "message is not JSON",
		`[1]`:           "message is not an object",
		`{"t":"input"}`: "message has no sessionId",
		`{"t":"attach","sessionId":"s","cols":0,"rows":5}`:   "attach needs integer cols and rows between 1 and 1000",
		`{"t":"resize","sessionId":"s","cols":2.5,"rows":5}`: "resize needs integer cols and rows between 1 and 1000",
		`{"t":"input","sessionId":"s","data":1}`:             "input needs string data",
		`{"t":"resync","sessionId":"s","haveEpoch":"e"}`:     "resync needs haveEpoch and an integer haveSeq",
		`{"t":"boom","sessionId":"s"}`:                       "unknown message type: boom",
		`{"sessionId":"s"}`:                                  "unknown message type: undefined",
	}
	for raw, want := range bad {
		if m, got := parseClientMessage([]byte(raw)); m != nil || got != want {
			t.Errorf("%s: got %q, want %q", raw, got, want)
		}
	}
	m, _ := parseClientMessage([]byte(`{"t":"attach","sessionId":"s","cols":50,"rows":30,"haveSeq":4}`))
	if m == nil || m.HasPos {
		t.Fatal("a seq without an epoch is no position at all")
	}
	m, _ = parseClientMessage([]byte(`{"t":"attach","sessionId":"s","cols":50,"rows":30,"haveEpoch":"e","haveSeq":4}`))
	if m == nil || !m.HasPos || m.HaveSeq != 4 {
		t.Fatal("epoch and seq travel together")
	}
}

func TestAllowlistIsExactMembership(t *testing.T) {
	a := newAllowlist([]string{"/workspace/repo/"}, nil)
	if !a.Allows("/workspace/repo") || a.Allows("/workspace/repo-secrets") || a.Allows("") || a.Allows("/workspace") {
		t.Fatal("membership is exact, normalised, and never the empty path")
	}
}

func TestScanReposStopsAtARepository(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"h/o/a/.git", "h/o/a/vendor/b/.git", "h/.hidden/c/.git", "h/o/d"} {
		_ = os.MkdirAll(filepath.Join(root, d), 0o755)
	}
	_ = os.WriteFile(filepath.Join(root, "h/o/d/.git"), []byte("gitdir: x"), 0o644)
	got := scanRepos([]string{root}, 4)
	want := []string{filepath.Join(root, "h/o/a"), filepath.Join(root, "h/o/d")}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("scan = %v, want %v", got, want)
	}
}

func TestParseProfilesRejectsOneProfileNotTheFile(t *testing.T) {
	profiles, rejected := parseProfiles([]byte(`{
		"claude": {"command": "claude", "args": ["--x"], "env": ["HOME"], "waiting": {"via": "hook", "settings": "claude/settings.json"}},
		"broken": {"args": []},
		"climb": {"command": "sh", "waiting": {"via": "hook", "settings": "../../etc/x"}}
	}`))
	if len(profiles) != 2 || len(rejected) != 1 || rejected[0].ID != "broken" {
		t.Fatalf("profiles %v rejected %v", profiles, rejected)
	}
	if profiles["climb"].Waiting != nil || profiles["climb"].WaitingDisabledReason == "" {
		t.Fatal("a climbing settings path disables the mechanism, not the profile")
	}
	if profiles["claude"].Name != "claude" || profiles["claude"].Waiting.Settings != "claude/settings.json" {
		t.Fatal("name defaults to the id")
	}
}

func TestMapHookEvent(t *testing.T) {
	cases := map[string]SessionState{
		`{"hook_event_name":"PreToolUse"}`:                               StateWorking,
		`{"hook_event_name":"Stop"}`:                                     StateWaiting,
		`{"hook_event_name":"Notification","notification_type":"novel"}`: StateWaiting,
		`{"hook_event_name":"Notification"}`:                             StateWaiting,
		`{"hook_event_name":"SubagentStop"}`:                             "",
		`{"hook_event_name":"Unheard"}`:                                  "",
		`[]`:                                                             "",
	}
	for raw, want := range cases {
		var p any
		_ = json.Unmarshal([]byte(raw), &p)
		if got, _ := mapHookEvent(p); got != want {
			t.Errorf("%s: %q, want %q", raw, got, want)
		}
	}
}

func TestMergeHookSettingsIsIdempotentAndKeepsStrangers(t *testing.T) {
	cmd, err := hookCommand(7777, "/opt/agentdeck/bin/agentdeck")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hookCommand(7777, "agentdeck"); err == nil {
		t.Fatal("a relative interpreter is refused")
	}
	oldNodeHook := `[ -n "$AGENTDECK_SESSION_ID" ] || exit 0; '/usr/bin/node' -e 'path:"/api/hooks/"' >/dev/null 2>&1; exit 0`
	var existing any
	_ = json.Unmarshal([]byte(`{"model":"x","hooks":{"Stop":[
		{"hooks":[{"type":"command","command":"my-guard /api/hooks/ check"}]},
		{"hooks":[{"type":"command","command":`+jsonString(oldNodeHook)+`}]}
	]}}`), &existing)
	first := mergeHookSettings(existing, cmd)
	second := mergeHookSettings(first, cmd)
	a, _ := jsonIndent(first)
	b, _ := jsonIndent(second)
	if a != b {
		t.Fatal("a second merge changes nothing")
	}
	if !strings.Contains(a, "my-guard") || strings.Contains(a, "/usr/bin/node") || !strings.Contains(a, `"model": "x"`) {
		t.Fatalf("stranger kept, old node hook replaced, other keys preserved:\n%s", a)
	}
	if strings.Count(a, "/opt/agentdeck/bin/agentdeck") != len(installedEvents) {
		t.Fatal("exactly one of ours per event")
	}
	if strings.Contains(cmd, "AGENTDECK_SECRET=") {
		t.Fatal("the secret never appears in the command line")
	}
	// Run the line through a real shell: it must exit 0 and print nothing, even when the hook fails.
	failing := strings.Replace(cmd, "'/opt/agentdeck/bin/agentdeck'", "'/bin/sh' -c 'echo LOUD; exit 7' --", 1)
	out, err := exec.Command("/bin/sh", "-c", failing).CombinedOutput()
	if err != nil || len(out) != 0 {
		t.Fatalf("hook line must swallow output and exit 0: err=%v out=%q", err, out)
	}
	if out, _ := exec.Command("/bin/sh", "-c", cmd).CombinedOutput(); len(out) != 0 {
		t.Fatal("without AGENTDECK_SESSION_ID the line does nothing")
	}
}

func jsonString(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestUploadsChooseTheirOwnNameAndPrune(t *testing.T) {
	u := newUploadStore(t.TempDir())
	u.keep = 3
	if _, err := u.Save("s", "text/html", []byte("x")); err == nil {
		t.Fatal("only safelisted image types are written")
	}
	var last string
	for i := 0; i < 5; i++ {
		p, err := u.Save("../../evil", "image/PNG; charset=x", []byte{byte(i)})
		if err != nil {
			t.Fatal(err)
		}
		last = p
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.HasPrefix(last, u.root) || !strings.HasSuffix(last, ".png") {
		t.Fatalf("path %s escaped the root or kept a client name", last)
	}
	entries, _ := os.ReadDir(filepath.Dir(last))
	if len(entries) != 3 {
		t.Fatalf("kept %d, want 3", len(entries))
	}
	if info, _ := os.Stat(last); info.Mode().Perm() != 0o600 {
		t.Fatal("uploads are 0600")
	}
}

func TestProcessTreeAndEtime(t *testing.T) {
	if parseEtime("1-02:03:04") != 93784 || parseEtime("05:06") != 306 || parseEtime("x") != -1 {
		t.Fatal("etime parse")
	}
	rows := parseProcessTable("  10 1 00:10 100 0.0 tmux\n  11 10 00:09 200 1.5 claude\n  12 11 00:01 300 0.0 python x.py\n  13 1 00:01 1 0.0 other\n")
	tree := treeOf(rows, 10)
	if len(tree) != 3 || tree[2].Pid != 12 || tree[2].Depth != 2 {
		t.Fatalf("tree %+v", tree)
	}
	sp := sessionProcesses([]PaneRef{{"s", 11}}, rows)
	if sp[0].ChildCount != 1 || sp[0].ChildRssKb != 300 {
		t.Fatalf("children %+v", sp[0])
	}
}

func TestEndTreeSignalsDeepestFirst(t *testing.T) {
	var order []int
	dead := map[int]bool{}
	signal := func(pid int, s syscall.Signal) error { order = append(order, pid); dead[pid] = true; return nil }
	state := func(pid int) string {
		if dead[pid] {
			return "Z"
		}
		return "S"
	}
	// finished() asks the kernel first, so use this process's own pid range-safe stand-ins.
	self := os.Getpid()
	parent := os.Getppid()
	survivors := endTree([]int{parent, self}, endTreeOptions{grace: time.Millisecond, state: state, signal: signal})
	if len(survivors) != 0 || len(order) != 2 || order[0] != self || order[1] != parent {
		t.Fatalf("order %v survivors %v", order, survivors)
	}
}

func TestTailnetAdvice(t *testing.T) {
	tn, err := parseTailnetStatus([]byte(`{"Self":{"DNSName":"mac.tail1.ts.net."},"CertDomains":["mac.tail1.ts.net"]}`))
	if err != nil || tn.Origin != "https://mac.tail1.ts.net" || !tn.HTTPSCertificates {
		t.Fatalf("%+v %v", tn, err)
	}
	lines := strings.Join(tailnetAdvice(tn, 7777, "https://elsewhere"), "\n")
	if !strings.Contains(lines, "tailscale serve --bg 7777") || !strings.Contains(lines, "403") {
		t.Fatal(lines)
	}
	off, _ := parseTailnetStatus([]byte(`{"Self":{"DNSName":""},"CertDomains":null}`))
	if lines := strings.Join(tailnetAdvice(off, 7777, ""), "\n"); !strings.Contains(lines, "MagicDNS") || !strings.Contains(lines, "DISABLED") {
		t.Fatal(lines)
	}
}

func TestTokenIsWireSafeAndComparedExactly(t *testing.T) {
	tok := generateToken()
	if !isWireSafe(tok) || len(tok) != 43 {
		t.Fatalf("token %q", tok)
	}
	if !tokenMatches(tok, tok) || tokenMatches(tok[:42], tok) || tokenMatches(tok+"x", tok) {
		t.Fatal("exact match only")
	}
	if bearerFrom("Bearer abc") != "abc" || bearerFrom("bearer abc") != "" || bearerFrom("Bearer a b") != "" {
		t.Fatal("bearer parse")
	}
}

func TestTokenInsideAllowlistFollowsALinkPlantedAtTheLeaf(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	_ = os.MkdirAll(repo, 0o755)
	link := filepath.Join(dir, "token")
	_ = os.Symlink(filepath.Join(repo, "not-yet"), link)
	if tokenInsideAllowlist(link, []string{repo}) != repo {
		t.Fatal("a dangling link into a repo still lands in the repo")
	}
	if tokenInsideAllowlist(filepath.Join(dir, "repo-secrets", "t"), []string{repo}) != "" {
		t.Fatal("a sibling sharing a prefix is not inside")
	}
}

func TestSummariseReap(t *testing.T) {
	if s := summariseReap(`{"orphans":[],"emptyServers":[]}`, "", 0); !s.ok || s.summary != "" {
		t.Fatal("nothing to do is silent")
	}
	s := summariseReap(`{"orphans":[{"treeSize":3}],"emptyServers":[{}],"staleSockets":2,"reclaimedKb":2048}`, "", 0)
	if s.summary != "reaped 1 orphan tree(s) (3 process(es)), 1 empty tmux server(s), 2 dead socket file(s), about 2MB" {
		t.Fatal(s.summary)
	}
	if s := summariseReap("", "boom\n", 2); s.ok || !strings.Contains(s.summary, "exited 2") {
		t.Fatal(s.summary)
	}
}
