package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Port of src/ws.test.ts, src/ws-robustness.test.ts, src/half-open.test.ts, src/snapshot.test.ts
// and src/attach.test.ts. Fakes stand in for tmux everywhere except the snapshot group.

const (
	wsToken  = "ws-test-token"
	wsOrigin = "https://mac.example.ts.net"
)

// ---- harness

type wsRig struct {
	t      *testing.T
	srv    *httptest.Server
	ws     *WSServer
	stream *Stream

	mu    sync.Mutex
	input []string
	rows  []int
}

func (r *wsRig) inputs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.input...)
}

func (r *wsRig) clearInput() {
	r.mu.Lock()
	r.input = nil
	r.mu.Unlock()
}

func (r *wsRig) rowsApplied() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int(nil), r.rows...)
}

// wsNewRig starts a WSServer over one stream "s1"; edit adjusts the deps before it starts.
func wsNewRig(t *testing.T, edit func(r *wsRig, d *WSDeps)) *wsRig {
	t.Helper()
	r := &wsRig{t: t, stream: newStream("s1")}
	d := WSDeps{
		Token:  wsToken,
		Origin: wsOrigin,
		StreamFor: func(id string) *Stream {
			if id == "s1" {
				return r.stream
			}
			return nil
		},
		CaptureHistory: func(context.Context, string) (string, error) { return "scrollback\n", nil },
		IsAlternate:    func(context.Context, string) (bool, error) { return false, nil },
		PaneModes:      func(context.Context, string) (string, error) { return "", nil },
		Repaint: func(context.Context, string) ([]byte, int64, error) {
			_, head := r.stream.Buffered()
			return []byte("repainted screen"), head, nil
		},
		ListSessions: func(context.Context) ([]Session, error) { return []Session{}, nil },
		SendInput: func(_ string, data string) {
			r.mu.Lock()
			r.input = append(r.input, data)
			r.mu.Unlock()
		},
		ApplyPaneRows: func(_ string, rows int) {
			r.mu.Lock()
			r.rows = append(r.rows, rows)
			r.mu.Unlock()
		},
	}
	if edit != nil {
		edit(r, &d)
	}
	r.ws = newWSServer(d)
	r.srv = httptest.NewServer(r.ws)
	t.Cleanup(func() { r.srv.Close(); r.ws.Close() })
	return r
}

func (r *wsRig) url() string { return "ws" + strings.TrimPrefix(r.srv.URL, "http") }

type wsPeer struct {
	t      *testing.T
	c      *websocket.Conn
	res    *http.Response
	msgs   chan map[string]any
	closed chan error

	mu  sync.Mutex
	all []map[string]any
}

func wsDialURL(url string, origin string, protocols ...string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	if origin != "" {
		h.Set("origin", origin)
	}
	return websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: protocols, HTTPHeader: h})
}

// wsOpen dials with the token; unless keepBaseline, the on-open hello and sessions are dropped.
func wsOpen(t *testing.T, url string, keepBaseline bool) *wsPeer {
	t.Helper()
	c, res, err := wsDialURL(url, wsOrigin, wsToken)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(-1)
	p := &wsPeer{t: t, c: c, res: res, msgs: make(chan map[string]any, 8192), closed: make(chan error, 1)}
	go func() {
		for {
			_, raw, err := c.Read(context.Background())
			if err != nil {
				p.closed <- err
				close(p.msgs)
				return
			}
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			if !keepBaseline && (m["t"] == "hello" || m["t"] == "sessions") {
				continue
			}
			p.mu.Lock()
			p.all = append(p.all, m)
			p.mu.Unlock()
			p.msgs <- m
		}
	}()
	t.Cleanup(func() { _ = c.CloseNow() })
	return p
}

func (p *wsPeer) send(m any) {
	b, _ := json.Marshal(m)
	if err := p.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		p.t.Fatal(err)
	}
}

func (p *wsPeer) attach(id string, cols, rows int) {
	p.send(map[string]any{"t": "attach", "sessionId": id, "cols": cols, "rows": rows})
}

func (p *wsPeer) next() map[string]any {
	p.t.Helper()
	select {
	case m, ok := <-p.msgs:
		if !ok {
			p.t.Fatal("socket closed waiting for a frame")
		}
		return m
	case <-time.After(2 * time.Second):
		p.t.Fatal("timed out waiting for a frame")
	}
	return nil
}

func (p *wsPeer) frames() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.all...)
}

func (p *wsPeer) reset() {
	p.mu.Lock()
	p.all = nil
	p.mu.Unlock()
}

func (p *wsPeer) count(match func(map[string]any) bool) int {
	n := 0
	for _, f := range p.frames() {
		if match(f) {
			n++
		}
	}
	return n
}

// alive proves the socket still works: a malformed frame is answered with an error.
func (p *wsPeer) alive() bool {
	before := p.count(isT("error"))
	if err := p.c.Write(context.Background(), websocket.MessageText, []byte("{not json")); err != nil {
		return false
	}
	return wsWaitFor(func() bool { return p.count(isT("error")) > before }, 2*time.Second)
}

func wsWaitFor(pred func() bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if pred() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return pred()
}

func wsAttachedCount(s *Stream) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.clients)
}

func wsLast(p *wsPeer) map[string]any {
	f := p.frames()
	if len(f) == 0 {
		return nil
	}
	return f[len(f)-1]
}

func wsHasT(t string) func([]map[string]any) bool {
	return func(fs []map[string]any) bool {
		for _, f := range fs {
			if f["t"] == t {
				return true
			}
		}
		return false
	}
}

// ---- src/ws.test.ts

func TestWS_UpgradeIsAuthenticated(t *testing.T) {
	r := wsNewRig(t, nil)
	t.Run("a valid token opens, and the subprotocol is echoed back", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		if got := p.c.Subprotocol(); got != wsToken {
			t.Fatalf("the server must echo the selected subprotocol, echoed %q", got)
		}
	})
	t.Run("a wrong token is refused at the handshake", func(t *testing.T) {
		if _, res, err := wsDialURL(r.url(), wsOrigin, "not-the-token"); err == nil || res == nil || res.StatusCode != 401 {
			t.Fatalf("a wrong token opened: %v", err)
		}
	})
	t.Run("no token at all is refused", func(t *testing.T) {
		if _, res, err := wsDialURL(r.url(), wsOrigin); err == nil || res == nil || res.StatusCode != 401 {
			t.Fatalf("no token opened: %v", err)
		}
	})
	t.Run("a foreign Origin is refused", func(t *testing.T) {
		if _, res, err := wsDialURL(r.url(), "https://evil.example", wsToken); err == nil || res == nil || res.StatusCode != 403 {
			t.Fatalf("a foreign origin opened: %v", err)
		}
	})
}

