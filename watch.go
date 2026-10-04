package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A watched folder, for QC as files are acquired: the instrument (or its export) writes FCS files
// into a folder, and each one is handed to the page once it is complete, so its acquisition QC
// can run while the next tube is acquired. The folder is only read; nothing is written there.
//
// The folder is polled (no platform file-system notifications, which network shares often do not
// deliver). A file is complete when its size and modification time have not changed between two
// polls and its FCS header says the data end within the file. Files present when watching starts
// are counted but not handed over unless the page asks for them (POST /api/watch/existing).

const (
	defaultWatchInterval = time.Second
	// A folder of daily exports can hold many files; a scan stops after this many entries.
	maxWatchEntries = 50000
)

// A file that landed in the watched folder, numbered in the order it landed.
type watchedFile struct {
	Seq int `json:"seq"`
	localFile
	Landed   time.Time `json:"landed"`
	Existing bool      `json:"existing,omitempty"`
}

type watchCandidate struct {
	size    int64
	mod     time.Time
	stable  int
	landed  bool
	present bool // there when watching started
}

type folderWatch struct {
	mu       sync.Mutex
	files    *localFiles
	dir      string
	started  time.Time
	interval time.Duration
	seen     map[string]*watchCandidate
	landed   []watchedFile
	seq      int
	scans    int
	problem  string
	stop     chan struct{}
	done     chan struct{}
}

type watchStatus struct {
	Watching bool          `json:"watching"`
	Folder   string        `json:"folder,omitempty"`
	Name     string        `json:"name,omitempty"`
	Started  *time.Time    `json:"started,omitempty"`
	Interval int64         `json:"intervalMs,omitempty"`
	Existing int           `json:"existing"`
	Pending  []string      `json:"pending"`
	Files    []watchedFile `json:"files"`
	Last     int           `json:"last"`
	Scans    int           `json:"scans"`
	Problem  string        `json:"problem,omitempty"`
}

func newFolderWatch(files *localFiles) *folderWatch {
	return &folderWatch{files: files}
}

// start watches dir (replacing any earlier watch). The files already there are noted, not handed
// over.
func (w *folderWatch) start(dir string, interval time.Duration) error {
	path, err := absPath(dir)
	if err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("cannot watch %s: %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("cannot watch %s: not a folder", dir)
	}
	if interval <= 0 {
		interval = defaultWatchInterval
	}
	w.stopWatching()
	w.mu.Lock()
	w.dir = path
	w.started = time.Now()
	w.interval = interval
	w.seen = map[string]*watchCandidate{}
	w.landed = nil
	w.scans = 0
	w.problem = ""
	w.stop = make(chan struct{})
	w.done = make(chan struct{})
	stop, done := w.stop, w.done
	w.mu.Unlock()
	w.scan(true)
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				w.scan(false)
			}
		}
	}()
	return nil
}

func (w *folderWatch) stopWatching() {
	w.mu.Lock()
	stop, done := w.stop, w.done
	w.stop, w.done = nil, nil
	w.dir = ""
	w.mu.Unlock()
	if stop != nil {
		close(stop)
		<-done
	}
}

// watchable reports whether a file name is one to hand over: FCS files, not hidden, not a
// temporary file an exporter is still writing under another name.
func watchable(name string) bool {
	if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "~") {
		return false
	}
	return fileKind(name) == "fcs"
}

