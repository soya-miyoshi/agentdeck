package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// Port of src/pty.ts and src/hub.ts: one `tmux attach-session -d` PTY per live session, kept
// equal to what tmux lists, feeding that session's Stream.

const (
	paneCols     = 50
	defaultRows  = 30
	repaintQuiet = 120 * time.Millisecond
	repaintMax   = time.Second
	historyLines = 2000
	// How long output after a resize or repaint is taken as tmux redrawing rather than the agent.
	redrawHush = time.Second
)

// PTY is a session's attachment: the process, its master fd, and the stream it feeds.
type PTY interface {
	Write(data []byte)
	Resize(cols, rows int)
	Dispose()
	Stream() *Stream
}

type sessionPTY struct {
	stream   *Stream
	cmd      *exec.Cmd
	master   *os.File
	mu       sync.Mutex
	disposed bool
	done     chan struct{}
}

// newSessionPTY attaches to an existing session; never new-session, creating is the registry's job.
func newSessionPTY(socket, sessionID string, cols, rows int) (*sessionPTY, error) {
	cmd := exec.Command("tmux", "-L", socket, "attach-session", "-d", "-t", exactTarget(sessionID))
	cmd.Env = envList(baseEnv(os.LookupEnv))
	master, err := startPTY(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	p := &sessionPTY{stream: newStream(sessionID), cmd: cmd, master: master, done: make(chan struct{})}
	go p.read(master)
	return p, nil
}

// startPTY is the spawn, swapped in tests to see what is spawned.
var startPTY = pty.StartWithSize

func (p *sessionPTY) read(master *os.File) {
	buf := make([]byte, 32*1024)
	var carry []byte
	for {
		n, err := master.Read(buf)
		if n > 0 {
			data := append(carry, buf[:n]...)
			cut := completeUTF8(data)
			carry = append([]byte(nil), data[cut:]...)
			if cut > 0 {
				p.stream.Write(data[:cut:cut])
			}
		}
		if err != nil {
			break
		}
	}
	if len(carry) > 0 {
		p.stream.Write(carry)
	}
	// The client is gone: wait reaps it, and close releases the /dev/ptmx the TS server leaked.
	code := 0
	if err := p.cmd.Wait(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
	}
	p.stream.Declare(StateExited, &code)
	p.close()
	close(p.done)
}

// completeUTF8 is the length of b without a trailing, still-incomplete UTF-8 sequence, so a
// character split across two reads is not sent to the phone as two U+FFFD.
func completeUTF8(b []byte) int {
	n := len(b)
	for back := 1; back <= 3 && back <= n; back++ {
		c := b[n-back]
		if c&0xC0 != 0x80 {
			need := 0
			switch {
			case c&0xE0 == 0xC0:
				need = 2
			case c&0xF0 == 0xE0:
				need = 3
			case c&0xF8 == 0xF0:
				need = 4
			}
			if need > back {
				return n - back
			}
			return n
		}
	}
	return n
}

func (p *sessionPTY) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.master != nil {
		_ = p.master.Close()
		p.master = nil
	}
}

func (p *sessionPTY) Stream() *Stream { return p.stream }

func (p *sessionPTY) Write(data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.disposed && p.master != nil {
		_, _ = p.master.Write(data)
	}
}

func (p *sessionPTY) Resize(cols, rows int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.disposed && p.master != nil {
		_ = pty.Setsize(p.master, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	}
}

// Dispose detaches without touching the agent: SIGHUP the tmux client and close the master.
func (p *sessionPTY) Dispose() {
	p.mu.Lock()
	if p.disposed {
		p.mu.Unlock()
		return
	}
	p.disposed = true
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Signal(sigHUP)
	}
	p.mu.Unlock()
	p.close()
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
	}
}

type StateListener func(sessionID string, state SessionState, exitCode *int)

type announced struct {
	state    SessionState
	exitCode *int
}

// Hub owns one PTY per live, allowed session.
type Hub struct {
	tmux      *Tmux
	registry  *Registry
	createPTY func(sessionID string) (PTY, error)
	onState   StateListener

	mu        sync.Mutex
	ptys      map[string]PTY
	announced map[string]announced
	syncMu    sync.Mutex

	repaintMu    sync.Mutex
	repaints     map[string]*repaintCall
	repaintQuiet time.Duration
	repaintMax   time.Duration
}

type repaintCall struct {
	done chan struct{}
	data []byte
	seq  int64
	err  error
}

func newHub(tmux *Tmux, registry *Registry, onState StateListener) *Hub {
	h := &Hub{
		tmux: tmux, registry: registry, onState: onState,
		ptys: map[string]PTY{}, announced: map[string]announced{}, repaints: map[string]*repaintCall{},
		repaintQuiet: repaintQuiet, repaintMax: repaintMax,
	}
	h.createPTY = func(id string) (PTY, error) { return newSessionPTY(tmux.Socket, id, paneCols, defaultRows) }
	return h
}