func TestWS_Attach(t *testing.T) {
	r := wsNewRig(t, nil)
	t.Run("a first attach gets a snapshot with scrollback, then a state", func(t *testing.T) {
		r.stream.Write([]byte("live bytes"))
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		snap, state := p.next(), p.next()
		if snap["t"] != "snapshot" || snap["history"] != "scrollback\n" || snap["epoch"] != r.stream.Epoch() {
			t.Fatalf("snapshot %v", snap)
		}
		if snap["data"] != "repainted screen" {
			t.Fatalf("the live screen is the repaint, not the ring buffer: %v", snap["data"])
		}
		if state["t"] != "state" {
			t.Fatalf("state %v", state)
		}
	})
	t.Run("a covered client gets chunks rather than a repaint", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		_, at := r.stream.Buffered()
		r.stream.Write([]byte("after"))
		p.send(map[string]any{"t": "attach", "sessionId": "s1", "cols": 80, "rows": 24, "haveEpoch": r.stream.Epoch(), "haveSeq": at})
		if first := p.next(); first["t"] != "chunk" || first["data"] != "after" {
			t.Fatalf("first %v", first)
		}
	})
	t.Run("a stale epoch gets a snapshot even with a plausible seq", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		p.send(map[string]any{"t": "attach", "sessionId": "s1", "cols": 80, "rows": 24, "haveEpoch": "from-a-previous-process", "haveSeq": 1})
		if first := p.next(); first["t"] != "snapshot" {
			t.Fatalf("chunks here would leave the tab permanently blank: %v", first)
		}
	})
	t.Run("live output reaches an attached client", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		p.next()
		p.next()
		r.stream.Write([]byte("streamed"))
		if c := p.next(); c["t"] != "chunk" || c["data"] != "streamed" {
			t.Fatalf("chunk %v", c)
		}
	})
}

func TestWS_InputAndResize(t *testing.T) {
	r := wsNewRig(t, nil)
	t.Run("input goes to the PTY and is never echoed back specially", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		p.next()
		p.next()
		r.clearInput()
		p.send(map[string]any{"t": "input", "sessionId": "s1", "data": "ls\r"})
		if !wsWaitFor(func() bool { return len(r.inputs()) == 1 }, 2*time.Second) || r.inputs()[0] != "ls\r" {
			t.Fatalf("input %v", r.inputs())
		}
		time.Sleep(50 * time.Millisecond)
		if n := len(p.frames()); n != 2 {
			t.Fatalf("input was answered with frames: %v", p.frames())
		}
	})
	t.Run("the pane is sized to the shortest attached client, and its cols are ignored", func(t *testing.T) {
		tall := wsOpen(t, r.url(), false)
		tall.attach("s1", 200, 50)
		tall.next()
		tall.next()
		short := wsOpen(t, r.url(), false)
		short.attach("s1", 60, 20)
		short.next()
		short.next()
		if rows := r.rowsApplied(); rows[len(rows)-1] != 20 {
			t.Fatalf("the shorter client must win: %v", rows)
		}
		_ = short.c.Close(websocket.StatusNormalClosure, "")
		if !wsWaitFor(func() bool { rows := r.rowsApplied(); return rows[len(rows)-1] == 50 }, 2*time.Second) {
			t.Fatalf("detaching the short one lets the pane grow back: %v", r.rowsApplied())
		}
	})
}

func TestWS_Refusals(t *testing.T) {
	r := wsNewRig(t, nil)
	t.Run("a malformed frame is an error message, not a dropped socket", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		_ = p.c.Write(context.Background(), websocket.MessageText, []byte("{not json"))
		m := p.next()
		if m["t"] != "error" || !strings.Contains(m["message"].(string), "not JSON") {
			t.Fatalf("%v", m)
		}
		if !p.alive() {
			t.Fatal("the socket should survive it")
		}
	})
	t.Run("an unknown session is named in the error", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		p.attach("nope", 80, 24)
		if m := p.next(); m["t"] != "error" || !strings.Contains(m["message"].(string), "nope") {
			t.Fatalf("%v", m)
		}
	})
	t.Run("a bad resize is refused without touching the pane", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		before := len(r.rowsApplied())
		p.send(map[string]any{"t": "resize", "sessionId": "s1", "cols": -5, "rows": 24})
		if m := p.next(); m["t"] != "error" {
			t.Fatalf("%v", m)
		}
		if len(r.rowsApplied()) != before {
			t.Fatal("a refused resize touched the pane")
		}
	})
}

func TestWS_SnapshotFrameOnTheWire(t *testing.T) {
	t.Run("in alternate-screen mode the frame carries no history key at all", func(t *testing.T) {
		r := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
			d.CaptureHistory = func(context.Context, string) (string, error) { return "what vim currently looks like\n", nil }
			d.IsAlternate = func(context.Context, string) (bool, error) { return true, nil }
			d.Repaint = func(context.Context, string) ([]byte, int64, error) { return []byte("vim, repainted"), 7, nil }
		})
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		snap := p.next()
		if snap["t"] != "snapshot" {
			t.Fatalf("no snapshot was sent: %v", snap)
		}
		if _, ok := snap["history"]; ok {
			t.Fatal("the TUI's frame was sent as scrollback")
		}
		if snap["data"] != "vim, repainted" {
			t.Fatalf("%v", snap)
		}
	})
	t.Run("a failing repaint costs one message, not the process", func(t *testing.T) {
		r := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
			d.Repaint = func(context.Context, string) ([]byte, int64, error) {
				return nil, 0, errors.New("no tmux client is attached to s1, so it cannot repaint")
			}
		})
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		if m := p.next(); m["t"] != "error" {
			t.Fatalf("the client was never told: %v", m)
		}
		if !p.alive() {
			t.Fatal("the socket did not survive it")
		}
	})
}

func TestWS_FailingCaptureCostsOneMessage(t *testing.T) {
	t.Run("the client is told, the socket lives, and the process does not exit", func(t *testing.T) {
		r := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
			d.CaptureHistory = func(context.Context, string) (string, error) {
				return "", errors.New("stdout maxBuffer length exceeded")
			}
		})
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		if m := p.next(); m["t"] != "error" {
			t.Fatalf("the client was never told the capture failed: %v", m)
		}
		if !p.alive() {
			t.Fatal("the socket did not survive the failure")
		}
	})
}

