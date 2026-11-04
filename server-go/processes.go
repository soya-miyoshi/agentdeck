package main

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Port of src/processes.ts: one `ps` for the whole machine, pane trees breadth first, and
// SIGTERM-then-SIGKILL deepest first.

const psPath = "/bin/ps"

type ProcessRow struct {
	Pid        int     `json:"pid"`
	Ppid       int     `json:"ppid"`
	AgeSeconds int     `json:"ageSeconds"`
	RssKb      int     `json:"rssKb"`
	CPUPercent float64 `json:"cpuPercent"`
	Command    string  `json:"command"`
	Depth      int     `json:"depth"`
}

type SessionProcesses struct {
	SessionID  string       `json:"sessionId"`
	PanePid    int          `json:"panePid"`
	Processes  []ProcessRow `json:"processes"`
	ChildCount int          `json:"childCount"`
	ChildRssKb int          `json:"childRssKb"`
}

var etimeRe = regexp.MustCompile(`^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$`)

// parseEtime reads `[[dd-]hh:]mm:ss` as seconds, or -1.
func parseEtime(s string) int {
	m := etimeRe.FindStringSubmatch(s)
	if m == nil {
		return -1
	}
	n := func(v string) int { i, _ := strconv.Atoi(v); return i }
	return (n(m[1])*24+n(m[2]))*3600 + n(m[3])*60 + n(m[4])
}

var psLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$`)

func parseProcessTable(stdout string) []ProcessRow {
	var rows []ProcessRow
	for _, line := range strings.Split(stdout, "\n") {
		m := psLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		ppid, _ := strconv.Atoi(m[2])
		rss, _ := strconv.Atoi(m[4])
		cpu, _ := strconv.ParseFloat(m[5], 64)
		rows = append(rows, ProcessRow{Pid: pid, Ppid: ppid, AgeSeconds: parseEtime(m[3]), RssKb: rss, CPUPercent: cpu, Command: m[6]})
	}
	return rows
}

func readProcessTable(ctx context.Context) []ProcessRow {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, psPath, "-Ao", "pid=,ppid=,etime=,rss=,pcpu=,command=").Output()
	if err != nil {
		return nil
	}
	return parseProcessTable(string(out))
}

// treeOf is the pane and its descendants, breadth first, with depth below the pane.
func treeOf(rows []ProcessRow, panePid int) []ProcessRow {
	children := map[int][]ProcessRow{}
	byPid := map[int]ProcessRow{}
	for _, r := range rows {
		byPid[r.Pid] = r
		children[r.Ppid] = append(children[r.Ppid], r)
	}
	pane, ok := byPid[panePid]
	if !ok {
		return nil
	}
	pane.Depth = 0
	out := []ProcessRow{pane}
	seen := map[int]bool{panePid: true}
	queue := []ProcessRow{pane}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		for _, c := range children[next.Pid] {
			if seen[c.Pid] {
				continue
			}
			seen[c.Pid] = true
			c.Depth = next.Depth + 1
			out = append(out, c)
			queue = append(queue, c)
		}
	}
	return out
}

func sessionProcesses(panes []PaneRef, rows []ProcessRow) []SessionProcesses {
	out := []SessionProcesses{}
	for _, p := range panes {
		procs := treeOf(rows, p.PanePid)
		if procs == nil {
			procs = []ProcessRow{}
		}
		sp := SessionProcesses{SessionID: p.SessionID, PanePid: p.PanePid, Processes: procs}
		for _, r := range procs {
			if r.Depth > 0 {
				sp.ChildCount++
				sp.ChildRssKb += r.RssKb
			}
		}
		out = append(out, sp)
	}
	return out
}

func psState(pid int) string {
	out, _ := exec.Command(psPath, "-o", "state=", "-p", strconv.Itoa(pid)).Output()
	return strings.TrimSpace(string(out))
}

// finished counts a zombie as finished, since kill(pid, 0) succeeds against one.
func finished(pid int, state func(int) string) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return true
	}
	return strings.HasPrefix(state(pid), "Z")
}

type endTreeOptions struct {
	grace  time.Duration
	state  func(int) string
	signal func(int, syscall.Signal) error
}

// endTree signals deepest first and returns the pids that survived SIGKILL.
func endTree(pids []int, o endTreeOptions) []int {
	if o.grace == 0 {
		o.grace = 3 * time.Second
	}
	if o.state == nil {
		o.state = psState
	}
	if o.signal == nil {
		o.signal = func(pid int, s syscall.Signal) error { return syscall.Kill(pid, s) }
	}
	var pending []int
	for i := len(pids) - 1; i >= 0; i-- {
		pid := pids[i]
		if pid <= 1 || finished(pid, o.state) {
			continue
		}
		if o.signal(pid, syscall.SIGTERM) == nil {
			pending = append(pending, pid)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	deadline := time.Now().Add(o.grace)
	for time.Now().Before(deadline) {
		alive := false
		for _, pid := range pending {
			if !finished(pid, o.state) {
				alive = true
				break
			}
		}
		if !alive {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	var survivors []int
	for _, pid := range pending {
		if finished(pid, o.state) {
			continue
		}
		_ = o.signal(pid, syscall.SIGKILL)
		if !finished(pid, o.state) {
			survivors = append(survivors, pid)
		}
	}
	return survivors
}