// scan looks at every FCS file in the folder (and its subfolders) once.
func (w *folderWatch) scan(first bool) {
	w.mu.Lock()
	dir := w.dir
	w.mu.Unlock()
	if dir == "" {
		return
	}
	type entry struct {
		path string
		size int64
		mod  time.Time
	}
	var found []entry
	visited := 0
	problem := ""
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > maxWatchEntries {
			problem = fmt.Sprintf("only the first %d entries of the folder are watched", maxWatchEntries)
			return filepath.SkipAll
		}
		if d.IsDir() {
			if path != dir && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !watchable(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		found = append(found, entry{path, info.Size(), info.ModTime()})
		return nil
	})
	if err != nil {
		problem = err.Error()
	}
	if _, statErr := os.Stat(dir); statErr != nil {
		problem = fmt.Sprintf("the folder can no longer be read: %v", statErr)
	}
	sort.SliceStable(found, func(i, j int) bool { return naturalLess(found[i].path, found[j].path) })

	var ready []entry
	w.mu.Lock()
	if w.dir != dir {
		w.mu.Unlock()
		return
	}
	w.scans++
	w.problem = problem
	for _, f := range found {
		c := w.seen[f.path]
		if c == nil {
			w.seen[f.path] = &watchCandidate{size: f.size, mod: f.mod, present: first}
			continue
		}
		if c.landed || c.present {
			continue
		}
		if f.size == c.size && f.mod.Equal(c.mod) {
			c.stable++
		} else {
			c.size, c.mod, c.stable = f.size, f.mod, 0
		}
		if c.stable >= 1 {
			ready = append(ready, f)
		}
	}
	w.mu.Unlock()

	// The header check reads the file, so it runs outside the lock.
	for _, f := range ready {
		if complete, _ := fcsComplete(f.path, f.size); !complete {
			continue
		}
		w.land(dir, f.path, false)
	}
}

// land registers a file with the page's local files and adds it to the landed list.
func (w *folderWatch) land(dir, path string, existing bool) {
	file, err := w.files.addFile(path, filepath.Base(dir))
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.dir != dir {
		return
	}
	c := w.seen[path]
	if c == nil || c.landed {
		return
	}
	if err != nil {
		w.problem = err.Error()
		return
	}
	c.landed = true
	w.seq++
	w.landed = append(w.landed, watchedFile{Seq: w.seq, localFile: file, Landed: time.Now(), Existing: existing})
}

// handOverExisting lands the files that were in the folder when watching started.
func (w *folderWatch) handOverExisting() int {
	w.mu.Lock()
	dir := w.dir
	var paths []string
	for path, c := range w.seen {
		if c.present && !c.landed {
			paths = append(paths, path)
		}
	}
	w.mu.Unlock()
	sort.SliceStable(paths, func(i, j int) bool { return naturalLess(paths[i], paths[j]) })
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil {
			if complete, _ := fcsComplete(path, info.Size()); !complete {
				continue
			}
		}
		w.land(dir, path, true)
	}
	return len(paths)
}

// status describes the watch and the files that landed after sequence number `after`.
func (w *folderWatch) status(after int) watchStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := watchStatus{Pending: []string{}, Files: []watchedFile{}, Last: w.seq}
	if w.dir == "" {
		return out
	}
	started := w.started
	out.Watching = true
	out.Folder = w.dir
	out.Name = filepath.Base(w.dir)
	out.Started = &started
	out.Interval = w.interval.Milliseconds()
	out.Scans = w.scans
	out.Problem = w.problem
	for path, c := range w.seen {
		switch {
		case c.present && !c.landed:
			out.Existing++
		case !c.landed && !c.present:
			out.Pending = append(out.Pending, filepath.Base(path))
		}
	}
	sort.Strings(out.Pending)
	for _, f := range w.landed {
		if f.Seq > after {
			out.Files = append(out.Files, f)
		}
	}
	return out
}

// fcsComplete reports whether an FCS file of this size holds all its data: the HEADER, the TEXT
// segment and the DATA segment it declares (from the HEADER, or from $ENDDATA when the offsets do
// not fit there). A file that is not FCS at all counts as complete, so the page can say so.
func fcsComplete(path string, size int64) (bool, string) {
	f, err := os.Open(path)
	if err != nil {
		return false, err.Error()
	}
	defer f.Close()
	header := make([]byte, 58)
	if _, err := io.ReadFull(f, header); err != nil {
		return false, "the header is not written yet"
	}
	if !bytes.HasPrefix(header, []byte("FCS")) {
		if bytes.Count(header, []byte{0}) == len(header) {
			return false, "the file is still empty"
		}
		return true, "not an FCS file"
	}
	offset := func(a, b int) int64 {
		v, err := strconv.ParseInt(strings.TrimSpace(string(header[a:b])), 10, 64)
		if err != nil {
			return -1
		}
		return v
	}
	textStart, textEnd := offset(10, 18), offset(18, 26)
	dataStart, dataEnd := offset(26, 34), offset(34, 42)
	if textStart < 0 || textEnd < textStart {
		return true, "the header has no TEXT segment"
	}
	if textEnd >= size {
		return false, "the TEXT segment is not written yet"
	}
	if dataStart <= 0 || dataEnd <= 0 {
		// Large files keep their offsets in the TEXT segment.
		length := textEnd - textStart + 1
		if length > 16<<20 {
			return true, "the TEXT segment is too large to check"
		}
		text := make([]byte, length)
		if _, err := f.ReadAt(text, textStart); err != nil {
			return false, "the TEXT segment is not written yet"
		}
		value, ok := fcsKeyword(text, "$ENDDATA")
		if !ok {
			return true, "no $ENDDATA keyword"
		}
		end, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			return true, "an unreadable $ENDDATA keyword"
		}
		dataEnd = end
	}
	if dataEnd >= size {
		return false, fmt.Sprintf("%d of %d bytes written", size, dataEnd+1)
	}
	return true, ""
}