func TestWS_BadBuildNotInherited(t *testing.T) {
	t.Run("a capture that never returns is abandoned, and the next attach builds its own", func(t *testing.T) {
		var calls atomic.Int32
		never := make(chan struct{})
		t.Cleanup(func() { close(never) })
		r := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
			d.SnapshotLimit = 150 * time.Millisecond
			d.CaptureHistory = func(context.Context, string) (string, error) {
				if calls.Add(1) == 1 {
					<-never
					return "", errors.New("released")
				}
				return "healthy scrollback\n", nil
			}
		})
		first := wsOpen(t, r.url(), false)
		first.attach("s1", 80, 24)
		if !wsWaitFor(func() bool { m := wsLast(first); return m != nil && m["t"] == "error" }, 2*time.Second) {
			t.Fatal("the hung build was never bounded")
		}
		second := wsOpen(t, r.url(), false)
		second.attach("s1", 80, 24)
		snap := second.next()
		if snap["t"] != "snapshot" || snap["history"] != "healthy scrollback\n" {
			t.Fatalf("a fresh client inherited the wedged build instead of making its own: %v", snap)
		}
	})
	t.Run("a failed snapshot detaches, so a retry gets a listener that forwards", func(t *testing.T) {
		var calls atomic.Int32
		r := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
			d.CaptureHistory = func(context.Context, string) (string, error) {
				if calls.Add(1) == 1 {
					return "", errors.New("stdout maxBuffer length exceeded")
				}
				return "healthy scrollback\n", nil
			}
		})
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		if m := p.next(); m["t"] != "error" {
			t.Fatalf("%v", m)
		}
		p.reset()
		p.attach("s1", 80, 24)
		if !wsWaitFor(func() bool { return p.count(isT("state")) == 1 }, 2*time.Second) || p.count(isT("snapshot")) != 1 {
			t.Fatalf("the retry got no snapshot: %v", p.frames())
		}
		r.stream.Write([]byte("after the retry"))
		match := func(m map[string]any) bool {
			return m["t"] == "chunk" && strings.Contains(fmt.Sprint(m["data"]), "after the retry")
		}
		wsWaitFor(func() bool { return p.count(match) >= 1 }, 2*time.Second)
		time.Sleep(100 * time.Millisecond)
		if n := p.count(match); n != 1 {
			t.Fatalf("the client is silently blind, or was sent the bytes %d times", n)
		}
	})
}

func TestWS_ColdAttachToldPositionFirst(t *testing.T) {
	t.Run("no chunk arrives before the snapshot", func(t *testing.T) {
		r := wsNewRig(t, func(r *wsRig, d *WSDeps) {
			// What a real repaint does: write into the stream, then report the seq it ended at.
			d.Repaint = func(context.Context, string) ([]byte, int64, error) {
				r.stream.Write([]byte("REPAINT-BYTES"))
				_, head := r.stream.Buffered()
				return []byte("REPAINT-BYTES"), head, nil
			}
		})
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		wsWaitFor(func() bool { return p.count(isT("state")) > 0 }, 2*time.Second)
		time.Sleep(100 * time.Millisecond)
		fs := p.frames()
		at := -1
		for i, f := range fs {
			if f["t"] == "snapshot" {
				at = i
				break
			}
		}
		if at == -1 {
			t.Fatal("no snapshot arrived at all")
		}
		for i, f := range fs {
			if f["t"] == "chunk" && i < at {
				t.Fatal("a chunk was sent to a client that had no position yet")
			}
			if f["t"] == "chunk" && i > at && strings.Contains(fmt.Sprint(f["data"]), "REPAINT-BYTES") {
				t.Fatal("the repaint's bytes were painted twice")
			}
		}
	})
}

// wsStorm opens n sockets, attaches them all to s1 at once, and returns what each received.
func wsStorm(t *testing.T, r *wsRig, n int, wait time.Duration) []*wsPeer {
	peers := make([]*wsPeer, n)
	for i := range peers {
		peers[i] = wsOpen(t, r.url(), false)
	}
	for _, p := range peers {
		p.attach("s1", 80, 24)
	}
	time.Sleep(wait)
	return peers
}

func wsCountPeers(peers []*wsPeer, t string) int {
	n := 0
	for _, p := range peers {
		if p.count(isT(t)) > 0 {
			n++
		}
	}
	return n
}

func TestWS_FailedSnapshotDoesNotDetachAnother(t *testing.T) {
	t.Run("the second client still gets its snapshot and stays attached", func(t *testing.T) {
		var attempts atomic.Int32
		r := wsNewRig(t, func(r *wsRig, d *WSDeps) {
			d.Repaint = func(context.Context, string) ([]byte, int64, error) {
				if attempts.Add(1) == 1 {
					time.Sleep(20 * time.Millisecond)
					return nil, 0, errors.New("stdout maxBuffer length exceeded")
				}
				_, head := r.stream.Buffered()
				return []byte("repainted"), head, nil
			}
		})
		peers := wsStorm(t, r, 2, 500*time.Millisecond)
		if wsCountPeers(peers, "snapshot") < 1 {
			t.Fatal("neither client got a snapshot: the shared failure took both of them down")
		}
		if wsAttachedCount(r.stream) < 1 {
			t.Fatal("a failed build detached every client, leaving open sockets with no listener")
		}
	})
}

func TestWS_ReconnectStormIsNotSpawnStorm(t *testing.T) {
	var builds atomic.Int32
	var failFirst atomic.Bool
	failFirst.Store(true)
	r := wsNewRig(t, func(r *wsRig, d *WSDeps) {
		d.Repaint = func(context.Context, string) ([]byte, int64, error) {
			n := builds.Add(1)
			time.Sleep(50 * time.Millisecond)
			if failFirst.Load() && n == 1 {
				return nil, 0, errors.New("stdout maxBuffer length exceeded")
			}
			_, head := r.stream.Buffered()
			return []byte("repainted"), head, nil
		}
	})
	t.Run("a build that fails under a storm is retried once, not once per client", func(t *testing.T) {
		peers := wsStorm(t, r, 8, 600*time.Millisecond)
		if n := builds.Load(); n != 2 {
			t.Fatalf("eight re-attaches cost %d snapshot builds", n)
		}
		if n := wsCountPeers(peers, "snapshot"); n != 7 {
			t.Fatalf("%d clients got a snapshot, want 7", n)
		}
		if n := wsCountPeers(peers, "error"); n != 1 {
			t.Fatalf("the failure was reported to %d clients", n)
		}
		for _, p := range peers {
			_ = p.c.Close(websocket.StatusNormalClosure, "")
		}
	})
	t.Run("two tabs of one session reconnecting together share a single build", func(t *testing.T) {
		failFirst.Store(false)
		builds.Store(0)
		peers := wsStorm(t, r, 2, 600*time.Millisecond)
		if n := builds.Load(); n != 1 {
			t.Fatalf("each tab paid for its own capture-pane: %d builds", n)
		}
		if n := wsCountPeers(peers, "snapshot"); n != 2 {
			t.Fatal("one of the two tabs was left blank")
		}
	})
}

