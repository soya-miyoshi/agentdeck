package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Port of src/uploads.ts: the file name is entirely ours, a random stem and a safelisted extension.

var uploadExtensions = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}

func extensionFor(contentType string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	return uploadExtensions[base]
}

var unsafeSegment = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

func safeSegment(v string) string {
	s := unsafeSegment.ReplaceAllString(v, "-")
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}

type UnsupportedImageError struct{ contentType string }

func (e *UnsupportedImageError) Error() string {
	if e.contentType == "" {
		return "cannot accept an unnamed type"
	}
	return "cannot accept " + e.contentType
}

type UploadStore struct {
	root string
	keep int
}

func newUploadStore(root string) *UploadStore { return &UploadStore{root: root, keep: 20} }

// Save writes one image 0600 and keeps only the newest `keep` in that session's directory.
func (u *UploadStore) Save(sessionID, contentType string, data []byte) (string, error) {
	ext := extensionFor(contentType)
	if ext == "" {
		return "", &UnsupportedImageError{contentType}
	}
	dir := filepath.Join(u.root, safeSegment(sessionID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	var raw [6]byte
	_, _ = rand.Read(raw[:])
	path := filepath.Join(dir, hex.EncodeToString(raw[:])+"."+ext)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	u.prune(dir)
	return path, nil
}

func (u *UploadStore) prune(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type dated struct {
		path string
		at   int64
	}
	var files []dated
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, dated{filepath.Join(dir, e.Name()), info.ModTime().UnixNano()})
	}
	if len(files) <= u.keep {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at > files[j].at })
	for _, f := range files[u.keep:] {
		_ = os.Remove(f.path)
	}
}