// fcsKeyword finds a keyword's value in a TEXT segment (its first byte is the delimiter; a doubled
// delimiter is an escaped one).
func fcsKeyword(text []byte, key string) (string, bool) {
	if len(text) < 2 {
		return "", false
	}
	delim := text[0]
	var fields []string
	var current []byte
	for i := 1; i < len(text); i++ {
		if text[i] == delim {
			if i+1 < len(text) && text[i+1] == delim {
				current = append(current, delim)
				i++
				continue
			}
			fields = append(fields, string(current))
			current = current[:0]
			continue
		}
		current = append(current, text[i])
	}
	for i := 0; i+1 < len(fields); i += 2 {
		if strings.EqualFold(strings.TrimSpace(fields[i]), key) {
			return fields[i+1], true
		}
	}
	return "", false
}

// --- HTTP ------------------------------------------------------------------------------------

func (w *folderWatch) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/watch", func(rw http.ResponseWriter, r *http.Request) {
		after, _ := strconv.Atoi(r.URL.Query().Get("after"))
		writeJSON(rw, w.status(after))
	})
	mux.HandleFunc("POST /api/watch", func(rw http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			writeError(rw, http.StatusForbidden, "Only this computer may watch a folder.")
			return
		}
		var body struct {
			Path       string `json:"path"`
			IntervalMs int    `json:"intervalMs"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil || strings.TrimSpace(body.Path) == "" {
			writeError(rw, http.StatusBadRequest, "Send {\"path\": \"<folder>\"}.")
			return
		}
		interval := time.Duration(body.IntervalMs) * time.Millisecond
		if interval > 0 && interval < 100*time.Millisecond {
			interval = 100 * time.Millisecond
		}
		if err := w.start(body.Path, interval); err != nil {
			writeError(rw, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(rw, w.status(0))
	})
	mux.HandleFunc("DELETE /api/watch", func(rw http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			writeError(rw, http.StatusForbidden, "Only this computer may stop watching a folder.")
			return
		}
		w.stopWatching()
		writeJSON(rw, w.status(0))
	})
	mux.HandleFunc("POST /api/watch/existing", func(rw http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			writeError(rw, http.StatusForbidden, "Only this computer may open files.")
			return
		}
		if w.status(0).Folder == "" {
			writeError(rw, http.StatusConflict, "No folder is being watched.")
			return
		}
		w.handOverExisting()
		writeJSON(rw, w.status(0))
	})
}

var errNotOpenable = errors.New("not a file CytoWeave opens")

// addFile registers one file found in a watched folder, grouped under the folder's name.
func (l *localFiles) addFile(path, folder string) (localFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return localFile{}, err
	}
	kind := fileKind(info.Name())
	if kind == "" {
		return localFile{}, errNotOpenable
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if index, known := l.index[path]; known {
		// Written again (a re-export): serve its current size.
		l.files[index].Size = info.Size()
		return l.files[index], nil
	}
	index := len(l.files)
	file := localFile{Name: info.Name(), URL: "/api/local/" + strconv.Itoa(index), Size: info.Size(), Folder: folder, Kind: kind, path: path, watched: true}
	l.index[path] = index
	l.files = append(l.files, file)
	return file, nil
}

// opened lists the files named on the command line or by a later launch, which the page opens
// as they come; files from a watched folder reach it through /api/watch instead.
func (l *localFiles) opened() []localFile {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]localFile, 0, len(l.files))
	for _, f := range l.files {
		if !f.watched {
			out = append(out, f)
		}
	}
	return out
}
