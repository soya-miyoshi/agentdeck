package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Port of src/protocol.ts and src/ws.ts: one socket multiplexed over every attached session, the
// token as a subprotocol, a heartbeat both halves can see, and a snapshot-then-chunks attach.

const (
	pingInterval               = 15 * time.Second
	rateWindow                 = time.Second
	maxFramesPerWindow         = 100
	maxFrameBytes              = 64 * 1024
	snapshotTimeout            = 15 * time.Second
	maxInheritedSnapshotErrors = 2
	maxQueuedAttachBytes       = 4 * 1024 * 1024
	maxBufferedBytes           = 8 * 1024 * 1024
	minDimension               = 1
	maxDimension               = 1000
	wsProtocol                 = "agentdeck"
)

// ---- protocol

type ClientMessage struct {
	T         string
	SessionID string
	Cols      int
	Rows      int
	Data      string
	HaveEpoch string
	HaveSeq   int64
	HasPos    bool
}

func validDimension(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != float64(int64(f)) || f < minDimension || f > maxDimension {
		return 0, false
	}
	return int(f), true
}

func integer(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || f != float64(int64(f)) {
		return 0, false
	}
	return int64(f), true
}

// parseClientMessage returns the message, or the sentence the client renders saying why not.
func parseClientMessage(raw []byte) (*ClientMessage, string) {
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, "message is not JSON"
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return nil, "message is not an object"
	}
	sid, _ := obj["sessionId"].(string)
	if sid == "" {
		return nil, "message has no sessionId"
	}
	m := &ClientMessage{SessionID: sid}
	dims := func(kind string) string {
		cols, okC := validDimension(obj["cols"])
		rows, okR := validDimension(obj["rows"])
		if !okC || !okR {
			return fmt.Sprintf("%s needs integer cols and rows between 1 and %d", kind, maxDimension)
		}
		m.Cols, m.Rows = cols, rows
		return ""
	}
	switch t := obj["t"]; t {
	case "attach":
		m.T = "attach"
		if e := dims("attach"); e != "" {
			return nil, e
		}
		epoch, _ := obj["haveEpoch"].(string)
		if seq, ok := integer(obj["haveSeq"]); epoch != "" && ok {
			m.HaveEpoch, m.HaveSeq, m.HasPos = epoch, seq, true
		}
	case "detach":
		m.T = "detach"
	case "input":
		m.T = "input"
		data, ok := obj["data"].(string)
		if !ok {
			return nil, "input needs string data"
		}
		m.Data = data
	case "resize":
		m.T = "resize"
		if e := dims("resize"); e != "" {
			return nil, e
		}
	case "resync":
		m.T = "resync"
		epoch, _ := obj["haveEpoch"].(string)
		seq, ok := integer(obj["haveSeq"])
		if epoch == "" || !ok {
			return nil, "resync needs haveEpoch and an integer haveSeq"
		}
		m.HaveEpoch, m.HaveSeq, m.HasPos = epoch, seq, true
	default:
		return nil, "unknown message type: " + jsString(t)
	}
	return m, ""
}

// jsString renders a value the way JavaScript's String() would, for error sentences.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "undefined"
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// ---- snapshots

type Snapshot struct {
	Epoch   string `json:"epoch"`
	Seq     int64  `json:"seq"`
	History string `json:"history,omitempty"`
	Data    string `json:"data"`
	Modes   string `json:"modes,omitempty"`
}

type SnapshotSources struct {
	Epoch          string
	CaptureHistory func(ctx context.Context) (string, error)
	Alternate      func(ctx context.Context) (bool, error)
	PaneModes      func(ctx context.Context) (string, error)
	Repaint        func(ctx context.Context) ([]byte, int64, error)
	// Settle waits for a resize just asked of tmux to land, so history and screen are captured at
	// one size: captured either side of it they overlap, and the overlap shows as repeated lines.
	Settle func(ctx context.Context)
}