// Sync attaches to every allowed live session, drops the rest, and announces state changes.
func (h *Hub) Sync(ctx context.Context) error {
	h.syncMu.Lock()
	defer h.syncMu.Unlock()
	live, err := h.registry.List(ctx)
	if err != nil {
		return err
	}
	liveIDs := map[string]bool{}
	for _, s := range live {
		liveIDs[s.ID] = true
	}
	var toDispose []PTY
	h.mu.Lock()
	for _, s := range live {
		if s.State == StateExited {
			continue
		}
		if existing, ok := h.ptys[s.ID]; ok {
			if st, _ := existing.Stream().State(); st == StateExited {
				toDispose = append(toDispose, existing)
				delete(h.ptys, s.ID)
			}
		}
		if _, ok := h.ptys[s.ID]; !ok {
			p, err := h.createPTY(s.ID)
			if err != nil {
				logf("agentdeck: could not attach to %s: %v", s.ID, err)
				continue
			}
			if st, ok := h.registry.Declared(s.ID); ok {
				p.Stream().Declare(st, nil)
			}
			h.ptys[s.ID] = p
		}
	}
	for id, p := range h.ptys {
		if !liveIDs[id] {
			toDispose = append(toDispose, p)
			delete(h.ptys, id)
		}
	}
	h.mu.Unlock()
	for _, p := range toDispose {
		p.Dispose()
	}

	for _, s := range live {
		stream := h.StreamFor(s.ID)
		if s.State == StateExited {
			if stream != nil {
				stream.Declare(StateExited, s.ExitCode)
			}
			h.Announce(s.ID, s.State, s.ExitCode)
			continue
		}
		if stream != nil {
			st, _ := stream.State()
			h.registry.SetState(s.ID, st)
			h.Announce(s.ID, st, s.ExitCode)
		} else {
			h.Announce(s.ID, s.State, s.ExitCode)
		}
	}
	h.mu.Lock()
	for id := range h.announced {
		if !liveIDs[id] {
			delete(h.announced, id)
		}
	}
	h.mu.Unlock()
	return nil
}

func (h *Hub) Attached(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.ptys[id]
	return ok
}

// Announce tells listeners about a state only when it is news; the exit code is part of the key.
func (h *Hub) Announce(id string, state SessionState, exitCode *int) {
	h.mu.Lock()
	last, ok := h.announced[id]
	if ok && last.state == state && intPtrEq(last.exitCode, exitCode) {
		h.mu.Unlock()
		return
	}
	h.announced[id] = announced{state, exitCode}
	h.mu.Unlock()
	if h.onState != nil {
		h.onState(id, state, exitCode)
	}
}

func intPtrEq(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func (h *Hub) StreamFor(id string) *Stream {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p, ok := h.ptys[id]; ok {
		return p.Stream()
	}
	return nil
}

func (h *Hub) ptyFor(id string) PTY {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ptys[id]
}

func (h *Hub) SendInput(id string, data string) {
	if p := h.ptyFor(id); p != nil {
		p.Write([]byte(data))
	}
}

// ApplyPaneRows follows the clients' rows; the width never moves, so history wraps once.
func (h *Hub) ApplyPaneRows(id string, rows int) {
	if p := h.ptyFor(id); p != nil {
		p.Stream().Hush(redrawHush)
		p.Resize(paneCols, rows)
	}
}

// Repaint collects the bytes tmux redraws with off the stream, shared by concurrent callers.
func (h *Hub) Repaint(ctx context.Context, id string) ([]byte, int64, error) {
	h.repaintMu.Lock()
	if c, ok := h.repaints[id]; ok {
		h.repaintMu.Unlock()
		<-c.done
		return c.data, c.seq, c.err
	}
	c := &repaintCall{done: make(chan struct{})}
	h.repaints[id] = c
	h.repaintMu.Unlock()
	c.data, c.seq, c.err = h.repaintOnce(ctx, id)
	h.repaintMu.Lock()
	delete(h.repaints, id)
	h.repaintMu.Unlock()
	close(c.done)
	return c.data, c.seq, c.err
}

func (h *Hub) repaintOnce(ctx context.Context, id string) ([]byte, int64, error) {
	stream := h.StreamFor(id)
	if stream == nil {
		return nil, 0, fmt.Errorf("no session %s to repaint", id)
	}
	_, head := stream.Buffered()
	var mu sync.Mutex
	var parts []byte
	seq := head
	collected := 0
	budget := stream.buf.capacity
	activity := make(chan struct{}, 1)
	full := make(chan struct{})
	var fullOnce sync.Once
	off := stream.OnChunk(func(c Chunk) {
		mu.Lock()
		defer mu.Unlock()
		if collected >= budget {
			return
		}
		parts = append(parts, c.Data...)
		collected += len(c.Data)
		seq = c.Seq
		select {
		case activity <- struct{}{}:
		default:
		}
		if collected >= budget {
			fullOnce.Do(func() { close(full) })
		}
	})
	defer off()
	stream.Hush(redrawHush)
	if err := h.tmux.Repaint(ctx, id); err != nil {
		return nil, 0, err
	}
	cap := time.NewTimer(h.repaintMax)
	defer cap.Stop()
	var quiet <-chan time.Time
wait:
	for {
		select {
		case <-activity:
			quiet = time.After(h.repaintQuiet)
		case <-quiet:
			break wait
		case <-cap.C:
			break wait
		case <-full:
			break wait
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(parts) == 0 {
		held, headSeq := stream.Buffered()
		if len(held) == 0 {
			return nil, 0, fmt.Errorf("no repaint arrived for %s within %v", id, h.repaintMax)
		}
		logf("agentdeck: no repaint arrived for %s within %v; falling back to the buffer, so this snapshot may be stale", id, h.repaintMax)
		return held, headSeq, nil
	}
	return append([]byte(nil), parts...), seq, nil
}

// DisposeAll detaches from everything; the agents keep running.
func (h *Hub) DisposeAll() {
	h.mu.Lock()
	all := h.ptys
	h.ptys = map[string]PTY{}
	h.mu.Unlock()
	for _, p := range all {
		p.Dispose()
	}
}

func (h *Hub) Size() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.ptys)
}
