package main

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// A file named on the command line (or by a later launch), or one found in a folder named there.
// Folder is the name of the folder it was found in, so the page can make a group of it.
type localFile struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	Folder string `json:"folder,omitempty"`
	Kind   string `json:"kind"`
	path   string
	// From a watched folder (watch.go): not among the files the page opens at once.
	watched bool
}

type localFiles struct {
	mu    sync.RWMutex
	files []localFile
	index map[string]int
}

const (
	// A plate study can hold thousands of FCS files.
	maxFolderFiles = 20000
	// A folder walk stops after this many entries, so the home folder does not walk for ever.
	maxFolderEntries = 200000
)

func newLocalFiles() *localFiles {
	return &localFiles{index: map[string]int{}}
}

// fileKind classifies a file CytoWeave can open by its extension; "" means it cannot.
func fileKind(name string) string {
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".fcs"), strings.HasSuffix(lower, ".lmd"):
		return "fcs"
	case strings.HasSuffix(lower, ".cwz"), strings.HasSuffix(lower, ".cytoweave.json"):
		return "workspace"
	case strings.HasSuffix(lower, ".wsp"), strings.HasSuffix(lower, ".wspt"), strings.HasSuffix(lower, ".flowjo"):
		return "flowjo"
	case strings.HasSuffix(lower, ".xml"):
		return "gatingml"
	case strings.HasSuffix(lower, ".csv"), strings.HasSuffix(lower, ".tsv"):
		return "table"
	case strings.HasSuffix(lower, ".acs"), strings.HasSuffix(lower, ".zip"):
		return "archive"
	case strings.HasSuffix(lower, ".svg"), strings.HasSuffix(lower, ".png"), strings.HasSuffix(lower, ".pdf"):
		// A figure CytoWeave exported, which carries its analysis.
		return "figure"
	}
	return ""
}

func absPath(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "~" || strings.HasPrefix(name, "~/") || strings.HasPrefix(name, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			name = filepath.Join(home, name[1:])
		}
	}
	return filepath.Abs(name)
}

// add registers files and the openable files inside folders; it returns what it skipped.
func (l *localFiles) add(paths []string) []string {
	_, problems := l.register(paths)
	return problems
}

// register adds files like add and returns them (with their URLs), including ones registered
// before.
func (l *localFiles) register(paths []string) ([]localFile, []string) {
	var problems []string
	var found []localFile
	for _, raw := range paths {
		path, err := absPath(raw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("skipping %s: %v", raw, err))
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			problems = append(problems, fmt.Sprintf("skipping %s: %v", raw, err))
			continue
		}
		if info.IsDir() {
			files, problem := walkFolder(path)
			if problem != "" {
				problems = append(problems, problem)
			}
			if len(files) == 0 && problem == "" {
				problems = append(problems, fmt.Sprintf("skipping %s: no FCS files or workspaces in the folder", raw))
			}
			found = append(found, files...)
			continue
		}
		kind := fileKind(info.Name())
		if kind == "" {
			problems = append(problems, fmt.Sprintf("skipping %s: not a file CytoWeave opens", raw))
			continue
		}
		found = append(found, localFile{Name: info.Name(), Size: info.Size(), Kind: kind, path: path})
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	registered := make([]localFile, 0, len(found))
	for _, file := range found {
		if index, known := l.index[file.path]; known {
			registered = append(registered, l.files[index])
			continue
		}
		index := len(l.files)
		file.URL = "/api/local/" + strconv.Itoa(index)
		l.index[file.path] = index
		l.files = append(l.files, file)
		registered = append(registered, file)
	}
	return registered, problems
}

func walkFolder(dir string) ([]localFile, string) {
	folder := filepath.Base(dir)
	var files []localFile
	visited := 0
	problem := ""
	filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > maxFolderEntries {
			problem = fmt.Sprintf("%s: stopped after %d entries", dir, maxFolderEntries)
			return filepath.SkipAll
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") && path != dir {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		kind := fileKind(name)
		if kind == "" || kind == "table" || kind == "gatingml" || kind == "figure" {
			// Tables, XML and images inside a data folder are usually not analyses; name them directly.
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		if len(files) >= maxFolderFiles {
			problem = fmt.Sprintf("%s: opened the first %d files", dir, maxFolderFiles)
			return filepath.SkipAll
		}
		files = append(files, localFile{Name: name, Size: info.Size(), Kind: kind, Folder: folder, path: path})
		return nil
	})
	sort.SliceStable(files, func(i, j int) bool { return naturalLess(files[i].path, files[j].path) })
	return files, problem
}

func (l *localFiles) list() []localFile {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]localFile, len(l.files))
	copy(out, l.files)
	return out
}

// path is the location on disk of the local file with this index.
func (l *localFiles) path(index string) (string, bool) {
	i, err := strconv.Atoi(index)
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err != nil || i < 0 || i >= len(l.files) {
		return "", false
	}
	return l.files[i].path, true
}

func (l *localFiles) serve(w http.ResponseWriter, r *http.Request) {
	index, err := strconv.Atoi(r.PathValue("index"))
	l.mu.RLock()
	if err != nil || index < 0 || index >= len(l.files) {
		l.mu.RUnlock()
		writeError(w, http.StatusNotFound, "No such local file.")
		return
	}
	file := l.files[index]
	l.mu.RUnlock()
	handle, err := os.Open(file.path)
	if err != nil {
		writeError(w, http.StatusNotFound, "The file can no longer be read.")
		return
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "The file can no longer be read.")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, file.Name, info.ModTime(), handle)
}

// naturalLess orders "well 2" before "well 10", as plate files are usually numbered.
func naturalLess(a, b string) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ca, cb := a[i], b[j]
		if isDigit(ca) && isDigit(cb) {
			si := i
			for i < len(a) && isDigit(a[i]) {
				i++
			}
			sj := j
			for j < len(b) && isDigit(b[j]) {
				j++
			}
			na := strings.TrimLeft(a[si:i], "0")
			nb := strings.TrimLeft(b[sj:j], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		la, lb := lowerByte(ca), lowerByte(cb)
		if la != lb {
			return la < lb
		}
		i++
		j++
	}
	return len(a)-i < len(b)-j
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func lowerByte(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}