func TestWS_AttachCannotHoldWholeOutput(t *testing.T) {
	t.Run("a flood during the build is dropped and answered from the ring buffer", func(t *testing.T) {
		r := wsNewRig(t, func(r *wsRig, d *WSDeps) {
			d.Repaint = func(context.Context, string) ([]byte, int64, error) {
				_, seq := r.stream.Buffered()
				for i := 0; i < 60; i++ {
					r.stream.Write(bytes.Repeat([]byte("x"), 100*1024))
				}
				time.Sleep(50 * time.Millisecond)
				return []byte("repainted"), seq, nil
			}
		})
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		wsWaitFor(func() bool { return p.count(isT("state")) > 0 }, 3*time.Second)
		total, sawX := 0, false
		for _, f := range p.frames() {
			if f["t"] == "chunk" || f["t"] == "snapshot" {
				data := fmt.Sprint(f["data"])
				total += len(data)
				sawX = sawX || strings.Contains(data, "x")
			}
		}
		if total >= 1024*1024 {
			t.Fatalf("the attach held %d bytes of output instead of dropping to the ring buffer", total)
		}
		if !sawX {
			t.Fatal("the client was left with a hole where the flood was")
		}
	})
}

func TestWS_AttachNotParkedBehindEveryFailure(t *testing.T) {
	t.Run("a storm where every build fails still settles in a bounded number of builds", func(t *testing.T) {
		r := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
			d.Repaint = func(context.Context, string) ([]byte, int64, error) {
				time.Sleep(80 * time.Millisecond)
				return nil, 0, errors.New("stdout maxBuffer length exceeded")
			}
		})
		peers := make([]*wsPeer, 8)
		for i := range peers {
			peers[i] = wsOpen(t, r.url(), false)
		}
		started := time.Now()
		var mu sync.Mutex
		var last time.Duration
		for _, p := range peers {
			p.attach("s1", 80, 24)
		}
		for _, p := range peers {
			go func(p *wsPeer) {
				for m := range p.msgs {
					if m["t"] == "error" {
						mu.Lock()
						last = max(last, time.Since(started))
						mu.Unlock()
					}
				}
			}(p)
		}
		ok := wsWaitFor(func() bool { return wsCountPeers(peers, "error") == 8 }, 1500*time.Millisecond)
		if !ok {
			t.Fatalf("not every client was told its snapshot failed: %d", wsCountPeers(peers, "error"))
		}
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		if last >= 500*time.Millisecond {
			t.Fatalf("the last client was parked %v, which is one build per client", last)
		}
	})
}

func TestWS_StateGoesToEveryOpenSocket(t *testing.T) {
	r := wsNewRig(t, func(r *wsRig, d *WSDeps) {
		d.Repaint = func(context.Context, string) ([]byte, int64, error) {
			_, head := r.stream.Buffered()
			return nil, head, nil
		}
	})
	code := 137
	want := func(id, state string, exit ...float64) map[string]any {
		m := map[string]any{"t": "state", "sessionId": id, "state": state}
		if len(exit) > 0 {
			m["exitCode"] = exit[0]
		}
		return m
	}
	t.Run("a socket that has attached nothing is still told", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		time.Sleep(50 * time.Millisecond)
		r.ws.PushState("s2", StateWaiting, nil)
		if got := p.next(); !reflect.DeepEqual(got, want("s2", "waiting")) {
			t.Fatalf("%v", got)
		}
	})
	t.Run("a socket attached to one session hears about another", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		p.attach("s1", 80, 24)
		p.next()
		p.next()
		r.ws.PushState("s2", StateWaiting, nil)
		if got := p.next(); !reflect.DeepEqual(got, want("s2", "waiting")) {
			t.Fatalf("%v", got)
		}
	})
	t.Run("every open socket gets it, so a second phone is not left behind", func(t *testing.T) {
		a, b := wsOpen(t, r.url(), false), wsOpen(t, r.url(), false)
		time.Sleep(50 * time.Millisecond)
		r.ws.PushState("s3", StateWorking, nil)
		for _, p := range []*wsPeer{a, b} {
			if got := p.next(); !reflect.DeepEqual(got, want("s3", "working")) {
				t.Fatalf("%v", got)
			}
		}
	})
	t.Run("an exit carries its code, and a state without one does not invent it", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		time.Sleep(50 * time.Millisecond)
		r.ws.PushState("s2", StateExited, &code)
		if got := p.next(); !reflect.DeepEqual(got, want("s2", "exited", 137)) {
			t.Fatalf("%v", got)
		}
		r.ws.PushState("s2", StateIdle, nil)
		if got := p.next(); !reflect.DeepEqual(got, want("s2", "idle")) {
			t.Fatalf("%v", got)
		}
	})
	t.Run("a closed socket is not written to", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		_ = p.c.Close(websocket.StatusNormalClosure, "")
		time.Sleep(50 * time.Millisecond)
		r.ws.PushState("s2", StateWaiting, nil)
		if !wsOpen(t, r.url(), true).alive() {
			t.Fatal("a push after a socket closed broke the server")
		}
	})
}

func TestWS_SessionListOnOpen(t *testing.T) {
	listed := []Session{{ID: "s1", Name: "s1", Cwd: "/workspace/a", Agent: "claude", State: StateWaiting, StartedAt: 1}}
	r := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
		d.ListSessions = func(context.Context) ([]Session, error) { return listed, nil }
	})
	t.Run("a reconnecting socket that attaches nothing is still told which one needs you", func(t *testing.T) {
		p := wsOpen(t, r.url(), true)
		hello, sessions := p.next(), p.next()
		if hello["t"] != "hello" {
			t.Fatalf("%v", hello)
		}
		raw, _ := json.Marshal(map[string]any{"t": "sessions", "sessions": listed})
		var expect map[string]any
		_ = json.Unmarshal(raw, &expect)
		if !reflect.DeepEqual(sessions, expect) {
			t.Fatalf("%v", sessions)
		}
	})
	t.Run("every socket is told the width the panes are actually wrapped to", func(t *testing.T) {
		p := wsOpen(t, r.url(), true)
		if got := p.next(); !reflect.DeepEqual(got, map[string]any{"t": "hello", "cols": float64(paneCols)}) {
			t.Fatalf("%v", got)
		}
	})
	t.Run("the width does not depend on the session list, which is allowed to fail", func(t *testing.T) {
		broken := wsNewRig(t, func(_ *wsRig, d *WSDeps) {
			d.ListSessions = func(context.Context) ([]Session, error) { return nil, errors.New("tmux did not answer") }
		})
		p := wsOpen(t, broken.url(), true)
		if got := p.next(); !reflect.DeepEqual(got, map[string]any{"t": "hello", "cols": float64(paneCols)}) {
			t.Fatalf("%v", got)
		}
	})
}