// buildSnapshot is history (unless on the alternate screen), modes, then the repaint last.
func buildSnapshot(ctx context.Context, s SnapshotSources) (*Snapshot, error) {
	if s.Settle != nil {
		s.Settle(ctx)
	}
	alt, err := s.Alternate(ctx)
	if err != nil {
		return nil, err
	}
	history := ""
	if !alt {
		if history, err = s.CaptureHistory(ctx); err != nil {
			return nil, err
		}
	}
	modes, err := s.PaneModes(ctx)
	if err != nil {
		return nil, err
	}
	data, seq, err := s.Repaint(ctx)
	if err != nil {
		return nil, err
	}
	return &Snapshot{Epoch: s.Epoch, Seq: seq, History: history, Data: string(data), Modes: modes}, nil
}

// ---- server

type WSDeps struct {
	Token          string
	Origin         string
	StreamFor      func(id string) *Stream
	CaptureHistory func(ctx context.Context, id string) (string, error)
	IsAlternate    func(ctx context.Context, id string) (bool, error)
	PaneModes      func(ctx context.Context, id string) (string, error)
	Repaint        func(ctx context.Context, id string) ([]byte, int64, error)
	ListSessions   func(ctx context.Context) ([]Session, error)
	SendInput      func(id, data string)
	ApplyPaneRows  func(id string, rows int)
	// SettleRows waits, bounded, until the pane is `rows` high. Optional.
	SettleRows    func(ctx context.Context, id string, rows int)
	PingInterval  time.Duration
	SnapshotLimit time.Duration
	NotFound      http.Handler
}

type wsClient struct {
	id     string
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc

	out      chan []byte
	buffered atomic.Int64

	mu       sync.Mutex
	attached map[string]func()

	windowStart   time.Time
	frames        int
	toldAboutRate bool
}

type snapshotCall struct {
	generation int
	done       chan struct{}
	snap       *Snapshot
	err        error
}

type WSServer struct {
	d          WSDeps
	nextID     atomic.Int64
	mu         sync.Mutex
	clients    map[*wsClient]bool
	snapMu     sync.Mutex
	snapshots  map[string]*snapshotCall
	generation int
	stop       chan struct{}
}

func newWSServer(d WSDeps) *WSServer {
	if d.PingInterval == 0 {
		d.PingInterval = pingInterval
	}
	if d.SnapshotLimit == 0 {
		d.SnapshotLimit = snapshotTimeout
	}
	s := &WSServer{d: d, clients: map[*wsClient]bool{}, snapshots: map[string]*snapshotCall{}, stop: make(chan struct{})}
	go s.heartbeat()
	return s
}

func (s *WSServer) Close() {
	close(s.stop)
	s.mu.Lock()
	for c := range s.clients {
		c.cancel()
	}
	s.mu.Unlock()
}

func reject(w http.ResponseWriter, code int, reason string) {
	w.Header().Set("connection", "close")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(reason))
}

// ServeHTTP authenticates the upgrade before any socket exists, then echoes `agentdeck`.
func (s *WSServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("upgrade"), "websocket") {
		if s.d.NotFound != nil {
			s.d.NotFound.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	if origin := r.Header.Get("origin"); s.d.Origin != "" && origin != "" && origin != s.d.Origin {
		reject(w, 403, "Forbidden")
		return
	}
	var offered []string
	for _, h := range r.Header.Values("sec-websocket-protocol") {
		for _, v := range strings.Split(h, ",") {
			if v = strings.TrimSpace(v); v != "" {
				offered = append(offered, v)
			}
		}
	}
	presented := ""
	for _, v := range offered {
		if v != wsProtocol {
			presented = v
			break
		}
	}
	if presented == "" || !tokenMatches(presented, s.d.Token) {
		reject(w, 401, "Unauthorized")
		return
	}
	// Echo the first offered protocol, as `ws` does: the browser closes a socket with none.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{offered[0]},
		InsecureSkipVerify: true, // the Origin check above is ours, and permits a missing Origin
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxFrameBytes)
	ctx, cancel := context.WithCancel(context.Background())
	c := &wsClient{
		id: "c" + strconv.FormatInt(s.nextID.Add(1)-1, 10), conn: conn, ctx: ctx, cancel: cancel,
		out: make(chan []byte, 4096), attached: map[string]func(){}, windowStart: time.Now(),
	}
	s.mu.Lock()
	s.clients[c] = true
	s.mu.Unlock()

	go s.writer(c)
	s.send(c, HelloFrame{T: frameHello, Cols: paneCols})
	go func() {
		list, err := s.d.ListSessions(ctx)
		if err != nil {
			logf("agentdeck: could not send the session list on connect: %v", err)
			return
		}
		s.send(c, SessionsFrame{T: frameSessions, Sessions: list})
	}()
	s.reader(c)
}

