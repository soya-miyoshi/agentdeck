package main

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The client keeps its own copy of the wire shapes in src/client/wire.ts. These tests are what stop
// the two halves drifting apart, since the compiler no longer shares one definition between them.

func wireSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../src/client/wire.ts")
	if err != nil {
		t.Fatalf("read wire.ts: %v", err)
	}
	return string(b)
}

func wireConst(t *testing.T, src, name string) int64 {
	t.Helper()
	m := regexp.MustCompile(`(?m)^(?:export )?const ` + name + ` = ([0-9_ *]+);`).FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("wire.ts has no numeric const %s", name)
	}
	total := int64(1)
	for _, part := range strings.Split(strings.ReplaceAll(m[1], "_", ""), "*") {
		n, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		total *= n
	}
	return total
}

func TestWire_ConstantsMatchTheServer(t *testing.T) {
	src := wireSource(t)
	cases := map[string]int64{
		"PANE_COLS":             paneCols,
		"PING_INTERVAL_MS":      pingInterval.Milliseconds(),
		"MAX_FRAMES_PER_WINDOW": maxFramesPerWindow,
		"MAX_FRAME_BYTES":       maxFrameBytes,
		"MIN_DIMENSION":         minDimension,
		"MAX_DIMENSION":         maxDimension,
	}
	for name, want := range cases {
		if got := wireConst(t, src, name); got != want {
			t.Errorf("wire.ts %s = %d, server-go has %d", name, got, want)
		}
	}
}

func TestWire_SessionStatesMatchTheServer(t *testing.T) {
	m := regexp.MustCompile(`export type SessionState = ([^;]+);`).FindStringSubmatch(wireSource(t))
	if m == nil {
		t.Fatal("wire.ts has no SessionState")
	}
	var client []string
	for _, s := range regexp.MustCompile(`"([a-z]+)"`).FindAllStringSubmatch(m[1], -1) {
		client = append(client, s[1])
	}
	server := []string{string(StateWorking), string(StateWaiting), string(StateIdle), string(StateExited)}
	sort.Strings(client)
	sort.Strings(server)
	if !reflect.DeepEqual(client, server) {
		t.Fatalf("client states %v, server states %v", client, server)
	}
}

// wireFields is the field names of one `export interface Name { ... }` in wire.ts.
func wireFields(t *testing.T, name string) []string {
	t.Helper()
	m := regexp.MustCompile(`(?s)export interface ` + name + ` \{(.*?)\n\}`).FindStringSubmatch(wireSource(t))
	if m == nil {
		t.Fatalf("wire.ts has no interface %s", name)
	}
	var fields []string
	for _, f := range regexp.MustCompile(`(?m)^\s+([A-Za-z]+)\??:`).FindAllStringSubmatch(m[1], -1) {
		fields = append(fields, f[1])
	}
	sort.Strings(fields)
	return fields
}

// jsonFields is the JSON keys a Go value marshals to, with every optional field populated.
func jsonFields(t *testing.T, v any) []string {
	t.Helper()
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func TestWire_ShapesMatchTheServer(t *testing.T) {
	code := 1
	cases := map[string]any{
		"Session":      Session{ID: "a", ExitCode: &code, WaitingDetectionLost: true},
		"AgentSummary": AgentSummary{},
		"Cwd":          Cwd{},
	}
	for name, v := range cases {
		if got, want := wireFields(t, name), jsonFields(t, v); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: wire.ts has %v, the server sends %v", name, got, want)
		}
	}
}
