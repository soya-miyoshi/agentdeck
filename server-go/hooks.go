package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// Port of src/claude-hooks.ts. The hook command is this binary (`agentdeck hook`) by absolute path,
// reading the secret from its environment, so it never appears in an argv.

const (
	hookMaxBodyBytes = 256 * 1024
	maxFieldChars    = 16 * 1024
	hookReadLimit    = 1024 * 1024
	hookMarker       = "/api/hooks/"
)

var workingEvents = map[string]bool{"UserPromptSubmit": true, "PreToolUse": true, "PostToolUse": true}
var informationalEvents = map[string]bool{"SubagentStop": true}
var informationalNotificationTypes = map[string]bool{}
var installedEvents = []string{"UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification"}

// mapHookEvent maps one payload to a state, or "" for "log it, change nothing".
func mapHookEvent(payload any) (SessionState, string) {
	obj, ok := payload.(map[string]any)
	if !ok {
		return "", "payload is not an object"
	}
	event, _ := obj["hook_event_name"].(string)
	if event == "" {
		return "", "payload has no hook_event_name"
	}
	if workingEvents[event] {
		return StateWorking, event
	}
	if event == "Stop" {
		return StateWaiting, "Stop: the turn ended"
	}
	if event == "Notification" {
		t, isString := obj["notification_type"].(string)
		if isString && informationalNotificationTypes[t] {
			return "", "Notification " + t + " is informational"
		}
		if !isString {
			t = "<no notification_type>"
		}
		return StateWaiting, "Notification " + t
	}
	if informationalEvents[event] {
		return "", event + " is informational: the parent turn continues"
	}
	return "", "unrecognised event " + event + ": no state changed"
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// hookCommand is the line Claude Code runs per event: it exits 0 whatever happens.
func hookCommand(port int, binary string) (string, error) {
	if !strings.HasPrefix(binary, "/") {
		return "", fmt.Errorf("hook interpreter must be an absolute path, got %s", binary)
	}
	// The marker is a trailing comment: anywhere earlier it would comment out the redirect and exit.
	return fmt.Sprintf(`[ -n "$AGENTDECK_SESSION_ID" ] || exit 0; AGENTDECK_HOOK_PORT=%d %s hook >/dev/null 2>&1; exit 0 # %s`,
		port, shellQuote(binary), hookMarker), nil
}

func isOurHook(hook any) bool {
	obj, ok := hook.(map[string]any)
	if !ok {
		return false
	}
	cmd, ok := obj["command"].(string)
	return ok && strings.Contains(cmd, hookMarker) && strings.Contains(cmd, "AGENTDECK_SESSION_ID")
}

// mergeHookSettings replaces our entries and keeps every key and hook it did not write.
func mergeHookSettings(existing any, command string) map[string]any {
	root := map[string]any{}
	if obj, ok := existing.(map[string]any); ok {
		for k, v := range obj {
			root[k] = v
		}
	}
	hooks := map[string]any{}
	if obj, ok := root["hooks"].(map[string]any); ok {
		for k, v := range obj {
			hooks[k] = v
		}
	}
	for _, event := range installedEvents {
		entries, _ := hooks[event].([]any)
		kept := []any{}
		for _, entry := range entries {
			obj, ok := entry.(map[string]any)
			if !ok {
				kept = append(kept, entry)
				continue
			}
			inner, ok := obj["hooks"].([]any)
			if !ok {
				kept = append(kept, entry)
				continue
			}
			remaining := []any{}
			for _, h := range inner {
				if !isOurHook(h) {
					remaining = append(remaining, h)
				}
			}
			switch {
			case len(remaining) == len(inner):
				kept = append(kept, entry)
			case len(remaining) > 0:
				copyObj := map[string]any{}
				for k, v := range obj {
					copyObj[k] = v
				}
				copyObj["hooks"] = remaining
				kept = append(kept, copyObj)
			}
		}
		kept = append(kept, map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command}}})
		hooks[event] = kept
	}
	root["hooks"] = hooks
	return root
}

// jsonIndent matches JSON.stringify(v, undefined, 2): no HTML escaping, two-space indent.
func jsonIndent(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// installHookSettings merges once at boot; malformed JSON is an error, never an overwrite.
func installHookSettings(path, command string) (changed bool, err error) {
	var existing any = map[string]any{}
	before, readErr := os.ReadFile(path)
	if readErr == nil && strings.TrimSpace(string(before)) != "" {
		if err := json.Unmarshal(before, &existing); err != nil {
			return false, err
		}
	}
	after, err := jsonIndent(mergeHookSettings(existing, command))
	if err != nil {
		return false, err
	}
	if readErr == nil && after == string(before) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	return true, os.WriteFile(path, []byte(after), 0o644)
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n])
}

// runHook is `agentdeck hook`: read the payload, trim the long fields, POST it, never fail.
func runHook(stdin io.Reader) {
	id := os.Getenv("AGENTDECK_SESSION_ID")
	if id == "" {
		return
	}
	port := os.Getenv("AGENTDECK_HOOK_PORT")
	if port == "" {
		port = "7777"
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		body, _ := io.ReadAll(io.LimitReader(stdin, hookReadLimit))
		var payload map[string]any
		if json.Unmarshal(body, &payload) == nil && payload != nil {
			for _, k := range []string{"last_assistant_message", "prompt"} {
				if s, ok := payload[k].(string); ok {
					payload[k] = truncateRunes(s, maxFieldChars+1)
				}
			}
			if b, err := json.Marshal(payload); err == nil {
				body = b
			}
		}
		if len(body) > hookMaxBodyBytes {
			return
		}
		req, err := http.NewRequest("POST", "http://127.0.0.1:"+port+hookMarker+url.PathEscape(id), bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("X-Agentdeck-Secret", os.Getenv("AGENTDECK_SECRET"))
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 2 * time.Second}
		if res, err := client.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

var errBodyTooLarge = errors.New("request body too large")

func readBody(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errBodyTooLarge
	}
	return b, nil
}
