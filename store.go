package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// The workspace library: workspaces as JSON documents and the FCS files they use, stored once
// each under their SHA-256. The browser keeps the same library in its own storage when CytoWeave
// is served without this program.
type store struct {
	dir string
}

const (
	maxWorkspaceBytes = 512 << 20
	maxFileBytes      = 8 << 30
)

var (
	workspaceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
	sha256Pattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func defaultDataDir() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "CytoWeave")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".cytoweave")
	}
	return ".cytoweave"
}

func platformName() string {
	return runtime.GOOS + "/" + runtime.GOARCH
}

func openStore(dir string) (*store, error) {
	if dir == "" {
		return nil, errors.New("no data folder")
	}
	for _, sub := range []string{"workspaces", "files", "trash"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, err
		}
	}
	return &store{dir: dir}, nil
}

func (s *store) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/library/workspaces", s.listWorkspaces)
	mux.HandleFunc("GET /api/library/workspaces/{id}", s.getWorkspace)
	mux.HandleFunc("PUT /api/library/workspaces/{id}", s.putWorkspace)
	mux.HandleFunc("DELETE /api/library/workspaces/{id}", s.deleteWorkspace)
	mux.HandleFunc("GET /api/library/files/{sha}", s.getFile)
	mux.HandleFunc("HEAD /api/library/files/{sha}", s.getFile)
	mux.HandleFunc("PUT /api/library/files/{sha}", s.putFile)
	mux.HandleFunc("GET /api/library/has/{sha}", s.hasFile)
}

// hasFile answers whether the library holds a file, without the 404 a HEAD request would log.
func (s *store) hasFile(w http.ResponseWriter, r *http.Request) {
	path, ok := s.filePath(r.PathValue("sha"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid file hash.")
		return
	}
	_, err := os.Stat(path)
	writeJSON(w, map[string]bool{"exists": err == nil})
}

type workspaceSummary struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Modified string `json:"modified"`
	Samples  int    `json:"samples"`
	Size     int64  `json:"size"`
}

func (s *store) workspacePath(id string) (string, bool) {
	if !workspaceIDPattern.MatchString(id) {
		return "", false
	}
	return filepath.Join(s.dir, "workspaces", id+".json"), true
}

func (s *store) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(filepath.Join(s.dir, "workspaces"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	list := []workspaceSummary{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !workspaceIDPattern.MatchString(id) {
			continue
		}
		summary, err := readSummary(filepath.Join(s.dir, "workspaces", name))
		if err != nil {
			continue
		}
		summary.ID = id
		list = append(list, summary)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Modified > list[j].Modified })
	writeJSON(w, map[string]any{"workspaces": list})
}

func readSummary(path string) (workspaceSummary, error) {
	file, err := os.Open(path)
	if err != nil {
		return workspaceSummary{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return workspaceSummary{}, err
	}
	var doc struct {
		Name     string            `json:"name"`
		Modified string            `json:"modified"`
		Samples  []json.RawMessage `json:"samples"`
	}
	if err := json.NewDecoder(file).Decode(&doc); err != nil {
		return workspaceSummary{}, err
	}
	modified := doc.Modified
	if modified == "" {
		modified = info.ModTime().UTC().Format(time.RFC3339)
	}
	return workspaceSummary{Name: doc.Name, Modified: modified, Samples: len(doc.Samples), Size: info.Size()}, nil
}

func (s *store) getWorkspace(w http.ResponseWriter, r *http.Request) {
	path, ok := s.workspacePath(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid workspace id.")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "No such workspace.")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.Copy(w, file)
}

func (s *store) putWorkspace(w http.ResponseWriter, r *http.Request) {
	path, ok := s.workspacePath(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid workspace id.")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWorkspaceBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body) > maxWorkspaceBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "The workspace is too large.")
		return
	}
	if !json.Valid(body) {
		writeError(w, http.StatusBadRequest, "The workspace is not valid JSON.")
		return
	}
	if err := writeAtomic(path, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "size": len(body)})
}

// deleteWorkspace moves the workspace into trash/ rather than removing it.
func (s *store) deleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	path, ok := s.workspacePath(id)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid workspace id.")
		return
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	target := filepath.Join(s.dir, "trash", fmt.Sprintf("%s-%s.json", id, stamp))
	if err := os.Rename(path, target); err != nil {
		writeError(w, http.StatusNotFound, "No such workspace.")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "trash": target})
}

func (s *store) filePath(sha string) (string, bool) {
	if !sha256Pattern.MatchString(sha) {
		return "", false
	}
	return filepath.Join(s.dir, "files", sha[:2], sha+".fcs"), true
}

func (s *store) getFile(w http.ResponseWriter, r *http.Request) {
	path, ok := s.filePath(r.PathValue("sha"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid file hash.")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "Not in the library.")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	// Content-addressed: a hash names one content for ever.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), file)
}

// putFile stores an FCS file under its SHA-256, which it checks while streaming to disk.
func (s *store) putFile(w http.ResponseWriter, r *http.Request) {
	sha := r.PathValue("sha")
	path, ok := s.filePath(sha)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid file hash.")
		return
	}
	if _, err := os.Stat(path); err == nil {
		writeJSON(w, map[string]any{"ok": true, "existing": true})
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".upload-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.Remove(temp.Name())
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(r.Body, maxFileBytes+1))
	closeErr := temp.Close()
	if err != nil || closeErr != nil {
		writeError(w, http.StatusBadRequest, "The upload was interrupted.")
		return
	}
	if written > maxFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "The file is too large.")
		return
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != sha {
		writeError(w, http.StatusBadRequest, "The content does not match its hash.")
		return
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "size": written})
}

// writeAtomic replaces path with data so a reader never sees a half-written file.
func writeAtomic(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".save-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}
