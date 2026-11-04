package main

// Everything the server sends or accepts, as types. src/client/wire.gen.ts is generated from this
// file by wire_gen_test.go, so the client is type-checked against what the server actually sends.
// A `ts` tag is the TypeScript type verbatim, for literals the Go type cannot express.

// ---- WebSocket frames, server to client

const (
	frameHello    = "hello"
	frameSnapshot = "snapshot"
	frameChunk    = "chunk"
	frameState    = "state"
	frameSessions = "sessions"
	framePing     = "ping"
	frameError    = "error"
)

// HelloFrame states the pane width this server's PTYs hold, on connect.
type HelloFrame struct {
	T    string `json:"t" ts:"\"hello\""`
	Cols int    `json:"cols"`
}

// SnapshotFrame is a cold repaint: scrollback, the modes a repaint does not carry, then the screen.
type SnapshotFrame struct {
	T         string `json:"t" ts:"\"snapshot\""`
	SessionID string `json:"sessionId"`
	Epoch     string `json:"epoch"`
	Seq       int64  `json:"seq"`
	History   string `json:"history,omitempty"`
	Data      string `json:"data"`
	Modes     string `json:"modes,omitempty"`
}

// ChunkFrame is live output; seq is the byte count through its end, within epoch.
type ChunkFrame struct {
	T         string `json:"t" ts:"\"chunk\""`
	SessionID string `json:"sessionId"`
	Epoch     string `json:"epoch"`
	Seq       int64  `json:"seq"`
	Data      string `json:"data"`
}

// StateFrame is a session's state, pushed to every socket whether attached or not.
type StateFrame struct {
	T         string       `json:"t" ts:"\"state\""`
	SessionID string       `json:"sessionId"`
	State     SessionState `json:"state"`
	ExitCode  *int         `json:"exitCode,omitempty"`
}

// SessionsFrame is the whole list, sent once on connect as the baseline for every later delta.
type SessionsFrame struct {
	T        string    `json:"t" ts:"\"sessions\""`
	Sessions []Session `json:"sessions"`
}

// PingFrame is the heartbeat JavaScript can see; it states its own interval.
type PingFrame struct {
	T          string `json:"t" ts:"\"ping\""`
	IntervalMs int64  `json:"intervalMs"`
}

// ErrorFrame is a sentence the client renders verbatim.
type ErrorFrame struct {
	T         string `json:"t" ts:"\"error\""`
	SessionID string `json:"sessionId,omitempty"`
	Message   string `json:"message"`
}

// ---- WebSocket frames, client to server (parsed by parseClientMessage, which validates them)

type AttachFrame struct {
	T         string `json:"t" ts:"\"attach\""`
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	HaveEpoch string `json:"haveEpoch,omitempty"`
	HaveSeq   *int64 `json:"haveSeq,omitempty"`
}

type DetachFrame struct {
	T         string `json:"t" ts:"\"detach\""`
	SessionID string `json:"sessionId"`
}

type InputFrame struct {
	T         string `json:"t" ts:"\"input\""`
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

type ResizeFrame struct {
	T         string `json:"t" ts:"\"resize\""`
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

type ResyncFrame struct {
	T         string `json:"t" ts:"\"resync\""`
	SessionID string `json:"sessionId"`
	HaveEpoch string `json:"haveEpoch"`
	HaveSeq   int64  `json:"haveSeq"`
}

// ---- HTTP response bodies

type ErrorResponse struct {
	Error string `json:"error"`
}

type HealthResponse struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
}

type ProbeResponse struct {
	OK bool `json:"ok" ts:"true"`
}

type HookResponse struct {
	OK    bool          `json:"ok" ts:"true"`
	State *SessionState `json:"state"`
}

type SessionsResponse struct {
	Sessions []Session `json:"sessions"`
}

type AgentsResponse struct {
	Agents []AgentSummary `json:"agents"`
}

type CwdsResponse struct {
	Cwds []Cwd `json:"cwds"`
}

type ProcessesResponse struct {
	Sessions []SessionProcesses `json:"sessions"`
}

type UploadResponse struct {
	Path string `json:"path"`
}

type ClosedResponse struct {
	Closed bool `json:"closed" ts:"true"`
}
