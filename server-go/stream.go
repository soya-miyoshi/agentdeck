package main

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Port of src/ring-buffer.ts and src/stream.ts: seq is a cumulative byte count, meaningful only
// inside an epoch, and state is exit, then a declared state, then output cadence.

const (
	defaultRingCapacity  = 256 * 1024
	workingByteThreshold = 16
	workingLinger        = 2 * time.Second
)

type SessionState string

const (
	StateWorking SessionState = "working"
	StateWaiting SessionState = "waiting"
	StateIdle    SessionState = "idle"
	StateExited  SessionState = "exited"
)

// RingBuffer holds the most recent output. Not safe for concurrent use; Stream guards it.
type RingBuffer struct {
	epoch    string
	capacity int
	data     []byte
	headSeq  int64
}

func newRingBuffer(epoch string, capacity int) *RingBuffer {
	if capacity <= 0 {
		panic("ring buffer capacity must be positive")
	}
	return &RingBuffer{epoch: epoch, capacity: capacity}
}

func (b *RingBuffer) tailSeq() int64 { return b.headSeq - int64(len(b.data)) }

// append stores chunk and returns the seq after it; the oldest bytes are sliced off to fit.
func (b *RingBuffer) append(chunk []byte) int64 {
	if len(chunk) == 0 {
		return b.headSeq
	}
	b.data = append(b.data, chunk...)
	b.headSeq += int64(len(chunk))
	if excess := len(b.data) - b.capacity; excess > 0 {
		b.data = append([]byte(nil), b.data[excess:]...)
	}
	return b.headSeq
}

// covers reports whether a client at (epoch, seq) can be served from the buffer alone.
func (b *RingBuffer) covers(epoch string, seq int64, haveSeq bool) bool {
	if epoch != b.epoch || !haveSeq {
		return false
	}
	return seq <= b.headSeq && seq >= b.tailSeq()
}

// since returns the bytes after seq. Callers must check covers first.
func (b *RingBuffer) since(seq int64) []byte {
	skip := seq - b.tailSeq()
	return append([]byte(nil), b.data[skip:]...)
}

func (b *RingBuffer) snapshot() []byte { return append([]byte(nil), b.data...) }

type Chunk struct {
	Epoch string
	Seq   int64
	Data  []byte
}

type clientSize struct{ cols, rows int }

// Stream is one session's output for the life of this process, whoever is watching.
type Stream struct {
	mu              sync.Mutex
	sessionID       string
	buf             *RingBuffer
	lastOutputAt    time.Time
	bytesSinceQuiet int
	declared        SessionState
	exitCode        *int
	nextListener    int
	listeners       map[int]func(Chunk)
	clients         map[string]clientSize
	now             func() time.Time // swapped in tests to drive cadence
	// hushUntil: output before it is our own resize or repaint, not the agent doing anything.
	hushUntil time.Time
}

func newStream(sessionID string) *Stream {
	var raw [8]byte
	_, _ = rand.Read(raw[:])
	return &Stream{
		sessionID: sessionID,
		buf:       newRingBuffer(hex.EncodeToString(raw[:]), defaultRingCapacity),
		listeners: map[int]func(Chunk){},
		clients:   map[string]clientSize{},
		now:       time.Now,
	}
}

func (s *Stream) Epoch() string { return s.buf.epoch }

// Write records output and hands it to every listener, outside the lock.
func (s *Stream) Write(data []byte) {
	if len(data) == 0 {
		return
	}
	s.mu.Lock()
	now := s.now()
	if now.Before(s.hushUntil) {
		// Buffered and sent like any output, but it says nothing about the agent: a tab being
		// looked at must not read "working", nor lose the "waiting" it was opened to answer.
		s.deliverLocked(data)
		return
	}
	if now.Sub(s.lastOutputAt) > workingLinger {
		s.bytesSinceQuiet = 0
	}
	s.bytesSinceQuiet += len(data)
	s.lastOutputAt = now
	if s.declared == StateWaiting {
		s.declared = ""
	}
	s.deliverLocked(data)
}

// deliverLocked buffers output and hands it to every listener, releasing the lock first.
func (s *Stream) deliverLocked(data []byte) {
	seq := s.buf.append(data)
	chunk := Chunk{Epoch: s.buf.epoch, Seq: seq, Data: data}
	listeners := make([]func(Chunk), 0, len(s.listeners))
	for _, l := range s.listeners {
		listeners = append(listeners, l)
	}
	s.mu.Unlock()
	for _, l := range listeners {
		l(chunk)
	}
}

// Hush discounts output for d: what follows a resize or a repaint is tmux redrawing for us.
func (s *Stream) Hush(d time.Duration) {
	s.mu.Lock()
	if until := s.now().Add(d); until.After(s.hushUntil) {
		s.hushUntil = until
	}
	s.mu.Unlock()
}

func (s *Stream) State() (SessionState, *int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.declared != "" {
		return s.declared, s.exitCode
	}
	if s.now().Sub(s.lastOutputAt) <= workingLinger && s.bytesSinceQuiet >= workingByteThreshold {
		return StateWorking, s.exitCode
	}
	return StateIdle, s.exitCode
}

// Declare records a statement (a hook, or exit) that outranks cadence. exited is sticky.
func (s *Stream) Declare(state SessionState, exitCode *int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.declared == StateExited && state != StateExited {
		return
	}
	s.declared = state
	if exitCode != nil {
		s.exitCode = exitCode
	}
}

func (s *Stream) OnChunk(l func(Chunk)) (off func()) {
	s.mu.Lock()
	id := s.nextListener
	s.nextListener++
	s.listeners[id] = l
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.listeners, id)
		s.mu.Unlock()
	}
}

func (s *Stream) Attach(clientID string, cols, rows int) {
	s.mu.Lock()
	s.clients[clientID] = clientSize{cols, rows}
	s.mu.Unlock()
}

func (s *Stream) Detach(clientID string) {
	s.mu.Lock()
	delete(s.clients, clientID)
	s.mu.Unlock()
}

// Resize only moves a client that is attached, so a detached tab cannot shrink the pane.
func (s *Stream) Resize(clientID string, cols, rows int) {
	s.mu.Lock()
	if _, ok := s.clients[clientID]; ok {
		s.clients[clientID] = clientSize{cols, rows}
	}
	s.mu.Unlock()
}

// MinRows is the smallest row count over attached clients, or 0 when nobody is attached.
func (s *Stream) MinRows() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	min := 0
	for _, c := range s.clients {
		if min == 0 || c.rows < min {
			min = c.rows
		}
	}
	return min
}

// Position plans what a client at (epoch, seq) needs: the bytes it is missing, or a snapshot.
func (s *Stream) Position(epoch string, seq int64, haveSeq bool) (data []byte, head int64, covered bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.buf.covers(epoch, seq, haveSeq) {
		return nil, s.buf.headSeq, false
	}
	return s.buf.since(seq), s.buf.headSeq, true
}

func (s *Stream) Buffered() ([]byte, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.snapshot(), s.buf.headSeq
}