// ---- src/ws-robustness.test.ts

// wsRawHandshake upgrades a raw TCP socket, so frames can be written a library would never produce.
func wsRawHandshake(t *testing.T, addr string) net.Conn {
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: %s\r\n\r\n", addr, base64.StdEncoding.EncodeToString(key), wsToken)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	head := make([]byte, 12)
	if _, err := io.ReadFull(conn, head); err != nil || !strings.HasPrefix(string(head), "HTTP/1.1 101") {
		t.Fatalf("handshake refused: %q %v", head, err)
	}
	return conn
}

func wsMaskedText(payload []byte) []byte {
	mask := make([]byte, 4)
	_, _ = rand.Read(mask)
	out := []byte{0x81}
	if len(payload) < 126 {
		out = append(out, 0x80|byte(len(payload)))
	} else {
		out = append(out, 0xfe)
		out = binary.BigEndian.AppendUint16(out, uint16(len(payload)))
	}
	out = append(out, mask...)
	for i, b := range payload {
		out = append(out, b^mask[i%4])
	}
	return out
}

func TestWS_OneSocketCannotTakeServerDown(t *testing.T) {
	var calls, live, peak atomic.Int32
	release := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	r := wsNewRig(t, func(r *wsRig, d *WSDeps) {
		d.Origin = ""
		d.CaptureHistory = func(context.Context, string) (string, error) {
			calls.Add(1)
			n := live.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			<-release
			live.Add(-1)
			return "scrollback\n", nil
		}
	})
	stillAnswers := func() bool {
		res, err := http.Get(r.srv.URL + "/alive")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return true
	}

	t.Run("a malformed frame kills that socket and nothing else", func(t *testing.T) {
		conn := wsRawHandshake(t, strings.TrimPrefix(r.srv.URL, "http://"))
		_, _ = conn.Write(wsMaskedText([]byte{0xff, 0xfe, 0xfd}))
		// The frame either closes this socket or is answered as not JSON; neither reaches others.
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _ = io.ReadAll(io.LimitReader(conn, 4096))
		if !stillAnswers() {
			t.Fatal("the malformed frame took the whole server down")
		}
		if !wsOpen(t, r.url(), false).alive() {
			t.Fatal("a new client cannot do real work afterwards")
		}
	})
	t.Run("a frame larger than the byte budget is refused, not buffered", func(t *testing.T) {
		if maxFrameBytes != 64*1024 {
			t.Fatalf("maxFrameBytes %d", maxFrameBytes)
		}
		p := wsOpen(t, r.url(), false)
		p.send(map[string]any{"t": "input", "sessionId": "s1", "data": strings.Repeat("x", maxFrameBytes+1)})
		select {
		case err := <-p.closed:
			if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
				t.Fatalf("closed with %v, want 1009", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the oversized frame was accepted")
		}
		if len(r.inputs()) != 0 {
			t.Fatal("the oversized input reached the pane")
		}
		if !stillAnswers() {
			t.Fatal("the oversized frame took the server down")
		}
	})
	t.Run("a burst of resyncs inside the frame budget makes one snapshot, not one each", func(t *testing.T) {
		p := wsOpen(t, r.url(), false)
		calls.Store(0)
		peak.Store(0)
		for i := 0; i < maxFramesPerWindow; i++ {
			p.send(map[string]any{"t": "resync", "sessionId": "s1", "haveEpoch": "gone", "haveSeq": 0})
		}
		if !wsWaitFor(func() bool { return calls.Load() > 0 }, 2*time.Second) {
			t.Fatal("no snapshot was built at all")
		}
		time.Sleep(200 * time.Millisecond)
		if peak.Load() != 1 || calls.Load() != 1 {
			t.Fatalf("%d concurrent capture-pane spawns, %d in all", peak.Load(), calls.Load())
		}
		releaseOnce.Do(func() { close(release) })
	})
}

// ---- src/half-open.test.ts

const wsTestPing = 300 * time.Millisecond

type wsProxy struct {
	addr   string
	frozen atomic.Bool
	ln     net.Listener
	mu     sync.Mutex
	conns  []net.Conn
}

// wsStartProxy forwards TCP until frozen, then forwards nothing, closes included.
func wsStartProxy(t *testing.T, target string) *wsProxy {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &wsProxy{addr: ln.Addr().String(), ln: ln}
	pipe := func(dst, src net.Conn) {
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if err != nil {
				return
			}
			if !p.frozen.Load() {
				_, _ = dst.Write(buf[:n])
			}
		}
	}
	go func() {
		for {
			down, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				_ = down.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, down, up)
			p.mu.Unlock()
			go pipe(up, down)
			go pipe(down, up)
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		p.mu.Lock()
		for _, c := range p.conns {
			_ = c.Close()
		}
		p.mu.Unlock()
	})
	return p
}

type wsHalfRig struct {
	*wsRig
	dead, live *Stream
}

func wsNewHalfRig(t *testing.T) *wsHalfRig {
	h := &wsHalfRig{dead: newStream("dead"), live: newStream("live")}
	h.wsRig = wsNewRig(t, func(_ *wsRig, d *WSDeps) {
		d.Origin = ""
		d.PingInterval = wsTestPing
		d.StreamFor = func(id string) *Stream {
			switch id {
			case "dead":
				return h.dead
			case "live":
				return h.live
			}
			return nil
		}
		d.CaptureHistory = func(context.Context, string) (string, error) { return "", nil }
		d.Repaint = func(context.Context, string) ([]byte, int64, error) { return nil, 0, nil }
	})
	return h
}

func wsAttachVia(t *testing.T, url, id string) (*wsPeer, time.Time) {
	p := wsOpen(t, url, false)
	p.attach(id, 80, 24)
	if !wsWaitFor(func() bool { return p.count(isT("state")) > 0 }, 2*time.Second) {
		t.Fatalf("attach to %s failed", id)
	}
	return p, time.Now()
}