func (s *WSServer) writer(c *wsClient) {
	for {
		select {
		case <-c.ctx.Done():
			return
		case frame := <-c.out:
			c.buffered.Add(-int64(len(frame)))
			wctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
			err := c.conn.Write(wctx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

// send queues a frame; a socket over the ceiling is terminated, since nothing it is sent arrives.
func (s *WSServer) send(c *wsClient, msg any) {
	if c.ctx.Err() != nil {
		return
	}
	if c.buffered.Load() > maxBufferedBytes {
		c.cancel()
		_ = c.conn.CloseNow()
		return
	}
	frame, err := json.Marshal(msg)
	if err != nil {
		return
	}
	c.buffered.Add(int64(len(frame)))
	select {
	case c.out <- frame:
	default:
		c.cancel()
		_ = c.conn.CloseNow()
	}
}

func (s *WSServer) reader(c *wsClient) {
	defer s.closed(c)
	for {
		_, raw, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
		if !s.withinRate(c) {
			continue
		}
		s.handle(c, raw)
	}
}

func (s *WSServer) closed(c *wsClient) {
	c.cancel()
	_ = c.conn.CloseNow()
	c.mu.Lock()
	attached := c.attached
	c.attached = map[string]func(){}
	c.mu.Unlock()
	for id, off := range attached {
		off()
		if st := s.d.StreamFor(id); st != nil {
			st.Detach(c.id)
		}
		s.applySize(id)
	}
	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
}

func (s *WSServer) withinRate(c *wsClient) bool {
	now := time.Now()
	if now.Sub(c.windowStart) >= rateWindow {
		c.windowStart, c.frames, c.toldAboutRate = now, 0, false
	}
	c.frames++
	if c.frames <= maxFramesPerWindow {
		return true
	}
	if !c.toldAboutRate {
		c.toldAboutRate = true
		s.send(c, ErrorFrame{T: frameError, Message: fmt.Sprintf(
			"that tab sent more than %d messages in a second; the rest of this second was dropped", maxFramesPerWindow)})
	}
	return false
}

func (s *WSServer) applySize(id string) {
	st := s.d.StreamFor(id)
	if st == nil {
		return
	}
	if rows := st.MinRows(); rows > 0 {
		s.d.ApplyPaneRows(id, rows)
	}
}

func (s *WSServer) handle(c *wsClient, raw []byte) {
	m, errText := parseClientMessage(raw)
	if m == nil {
		s.send(c, ErrorFrame{T: frameError, Message: errText})
		return
	}
	stream := s.d.StreamFor(m.SessionID)
	if stream == nil {
		s.send(c, ErrorFrame{T: frameError, SessionID: m.SessionID, Message: "no session " + m.SessionID})
		return
	}
	failed := func(err error) {
		logf("agentdeck: ws message failed: %v", err)
		s.send(c, ErrorFrame{T: frameError, Message: "that request failed; see the server log"})
	}
	switch m.T {
	case "attach":
		// Registered synchronously, so input that follows the attach finds it; built concurrently.
		reg := s.registerAttach(c, m, stream)
		go func() {
			if err := s.finishAttach(c, m, stream, reg); err != nil {
				failed(err)
			}
		}()
	case "detach":
		c.mu.Lock()
		off := c.attached[m.SessionID]
		delete(c.attached, m.SessionID)
		c.mu.Unlock()
		if off != nil {
			off()
		}
		stream.Detach(c.id)
		s.applySize(m.SessionID)
	case "input":
		s.d.SendInput(m.SessionID, m.Data)
	case "resize":
		stream.Resize(c.id, m.Cols, m.Rows)
		s.applySize(m.SessionID)
	case "resync":
		go func() {
			if _, err := s.sendPosition(c, m.SessionID, stream, m.HaveEpoch, m.HaveSeq, m.HasPos); err != nil {
				failed(err)
			}
		}()
	}
}

type attachQueue struct {
	mu      sync.Mutex
	queued  []Chunk
	bytes   int
	dropped bool
	live    bool
	here    bool
}

func (s *WSServer) chunkFrame(id string, ch Chunk) ChunkFrame {
	return ChunkFrame{T: frameChunk, SessionID: id, Epoch: ch.Epoch, Seq: ch.Seq, Data: string(ch.Data)}
}

// registerAttach queues live output until the position is sent, so nothing is painted twice.
func (s *WSServer) registerAttach(c *wsClient, m *ClientMessage, stream *Stream) *attachQueue {
	stream.Attach(c.id, m.Cols, m.Rows)
	s.applySize(m.SessionID)
	q := &attachQueue{}
	c.mu.Lock()
	_, already := c.attached[m.SessionID]
	if !already {
		q.here = true
		c.attached[m.SessionID] = stream.OnChunk(func(ch Chunk) {
			q.mu.Lock()
			if !q.live {
				q.bytes += len(ch.Data)
				if q.bytes > maxQueuedAttachBytes {
					q.queued, q.bytes, q.dropped = nil, 0, true
				} else {
					q.queued = append(q.queued, ch)
				}
				q.mu.Unlock()
				return
			}
			q.mu.Unlock()
			s.send(c, s.chunkFrame(m.SessionID, ch))
		})
	}
	c.mu.Unlock()
	return q
}

func (s *WSServer) finishAttach(c *wsClient, m *ClientMessage, stream *Stream, q *attachQueue) error {
	at, err := s.sendPosition(c, m.SessionID, stream, m.HaveEpoch, m.HaveSeq, m.HasPos)
	q.mu.Lock()
	held, dropped := q.queued, q.dropped
	q.queued, q.live = nil, true
	if err != nil {
		q.mu.Unlock()
		if q.here {
			c.mu.Lock()
			off := c.attached[m.SessionID]
			delete(c.attached, m.SessionID)
			c.mu.Unlock()
			if off != nil {
				off()
			}
			stream.Detach(c.id)
			s.applySize(m.SessionID)
		}
		return err
	}
	// Flushed while holding q.mu, so a live chunk cannot overtake the queued ones.
	if dropped {
		if data, head, covered := stream.Position(stream.Epoch(), at, true); covered {
			if len(data) > 0 {
				s.send(c, ChunkFrame{T: frameChunk, SessionID: m.SessionID, Epoch: stream.Epoch(), Seq: head, Data: string(data)})
			}
		} else {
			data, head := stream.Buffered()
			s.send(c, SnapshotFrame{T: frameSnapshot, SessionID: m.SessionID, Epoch: stream.Epoch(), Seq: head, Data: string(data)})
		}
		held = nil
	}
	for _, ch := range held {
		if ch.Seq <= at {
			continue
		}
		s.send(c, s.chunkFrame(m.SessionID, ch))
	}
	q.mu.Unlock()
	state, code := stream.State()
	s.send(c, StateFrame{T: frameState, SessionID: m.SessionID, State: state, ExitCode: code})
	return nil
}

// sendPosition sends the bytes a covered client is missing, or a snapshot, and returns its seq.
func (s *WSServer) sendPosition(c *wsClient, id string, stream *Stream, epoch string, seq int64, hasPos bool) (int64, error) {
	if hasPos {
		if data, head, covered := stream.Position(epoch, seq, true); covered {
			if len(data) > 0 {
				s.send(c, ChunkFrame{T: frameChunk, SessionID: id, Epoch: stream.Epoch(), Seq: head, Data: string(data)})
			}
			return head, nil
		}
	}
	snap, err := s.coalescedSnapshot(id, stream)
	if err != nil {
		return 0, err
	}
	s.send(c, SnapshotFrame{T: frameSnapshot, SessionID: id, Epoch: snap.Epoch, Seq: snap.Seq,
		History: snap.History, Data: snap.Data, Modes: snap.Modes})
	return snap.Seq, nil
}

// coalescedSnapshot shares an in-flight build's success, but not its failure beyond a bound.
func (s *WSServer) coalescedSnapshot(id string, stream *Stream) (*Snapshot, error) {
	inherited := -1
	failures := 0
	// The lookup and the registration share one critical section, so a burst cannot start two builds.
	s.snapMu.Lock()
	for {
		call, ok := s.snapshots[id]
		if !ok || call.generation == inherited || failures >= maxInheritedSnapshotErrors {
			break
		}
		s.snapMu.Unlock()
		<-call.done
		if call.err == nil {
			return call.snap, nil
		}
		inherited = call.generation
		failures++
		s.snapMu.Lock()
	}
	gen := s.generation
	s.generation++
	call := &snapshotCall{generation: gen, done: make(chan struct{})}
	s.snapshots[id] = call
	s.snapMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), s.d.SnapshotLimit)
	defer cancel()
	result := make(chan struct{})
	go func() {
		call.snap, call.err = buildSnapshot(ctx, SnapshotSources{
			Epoch:          stream.Epoch(),
			CaptureHistory: func(ctx context.Context) (string, error) { return s.d.CaptureHistory(ctx, id) },
			Alternate:      func(ctx context.Context) (bool, error) { return s.d.IsAlternate(ctx, id) },
			PaneModes:      func(ctx context.Context) (string, error) { return s.d.PaneModes(ctx, id) },
			Repaint:        func(ctx context.Context) ([]byte, int64, error) { return s.d.Repaint(ctx, id) },
			Settle: func(ctx context.Context) {
				if rows := stream.MinRows(); s.d.SettleRows != nil && rows > 0 {
					s.d.SettleRows(ctx, id, rows)
				}
			},
		})
		close(result)
	}()
	select {
	case <-result:
	case <-ctx.Done():
		call.snap, call.err = nil, fmt.Errorf("the snapshot for %s did not finish within %v", id, s.d.SnapshotLimit)
	}
	s.snapMu.Lock()
	if s.snapshots[id] == call {
		delete(s.snapshots, id)
	}
	s.snapMu.Unlock()
	snap, err := call.snap, call.err
	close(call.done)
	return snap, err
}

func (s *WSServer) heartbeat() {
	t := time.NewTicker(s.d.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			s.mu.Lock()
			clients := make([]*wsClient, 0, len(s.clients))
			for c := range s.clients {
				clients = append(clients, c)
			}
			s.mu.Unlock()
			for _, c := range clients {
				go func(c *wsClient) {
					// A pong before the next tick, so a half-open socket is closed within two intervals.
					ctx, cancel := context.WithTimeout(c.ctx, s.d.PingInterval)
					defer cancel()
					if err := c.conn.Ping(ctx); err != nil {
						c.cancel()
						_ = c.conn.CloseNow()
					}
				}(c)
				s.send(c, PingFrame{T: framePing, IntervalMs: s.d.PingInterval.Milliseconds()})
			}
		}
	}
}

// PushState tells every open socket a session's state, attached to it or not.
func (s *WSServer) PushState(id string, state SessionState, exitCode *int) {
	frame := StateFrame{T: frameState, SessionID: id, State: state, ExitCode: exitCode}
	s.mu.Lock()
	clients := make([]*wsClient, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.mu.Unlock()
	for _, c := range clients {
		s.send(c, frame)
	}
}
