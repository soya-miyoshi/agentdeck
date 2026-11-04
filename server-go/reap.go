package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Port of scripts/reap.mjs as `agentdeck reap [--kill] [--json]`. Reports by default; why each
// predicate is what it is lives in audit.md's reaper entry.

const lsofPath = "/usr/sbin/lsof"

type reapConfig struct {
	kill, jsonOut    bool
	minAge           time.Duration
	toolTimeout      time.Duration
	stopGrace        time.Duration
	port             string
	liveSocket       string
	socketPrefix     string
	spareListeners   bool
	reapPaneChildren bool
	keep             *regexp.Regexp
	roots            []string
	tmuxDir          string
	selfCommands     []string
}

func envMs(name string, fallback time.Duration) time.Duration {
	if n, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Millisecond))
	}
	return fallback
}

func getenv(name, fallback string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return fallback
}

func reapConfigFromEnv(args []string, stderr io.Writer) reapConfig {
	c := reapConfig{
		kill: contains(args, "--kill"), jsonOut: contains(args, "--json"),
		minAge:           envMs("AGENTDECK_REAP_MIN_AGE_MS", time.Hour),
		toolTimeout:      envMs("AGENTDECK_REAP_TOOL_TIMEOUT_MS", 5*time.Second),
		stopGrace:        envMs("AGENTDECK_REAP_STOP_GRACE_MS", 5*time.Second),
		port:             getenv("AGENTDECK_PORT", "7777"),
		liveSocket:       getenv("TMUX_SOCKET", "agentdeck"),
		socketPrefix:     getenv("AGENTDECK_REAP_SOCKET_PREFIX", "agentdeck-"),
		spareListeners:   os.Getenv("AGENTDECK_REAP_SPARE_LISTENERS") == "1",
		reapPaneChildren: getenv("AGENTDECK_REAP_PANE_CHILDREN", "1") != "0",
		tmuxDir:          filepath.Join(getenv("TMUX_TMPDIR", "/private/tmp"), fmt.Sprintf("tmux-%d", os.Getuid())),
		selfCommands:     []string{filepath.Join("src", "server.ts")},
	}
	if exe, err := os.Executable(); err == nil {
		c.selfCommands = append(c.selfCommands, exe)
	}
	pattern := getenv("AGENTDECK_REAP_KEEP", "mcp|modelcontextprotocol")
	keep, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		fmt.Fprintf(stderr, "agentdeck-reap: AGENTDECK_REAP_KEEP is not a valid regular expression (%q); falling back to the default rather than sparing nothing.\n", pattern)
		keep = regexp.MustCompile("(?i)mcp|modelcontextprotocol")
	}
	c.keep = keep
	for _, v := range []string{os.Getenv("AGENTDECK_ROOTS"), os.Getenv("AGENTDECK_MOUNTS")} {
		for _, e := range strings.Split(v, ":") {
			if e != "" {
				c.roots = append(c.roots, resolvePath(e))
			}
		}
	}
	return c
}

type reapRow struct {
	pid, ppid int
	tty       string
	age       time.Duration
	rssKb     int
	command   string
}

func (c reapConfig) sh(file string, args ...string) (stdout, stderr string, failed bool) {
	ctx, cancel := context.WithTimeout(context.Background(), c.toolTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, file, args...)
	var o, e strings.Builder
	cmd.Stdout, cmd.Stderr = &o, &e
	err := cmd.Run()
	return o.String(), e.String(), err != nil
}

var reapLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$`)

func (c reapConfig) processTable() []reapRow {
	out, _, failed := c.sh(psPath, "-Ao", "pid=,ppid=,tty=,etime=,rss=,command=")
	if failed {
		return nil
	}
	var rows []reapRow
	for _, line := range strings.Split(out, "\n") {
		m := reapLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		ppid, _ := strconv.Atoi(m[2])
		rss, _ := strconv.Atoi(m[5])
		age := time.Duration(-1)
		if s := parseEtime(m[4]); s >= 0 {
			age = time.Duration(s) * time.Second
		}
		rows = append(rows, reapRow{pid, ppid, m[3], age, rss, m[6]})
	}
	return rows
}

func under(roots []string, path string) bool {
	if path == "" {
		return false
	}
	for _, r := range roots {
		if path == r || strings.HasPrefix(path, r+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func (c reapConfig) cwdsOf(pids []int) map[int]string {
	found := map[int]string{}
	if len(pids) == 0 {
		return found
	}
	list := make([]string, len(pids))
	for i, p := range pids {
		list[i] = strconv.Itoa(p)
	}
	out, _, _ := c.sh(lsofPath, "-a", "-d", "cwd", "-Fpn", "-p", strings.Join(list, ","))
	current := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "p") {
			current, _ = strconv.Atoi(line[1:])
		} else if strings.HasPrefix(line, "n") && current > 0 {
			found[current] = line[1:]
		}
	}
	return found
}

// pidsListening returns nil, false when lsof could not be asked, which is not "nothing listens".
func (c reapConfig) pidsListening(args ...string) ([]int, bool) {
	out, _, failed := c.sh(lsofPath, append([]string{"-nP"}, args...)...)
	var pids []int
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if n, err := strconv.Atoi(strings.TrimSpace(l)); err == nil && n > 1 {
			pids = append(pids, n)
		}
	}
	if failed && len(pids) == 0 {
		return nil, false
	}
	return pids, true
}

func childMap(rows []reapRow) map[int][]int {
	m := map[int][]int{}
	for _, r := range rows {
		m[r.ppid] = append(m[r.ppid], r.pid)
	}
	return m
}

func descendants(children map[int][]int, root int) []int {
	seen := map[int]bool{root: true}
	out := []int{root}
	stack := []int{root}
	for len(stack) > 0 {
		next := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, ch := range children[next] {
			if !seen[ch] {
				seen[ch] = true
				out = append(out, ch)
				stack = append(stack, ch)
			}
		}
	}
	return out
}

func alive(pid int) bool { return pid > 1 && syscall.Kill(pid, 0) == nil }

func (c reapConfig) gone(pid int) bool {
	if !alive(pid) {
		return true
	}
	out, _, failed := c.sh(psPath, "-o", "state=", "-p", strconv.Itoa(pid))
	return !failed && strings.HasPrefix(strings.TrimSpace(out), "Z")
}

func (c reapConfig) stop(pid int) bool {
	if !alive(pid) {
		return true
	}
	if syscall.Kill(pid, syscall.SIGTERM) != nil {
		return true
	}
	deadline := time.Now().Add(c.stopGrace)
	for time.Now().Before(deadline) {
		if c.gone(pid) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	return c.gone(pid)
}

var tmuxCommand = regexp.MustCompile(`(?:^|/)tmux(?:\s|$)`)
var socketFlag = regexp.MustCompile(`\s-L\s+(\S+)`)

type orphanTree struct {
	reapRow
	cwd    string
	tree   []int
	treeKb int
}

func (c reapConfig) orphans(rows []reapRow, spared map[int]bool, serving map[int]bool, servingKnown bool) ([]orphanTree, bool) {
	if !servingKnown {
		return nil, false
	}
	children := childMap(rows)
	var idle []reapRow
	for _, r := range rows {
		if r.pid <= 1 || r.pid == os.Getpid() || r.ppid != 1 || r.tty != "??" || r.age < c.minAge || spared[r.pid] || tmuxCommand.MatchString(r.command) {
			continue
		}
		self := false
		for _, s := range c.selfCommands {
			self = self || strings.Contains(r.command, s)
		}
		if self {
			continue
		}
		serves := false
		for _, p := range descendants(children, r.pid) {
			serves = serves || serving[p]
		}
		if !serves {
			idle = append(idle, r)
		}
	}
	pids := make([]int, len(idle))
	for i, r := range idle {
		pids[i] = r.pid
	}
	cwds := c.cwdsOf(pids)
	byPid := map[int]reapRow{}
	for _, r := range rows {
		byPid[r.pid] = r
	}
	var out []orphanTree
	for _, r := range idle {
		cwd := cwds[r.pid]
		if !under(c.roots, cwd) {
			continue
		}
		var tree []int
		kb := 0
		for _, p := range descendants(children, r.pid) {
			if !spared[p] {
				tree = append(tree, p)
				kb += byPid[p].rssKb
			}
		}
		out = append(out, orphanTree{r, cwd, tree, kb})
	}
	return out, true
}

type paneTree struct {
	pane        int
	paneCommand string
	tree        []reapRow
	kept        []reapRow
	treeKb      int
}

func (c reapConfig) livePanePids() []int {
	out, _, failed := c.sh("tmux", "-L", c.liveSocket, "list-panes", "-a", "-F", "#{pane_pid}")
	if failed {
		return nil
	}
	var pids []int
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if n, err := strconv.Atoi(strings.TrimSpace(l)); err == nil && n > 1 {
			pids = append(pids, n)
		}
	}
	return pids
}

func (c reapConfig) paneChildren(rows []reapRow, spared map[int]bool) []paneTree {
	if !c.reapPaneChildren {
		return nil
	}
	panes := c.livePanePids()
	children := childMap(rows)
	byPid := map[int]reapRow{}
	for _, r := range rows {
		byPid[r.pid] = r
	}
	var found []paneTree
	for _, pane := range panes {
		pt := paneTree{pane: pane, paneCommand: byPid[pane].command}
		for _, p := range descendants(children, pane) {
			if p == pane || p == os.Getpid() || spared[p] {
				continue
			}
			row, ok := byPid[p]
			if !ok || row.age < c.minAge {
				continue
			}
			if c.keep.MatchString(row.command) {
				pt.kept = append(pt.kept, row)
				continue
			}
			pt.tree = append(pt.tree, row)
			pt.treeKb += row.rssKb
		}
		if len(pt.tree) > 0 || len(pt.kept) > 0 {
			found = append(found, pt)
		}
	}
	return found
}

type emptyServer struct {
	reapRow
	socket string
}

func (c reapConfig) holdsNoSessions(socket string) bool {
	out, errOut, failed := c.sh("tmux", "-L", socket, "list-sessions")
	if !failed {
		return strings.TrimSpace(out) == ""
	}
	return regexp.MustCompile(`(?i)no sessions`).MatchString(out + errOut)
}

func (c reapConfig) abandonedServers(rows []reapRow) []emptyServer {
	var found []emptyServer
	for _, r := range rows {
		if !tmuxCommand.MatchString(r.command) || r.age < c.minAge {
			continue
		}
		socket := ""
		if m := socketFlag.FindStringSubmatch(r.command); m != nil {
			socket = m[1]
		}
		if !strings.HasPrefix(socket, c.socketPrefix) || socket == c.liveSocket || !c.holdsNoSessions(socket) {
			continue
		}
		found = append(found, emptyServer{r, socket})
	}
	return found
}

// staleSockets connects rather than infers: a refused connection proves nothing is behind it.
func (c reapConfig) staleSockets() []string {
	entries, err := os.ReadDir(c.tmuxDir)
	if err != nil {
		return nil
	}
	var dead []string
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, c.socketPrefix) || name == c.liveSocket {
			continue
		}
		path := filepath.Join(c.tmuxDir, name)
		info, err := os.Stat(path)
		if err != nil || time.Since(info.ModTime()) < c.minAge {
			continue
		}
		conn, err := net.DialTimeout("unix", path, 250*time.Millisecond)
		if err == nil {
			conn.Close()
			continue
		}
		if opErr, ok := err.(*net.OpError); ok && opErr.Timeout() {
			continue
		}
		dead = append(dead, path)
	}
	return dead
}

func minutes(d time.Duration) string { return fmt.Sprintf("%dm", int((d+30*time.Second)/time.Minute)) }

func short(s string) string {
	if len(s) > 110 {
		return s[:107] + "..."
	}
	return s
}

// runReap is one pass; it returns the process exit code.
func runReap(args []string, stdout, stderr io.Writer) int {
	c := reapConfigFromEnv(args, stderr)
	if len(c.roots) == 0 {
		fmt.Fprintln(stderr, "agentdeck-reap: neither AGENTDECK_ROOTS nor AGENTDECK_MOUNTS is set. Those roots are the "+
			"only thing that tells this tool's garbage apart from every launchd daemon on the machine, "+
			"which look identical without them. Refusing to reap anything. Run it the way `make` starts "+
			"the server: AGENTDECK_ROOTS=\"$(ghq root --all | tr '\\n' ':')\" agentdeck reap")
		return 2
	}
	log := func(format string, a ...any) {
		if !c.jsonOut {
			fmt.Fprintf(stdout, format+"\n", a...)
		}
	}
	rows := c.processTable()
	spared := map[int]bool{}
	if pids, ok := c.pidsListening("-ti", "tcp:"+c.port, "-sTCP:LISTEN"); ok {
		for _, p := range pids {
			spared[p] = true
		}
	}
	serving, servingKnown := map[int]bool{}, true
	if c.spareListeners {
		pids, ok := c.pidsListening("-ti", "-sTCP:LISTEN")
		servingKnown = ok
		for _, p := range pids {
			serving[p] = true
		}
	}
	orphaned, orphansChecked := c.orphans(rows, spared, serving, servingKnown)
	panes := c.paneChildren(rows, spared)
	empty := c.abandonedServers(rows)
	sockets := c.staleSockets()

	mode := "reporting only, pass --kill to act"
	if c.kill {
		mode = "REAPING"
	}
	log("agentdeck-reap: %s", mode)
	log("  roots: %s", strings.Join(c.roots, ", "))
	log("  older than: %s   live socket (spared): %s", minutes(c.minAge), c.liveSocket)

	stopAll := func(pids []int) string {
		var survivors []string
		for i := len(pids) - 1; i >= 0; i-- {
			if !c.stop(pids[i]) {
				survivors = append(survivors, strconv.Itoa(pids[i]))
			}
		}
		if len(survivors) == 0 {
			return fmt.Sprintf("reaped %d process(es)", len(pids))
		}
		return "SURVIVED the kill: " + strings.Join(survivors, ", ")
	}

	reclaimedKb := 0
	if !orphansChecked {
		log("\norphaned processes under a root: NOT CHECKED - could not read what is listening on this machine, and without that a running dev server is indistinguishable from a leftover. The tmux halves below are unaffected.")
	} else {
		log("\norphaned processes under a root: %d", len(orphaned))
	}
	for _, o := range orphaned {
		reclaimedKb += o.treeKb
		extra := ""
		if len(o.tree) > 1 {
			extra = fmt.Sprintf("  (+%d in its tree)", len(o.tree)-1)
		}
		log("  pid %d  %s  %dKB  %s%s", o.pid, minutes(o.age), o.treeKb, o.cwd, extra)
		log("    %s", short(o.command))
		if c.kill {
			log("    -> %s", stopAll(o.tree))
		}
	}

	if c.reapPaneChildren {
		log("\nstarted inside live %s panes: %d pane(s) with something under them (keeping /%s/i)", c.liveSocket, len(panes), strings.TrimPrefix(c.keep.String(), "(?i)"))
	} else {
		log("\nstarted inside live %s panes: NOT CHECKED (AGENTDECK_REAP_PANE_CHILDREN=0)", c.liveSocket)
	}
	for _, p := range panes {
		reclaimedKb += p.treeKb
		log("  pane %d  %d process(es)  %dKB  under: %s", p.pane, len(p.tree), p.treeKb, short(p.paneCommand))
		for _, r := range p.tree {
			log("    pid %d  %s  %dKB  %s", r.pid, minutes(r.age), r.rssKb, short(r.command))
		}
		for _, r := range p.kept {
			log("    kept  %d  %s  %s", r.pid, minutes(r.age), short(r.command))
		}
		if c.kill && len(p.tree) > 0 {
			pids := make([]int, len(p.tree))
			for i, r := range p.tree {
				pids[i] = r.pid
			}
			log("    -> %s", stopAll(pids))
		}
	}

	log("\ntmux servers in %s* holding no sessions: %d", c.socketPrefix, len(empty))
	for _, e := range empty {
		reclaimedKb += e.rssKb
		log("  pid %d  %s  %dKB  -L %s", e.pid, minutes(e.age), e.rssKb, e.socket)
		if c.kill {
			if c.stop(e.pid) {
				log("    -> reaped")
			} else {
				log("    -> SURVIVED the kill")
			}
		}
	}

	log("\nsocket files with nothing listening in %s: %d", c.tmuxDir, len(sockets))
	if c.kill {
		removed := 0
		for _, p := range sockets {
			if os.Remove(p) == nil {
				removed++
			}
		}
		log("  removed %d", removed)
	}

	total := len(empty)
	for _, o := range orphaned {
		total += len(o.tree)
	}
	for _, p := range panes {
		total += len(p.tree)
	}
	verb := "would reclaim"
	if c.kill {
		verb = "reclaimed"
	}
	log("\n%s about %dMB across %d processes", verb, (reclaimedKb+512)/1024, total)

	if c.jsonOut {
		type orphanJSON struct {
			Pid      int    `json:"pid"`
			AgeMs    int64  `json:"ageMs"`
			TreeKb   int    `json:"treeKb"`
			TreeSize int    `json:"treeSize"`
			Cwd      string `json:"cwd"`
			Command  string `json:"command"`
		}
		type paneJSON struct {
			Pane         int      `json:"pane"`
			PaneCommand  string   `json:"paneCommand"`
			TreeKb       int      `json:"treeKb"`
			TreeSize     int      `json:"treeSize"`
			Commands     []string `json:"commands"`
			KeptCommands []string `json:"keptCommands"`
		}
		type serverJSON struct {
			Pid    int    `json:"pid"`
			AgeMs  int64  `json:"ageMs"`
			RssKb  int    `json:"rssKb"`
			Socket string `json:"socket"`
		}
		report := struct {
			Killed              bool         `json:"killed"`
			OrphansChecked      bool         `json:"orphansChecked"`
			Orphans             []orphanJSON `json:"orphans"`
			PaneChildrenChecked bool         `json:"paneChildrenChecked"`
			PaneChildren        []paneJSON   `json:"paneChildren"`
			EmptyServers        []serverJSON `json:"emptyServers"`
			StaleSockets        int          `json:"staleSockets"`
			ReclaimedKb         int          `json:"reclaimedKb"`
		}{Killed: c.kill, OrphansChecked: orphansChecked, Orphans: []orphanJSON{}, PaneChildrenChecked: c.reapPaneChildren,
			PaneChildren: []paneJSON{}, EmptyServers: []serverJSON{}, StaleSockets: len(sockets), ReclaimedKb: reclaimedKb}
		for _, o := range orphaned {
			report.Orphans = append(report.Orphans, orphanJSON{o.pid, o.age.Milliseconds(), o.treeKb, len(o.tree), o.cwd, o.command})
		}
		for _, p := range panes {
			pj := paneJSON{p.pane, p.paneCommand, p.treeKb, len(p.tree), []string{}, []string{}}
			for _, r := range p.tree {
				pj.Commands = append(pj.Commands, r.command)
			}
			for _, r := range p.kept {
				pj.KeptCommands = append(pj.KeptCommands, r.command)
			}
			report.PaneChildren = append(report.PaneChildren, pj)
		}
		for _, e := range empty {
			report.EmptyServers = append(report.EmptyServers, serverJSON{e.pid, e.age.Milliseconds(), e.rssKb, e.socket})
		}
		out, _ := json.MarshalIndent(report, "", "  ")
		fmt.Fprintln(stdout, string(out))
	}
	return 0
}

// ---- the server's timed pass (port of src/reap-schedule.ts)

type reapOutcome struct {
	ok      bool
	summary string
}

func summariseReap(stdout, stderr string, code int) reapOutcome {
	if code != 0 {
		lines := strings.Split(strings.TrimSpace(stderr+stdout), "\n")
		if len(lines) > 2 {
			lines = lines[len(lines)-2:]
		}
		return reapOutcome{false, fmt.Sprintf("the reaper exited %d: %s", code, strings.Join(lines, " "))}
	}
	var report struct {
		Orphans []struct {
			TreeSize int `json:"treeSize"`
		} `json:"orphans"`
		EmptyServers []any `json:"emptyServers"`
		StaleSockets int   `json:"staleSockets"`
		ReclaimedKb  int   `json:"reclaimedKb"`
	}
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		s := strings.TrimSpace(stdout)
		if len(s) > 200 {
			s = s[:200]
		}
		return reapOutcome{false, "the reaper printed no report: " + s}
	}
	if len(report.Orphans) == 0 && len(report.EmptyServers) == 0 {
		return reapOutcome{true, ""}
	}
	trees := 0
	for _, o := range report.Orphans {
		trees += o.TreeSize
	}
	return reapOutcome{true, fmt.Sprintf("reaped %d orphan tree(s) (%d process(es)), %d empty tmux server(s), %d dead socket file(s), about %dMB",
		len(report.Orphans), trees, len(report.EmptyServers), report.StaleSockets, (report.ReclaimedKb+512)/1024)}
}

// runReaperProcess runs one killing pass of this same binary in a child process.
func runReaperProcess() reapOutcome {
	exe, err := os.Executable()
	if err != nil {
		return reapOutcome{false, "the reaper could not be started: " + err.Error()}
	}
	cmd := exec.Command(exe, "reap", "--kill", "--json")
	var o, e strings.Builder
	cmd.Stdout, cmd.Stderr = &o, &e
	code := 0
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			return reapOutcome{false, "the reaper could not be started: " + err.Error()}
		}
	}
	return summariseReap(o.String(), e.String(), code)
}

// startReaping runs a pass every interval, never two at once.
func startReaping(interval time.Duration, run func() reapOutcome, log func(string)) (stop func()) {
	var mu sync.Mutex
	running := false
	t := time.NewTicker(interval)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			case <-t.C:
				mu.Lock()
				if running {
					mu.Unlock()
					continue
				}
				running = true
				mu.Unlock()
				go func() {
					// A pass that panics costs that pass, never the server it runs inside.
					defer func() {
						if r := recover(); r != nil {
							log(fmt.Sprintf("agentdeck: the reaper failed: %v", r))
						}
						mu.Lock()
						running = false
						mu.Unlock()
					}()
					if out := run(); out.summary != "" {
						log("agentdeck: " + out.summary)
					}
				}()
			}
		}
	}()
	return func() { t.Stop(); close(done) }
}