func TestWS_HalfOpenConnection(t *testing.T) {
	h := wsNewHalfRig(t)
	t.Run("is noticed by the ping, and sooner than a status that stopped changing could be", func(t *testing.T) {
		proxy := wsStartProxy(t, strings.TrimPrefix(h.srv.URL, "http://"))
		deadClient, deadStateAt := wsAttachVia(t, "ws://"+proxy.addr, "dead")
		liveClient, liveStateAt := wsAttachVia(t, h.url(), "live")
		if wsAttachedCount(h.dead) != 1 || wsAttachedCount(h.live) != 1 {
			t.Fatal("attach counts")
		}
		before := len(deadClient.frames())
		frozenAt := time.Now()
		proxy.frozen.Store(true)

		bound := 2 * wsTestPing
		noticed := wsWaitFor(func() bool { return wsAttachedCount(h.dead) == 0 }, bound*3)
		noticedIn := time.Since(frozenAt)
		if !noticed {
			t.Fatal("the ping never noticed the half-open connection")
		}
		// Slack for scheduling under -race; the property is two intervals, not three.
		if noticedIn > bound+100*time.Millisecond {
			t.Fatalf("ping noticed after %v, past the %v bound", noticedIn, bound)
		}
		select {
		case <-deadClient.closed:
			t.Fatal("the client end saw a close, so the connection was not half-open")
		default:
		}
		if len(deadClient.frames()) != before {
			t.Fatal("the frozen client heard something after the freeze")
		}
		deadStale, liveStale := time.Since(deadStateAt), time.Since(liveStateAt)
		h.clearInput()
		liveClient.send(map[string]any{"t": "input", "sessionId": "live", "data": "x"})
		if !wsWaitFor(func() bool { return len(h.inputs()) == 1 }, 2*time.Second) {
			t.Fatal("the live socket was not alive")
		}
		if noticedIn > deadStale || liveStale < noticedIn {
			t.Fatalf("ping noticed at %v; dead status unchanged %v, live %v", noticedIn, deadStale, liveStale)
		}
	})
	t.Run("one socket cannot send frames without a bound", func(t *testing.T) {
		p, _ := wsAttachVia(t, h.url(), "live")
		h.clearInput()
		sent := maxFramesPerWindow + 50
		for i := 0; i < sent; i++ {
			p.send(map[string]any{"t": "input", "sessionId": "live", "data": "x"})
		}
		wsWaitFor(func() bool { return p.count(isT("error")) > 0 }, 2*time.Second)
		time.Sleep(50 * time.Millisecond)
		var errs []string
		for _, f := range p.frames() {
			if f["t"] == "error" {
				errs = append(errs, fmt.Sprint(f["message"]))
			}
		}
		if n := len(h.inputs()); n >= sent || n > maxFramesPerWindow {
			t.Fatalf("%d of %d frames handled", n, sent)
		}
		if len(errs) != 1 || !strings.Contains(errs[0], "messages in a second") {
			t.Fatalf("one sentence per window, not one per dropped frame: %v", errs)
		}
	})
}

func TestWS_ClientHeartbeatDefaultAgrees(t *testing.T) {
	t.Run("the client's heartbeat default agrees with the server's interval", func(t *testing.T) {
		src, err := os.ReadFile(filepath.Join("..", "src", "client", "connection.ts"))
		if err != nil {
			t.Skip("the client source is not beside this server")
		}
		m := regexp.MustCompile(`DEFAULT_HEARTBEAT_INTERVAL_MS = ([0-9_]+);`).FindSubmatch(src)
		if m == nil {
			t.Fatal("DEFAULT_HEARTBEAT_INTERVAL_MS not found in the client")
		}
		if got := strings.ReplaceAll(string(m[1]), "_", ""); got != fmt.Sprint(pingInterval.Milliseconds()) {
			t.Fatalf("client default %s ms, server %v", got, pingInterval)
		}
	})
}

func TestWS_ServerHeartbeat(t *testing.T) {
	h := wsNewHalfRig(t)
	t.Run("reaches a socket that has attached nothing at all", func(t *testing.T) {
		p := wsOpen(t, h.url(), false)
		pings := func() int { return p.count(isT("ping")) }
		if !wsWaitFor(func() bool { return pings() >= 2 }, wsTestPing*8) {
			t.Fatal("an unattached socket was never sent a heartbeat")
		}
		for _, f := range p.frames() {
			if f["t"] != "ping" {
				t.Fatalf("something other than the heartbeat arrived: %v", f)
			}
			if f["intervalMs"] != float64(wsTestPing.Milliseconds()) {
				t.Fatalf("the interval on the frame is not the server's: %v", f)
			}
		}
		if wsTestPing == pingInterval {
			t.Fatal("the scaled interval must differ from production to prove anything")
		}
	})
	t.Run("does not spend the receiving tab's frame budget", func(t *testing.T) {
		p, _ := wsAttachVia(t, h.url(), "live")
		if !wsWaitFor(func() bool { return p.count(isT("ping")) >= 2 }, wsTestPing*8) {
			t.Fatal("no heartbeats arrived")
		}
		h.clearInput()
		p.reset()
		sent := maxFramesPerWindow - 1
		for i := 0; i < sent; i++ {
			p.send(map[string]any{"t": "input", "sessionId": "live", "data": "x"})
		}
		if !wsWaitFor(func() bool { return len(h.inputs()) == sent }, 2*time.Second) {
			t.Fatalf("only %d of %d frames were accepted", len(h.inputs()), sent)
		}
		if p.count(isT("error")) != 0 {
			t.Fatal("the heartbeat pushed a legitimate tab over its budget")
		}
	})
}

// ---- src/attach.test.ts

func wsFilled(epoch, text string, capacity int) *RingBuffer {
	if capacity == 0 {
		capacity = defaultRingCapacity
	}
	b := newRingBuffer(epoch, capacity)
	b.append([]byte(text))
	return b
}

func TestWS_PlanningAnAttach(t *testing.T) {
	t.Run("a first attach with no position gets a snapshot", func(t *testing.T) {
		if wsFilled("e1", "hello", 0).covers("", 0, false) {
			t.Fatal("no position was called covered")
		}
	})
	t.Run("a covered client gets chunks from where it left off", func(t *testing.T) {
		b := wsFilled("e1", "hello", 0)
		if !b.covers("e1", 2, true) || string(b.since(2)) != "llo" {
			t.Fatal("covered client")
		}
	})
	t.Run("a client at the head gets chunks and nothing to render", func(t *testing.T) {
		b := wsFilled("e1", "hello", 0)
		if !b.covers("e1", 5, true) || len(b.since(5)) != 0 {
			t.Fatal("head client")
		}
	})
	t.Run("a client the buffer has rolled past gets a snapshot", func(t *testing.T) {
		if wsFilled("e1", "abcdefghij", 4).covers("e1", 0, true) {
			t.Fatal("a rolled-past client was called covered")
		}
	})
}

func TestWS_EpochBranch(t *testing.T) {
	t.Run("a stale epoch is a snapshot even when the seq looks comfortably covered", func(t *testing.T) {
		if wsFilled("e2", "fresh output after the restart", 0).covers("e1", 3, true) {
			t.Fatal("a stale epoch was called covered")
		}
	})
	t.Run("a client far ahead of the new counter is still a snapshot, not an error", func(t *testing.T) {
		s := newStream("s1")
		s.Write([]byte("abc"))
		if _, _, covered := s.Position("e1", 4_000_000, true); covered {
			t.Fatal("covered")
		}
	})
	t.Run("an epoch that happens to match a different session's is still just an epoch", func(t *testing.T) {
		if !wsFilled("shared", "abc", 0).covers("shared", 1, true) {
			t.Fatal("equal epochs are covered")
		}
	})
}

// wsRepainting is what a real repaint does: append to the buffer and report the head after it.
func wsRepainting(b *RingBuffer, text string) func(context.Context) ([]byte, int64, error) {
	return func(context.Context) ([]byte, int64, error) { return []byte(text), b.append([]byte(text)), nil }
}

func wsSources(b *RingBuffer, history string, alt bool, modes string, repaint string) SnapshotSources {
	return SnapshotSources{
		Epoch:          b.epoch,
		CaptureHistory: func(context.Context) (string, error) { return history, nil },
		Alternate:      func(context.Context) (bool, error) { return alt, nil },
		PaneModes:      func(context.Context) (string, error) { return modes, nil },
		Repaint:        wsRepainting(b, repaint),
	}
}

func wsKeys(t *testing.T, s *Snapshot) map[string]any {
	raw, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}

func TestWS_BuildingAColdSnapshot(t *testing.T) {
	ctx := context.Background()
	t.Run("carries scrollback, the live bytes, and the seq they end at", func(t *testing.T) {
		b := wsFilled("e1", "output from an hour ago", 0)
		s, err := buildSnapshot(ctx, wsSources(b, "older lines\n", false, "", "live screen"))
		if err != nil || s.Epoch != "e1" || s.Seq != b.headSeq || s.History != "older lines\n" || s.Data != "live screen" {
			t.Fatalf("%+v %v", s, err)
		}
	})
	t.Run("data is the repaint, not whatever the ring buffer happens to hold", func(t *testing.T) {
		b := wsFilled("e1", "a fragment of an hour-old build log", 0)
		s, _ := buildSnapshot(ctx, wsSources(b, "", false, "", "\x1b[H\x1b[2Jprompt$ "))
		if s.Data != "\x1b[H\x1b[2Jprompt$ " || strings.Contains(s.Data, "build log") {
			t.Fatalf("%q", s.Data)
		}
	})
	t.Run("in alternate-screen mode history is absent, not captured", func(t *testing.T) {
		b := wsFilled("e1", "", 0)
		captured := false
		src := wsSources(b, "", true, "", "vim, repainted")
		src.CaptureHistory = func(context.Context) (string, error) {
			captured = true
			return "what vim currently looks like\n", nil
		}
		s, _ := buildSnapshot(ctx, src)
		if _, ok := wsKeys(t, s)["history"]; ok || captured || s.Data != "vim, repainted" {
			t.Fatalf("%+v captured=%v", s, captured)
		}
	})
	t.Run("carries the modes a repaint does not, so the client is not a fresh terminal", func(t *testing.T) {
		b := wsFilled("e1", "", 0)
		s, _ := buildSnapshot(ctx, wsSources(b, "", true, "\x1b[?1049h\x1b[?1003h", "the agent, repainted"))
		if s.Modes != "\x1b[?1049h\x1b[?1003h" {
			t.Fatalf("%q", s.Modes)
		}
	})
	t.Run("a shell's snapshot carries no modes rather than an empty string", func(t *testing.T) {
		s, _ := buildSnapshot(ctx, wsSources(wsFilled("e1", "", 0), "", false, "", "prompt$ "))
		if _, ok := wsKeys(t, s)["modes"]; ok {
			t.Fatal("modes key present")
		}
	})
	t.Run("history is absent rather than empty when there is none", func(t *testing.T) {
		s, _ := buildSnapshot(ctx, wsSources(wsFilled("e1", "", 0), "", false, "", "screen"))
		if _, ok := wsKeys(t, s)["history"]; ok {
			t.Fatal("history key present")
		}
	})
	t.Run("the seq is the one the repaint reflects, so chunks at or below it are stale", func(t *testing.T) {
		b := wsFilled("e1", "abcdef", 0)
		s, _ := buildSnapshot(ctx, wsSources(b, "", false, "", "0123"))
		if s.Seq != 10 || s.Seq != b.headSeq || !b.covers("e1", s.Seq, true) || len(b.since(s.Seq)) != 0 {
			t.Fatalf("%+v", s)
		}
	})
}

// ---- src/snapshot.test.ts

var wsScripts = map[string]string{
	"idle":  `i=1; while [ $i -le 200 ]; do echo scrollback-line-$i; i=$((i+1)); done; printf 'LIVE-SCREEN-MARKER'; exec sleep 100000`,
	"burst": `sleep 2; i=1; while [ $i -le 400 ]; do echo burst-line-$i; i=$((i+1)); done; printf 'BURST-TAIL-MARKER'; exec sleep 100000`,
	"tui":   `echo before-the-tui-started; printf '\033[?1049h'; printf 'TUI-FRAME-MARKER'; exec sleep 100000`,
}

type wsTmuxRig struct {
	tmux *Tmux
	reg  *Registry
	hub  *Hub
	repo string
}

func wsNewTmuxRig(t *testing.T) *wsTmuxRig {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "roots")
	repo := filepath.Join(root, "host", "owner", "snap")
	_ = os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	socket := fmt.Sprintf("agentdeck-gotest-ws-%d-%d", os.Getpid(), time.Now().UnixNano()%1000000)
	tmux := newTmux(socket, "")
	t.Cleanup(func() {
		path, _ := tmux.run(context.Background(), "display-message", "-p", "#{socket_path}")
		_, _ = tmux.run(context.Background(), "kill-server")
		if path = strings.TrimSpace(path); strings.Contains(path, socket) {
			_ = os.Remove(path)
		}
	})
	if err := tmux.EnsureServer(context.Background()); err != nil {
		t.Fatal(err)
	}
	profs := map[string]any{}
	for name, script := range wsScripts {
		profs[name] = map[string]any{"command": "/bin/sh", "args": []string{"-c", script}}
	}
	raw, _ := json.Marshal(profs)
	profiles, _ := parseProfiles(raw)
	reg, err := newRegistry(tmux, profiles, newAllowlist(nil, []string{root}), "test-secret-key")
	if err != nil {
		t.Fatal(err)
	}
	r := &wsTmuxRig{tmux: tmux, reg: reg, hub: newHub(tmux, reg, nil), repo: repo}
	t.Cleanup(r.hub.DisposeAll)
	return r
}

func (r *wsTmuxRig) create(t *testing.T, agent string) string {
	res, err := r.reg.Create(context.Background(), r.repo, agent)
	if err != nil {
		t.Fatal(err)
	}
	return res.Session.ID
}

func (r *wsTmuxRig) stream(t *testing.T, id string) *Stream {
	if err := r.hub.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	s := r.hub.StreamFor(id)
	if s == nil {
		t.Fatalf("the hub never attached to %s", id)
	}
	return s
}

// wsQuiet waits until the stream has stopped moving, the only "the pane has settled" there is.
func wsQuiet(s *Stream) {
	deadline := time.Now().Add(15 * time.Second)
	last, since := int64(-1), time.Now()
	for time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		_, head := s.Buffered()
		if head != last {
			last, since = head, time.Now()
		} else if time.Since(since) >= 300*time.Millisecond && last > 0 {
			return
		}
	}
}

func wsWaitMarker(t *testing.T, s *Stream, marker string) {
	if !wsWaitFor(func() bool { b, _ := s.Buffered(); return bytes.Contains(b, []byte(marker)) }, 20*time.Second) {
		t.Fatalf("the pane never printed %s", marker)
	}
}

// wsCold builds the snapshot the server would send, from the sources main.go wires up.
func (r *wsTmuxRig) cold(t *testing.T, id string, s *Stream) *Snapshot {
	snap, err := buildSnapshot(context.Background(), SnapshotSources{
		Epoch:          s.Epoch(),
		CaptureHistory: func(ctx context.Context) (string, error) { return r.tmux.CaptureHistory(ctx, id, historyLines) },
		Alternate:      func(ctx context.Context) (bool, error) { return r.tmux.IsAlternateScreen(ctx, id) },
		PaneModes:      func(context.Context) (string, error) { return "", nil },
		Repaint:        func(ctx context.Context) ([]byte, int64, error) { return r.hub.Repaint(ctx, id) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func wsLine(text string) *regexp.Regexp { return regexp.MustCompile(`(?m)` + text + `\r?$`) }

func TestWS_RealTmuxSnapshot(t *testing.T) {
	r := wsNewTmuxRig(t)
	t.Run("history holds the lines that scrolled off, and data is the live screen", func(t *testing.T) {
		id := r.create(t, "idle")
		time.Sleep(1500 * time.Millisecond)
		s := r.stream(t, id)
		wsQuiet(s)
		snap := r.cold(t, id, s)
		if snap.History == "" || !wsLine("scrollback-line-1").MatchString(snap.History) || !wsLine("scrollback-line-100").MatchString(snap.History) {
			t.Fatal("the earliest lines are missing from history")
		}
		if strings.Contains(snap.History, "LIVE-SCREEN-MARKER") {
			t.Fatal("history reached into the visible screen, which data is about to paint")
		}
		if !strings.Contains(snap.Data, "LIVE-SCREEN-MARKER") || !strings.Contains(snap.Data, "\x1b") {
			t.Fatalf("the live screen, with escapes, is not in the snapshot: %q", snap.Data)
		}
		data, head := s.Buffered()
		_ = data
		if snap.Seq != head {
			t.Fatalf("seq %d, head %d", snap.Seq, head)
		}
		if rest, _, ok := s.Position(s.Epoch(), snap.Seq, true); !ok || len(rest) != 0 {
			t.Fatal("bytes remain after the snapshot's seq")
		}
		if snap.Epoch != s.Epoch() {
			t.Fatal("epoch")
		}
	})
	t.Run("scrollback that is already in history is not repeated in data", func(t *testing.T) {
		id := r.create(t, "burst")
		s := r.stream(t, id)
		wsWaitMarker(t, s, "BURST-TAIL-MARKER")
		wsQuiet(s)
		if buffered, _ := s.Buffered(); !wsLine("burst-line-1").Match(buffered) {
			t.Fatal("the ring buffer did not hold the burst")
		}
		snap := r.cold(t, id, s)
		if !strings.Contains(snap.Data, "BURST-TAIL-MARKER") {
			t.Fatal("the live screen is not in the snapshot")
		}
		if wsLine("burst-line-1").MatchString(snap.Data) {
			t.Fatal("data carried a line that scrolled off the screen, which history already had")
		}
		if !wsLine("burst-line-1").MatchString(snap.History) {
			t.Fatal("the scrolled-off lines belong in history")
		}
		if _, head := s.Buffered(); snap.Seq != head {
			t.Fatal("seq")
		}
	})
	t.Run("history is absent rather than the TUI's own frame", func(t *testing.T) {
		id := r.create(t, "tui")
		time.Sleep(time.Second)
		s := r.stream(t, id)
		wsQuiet(s)
		if alt, err := r.tmux.IsAlternateScreen(context.Background(), id); err != nil || !alt {
			t.Fatalf("#{alternate_on} did not report the alternate screen: %v", err)
		}
		would, _ := r.tmux.CaptureHistory(context.Background(), id, historyLines)
		if would == "" || strings.Contains(would, "before-the-tui-started") {
			t.Fatalf("the premise changed: capture returned %q", would)
		}
		snap := r.cold(t, id, s)
		if _, ok := wsKeys(t, snap)["history"]; ok {
			t.Fatal("the TUI's frame was sent as scrollback")
		}
		if !strings.Contains(snap.Data, "TUI-FRAME-MARKER") {
			t.Fatal("the live screen is still the live screen")
		}
		if _, head := s.Buffered(); snap.Seq != head {
			t.Fatal("seq")
		}
	})
	t.Run("#{alternate_on} prints clean ASCII to a client with no locale at all", func(t *testing.T) {
		id := r.create(t, "tui")
		path := os.Getenv("PATH")
		if path == "" {
			path = "/usr/bin:/bin"
		}
		ask := func(target string) string {
			cmd := exec.Command("tmux", "-L", r.tmux.Socket, "display-message", "-p", "-t", target, "#{alternate_on}")
			cmd.Env = []string{"PATH=" + path}
			out, err := cmd.Output()
			if err != nil {
				t.Fatal(err)
			}
			return string(out)
		}
		wsWaitFor(func() bool { return ask(exactWindowTarget(id)) == "1\n" }, 5*time.Second)
		if got := ask(exactWindowTarget(id)); got != "1\n" {
			t.Fatalf("tmux printed %x", got)
		}
		if got := ask(exactTarget(id)); got != "\n" {
			t.Fatalf("a session target printed %x", got)
		}
	})
}
