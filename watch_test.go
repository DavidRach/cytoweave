package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fcsBytes builds a minimal FCS 3.1 file with `data` bytes of DATA; with largeOffsets the HEADER
// holds zeros and the offsets are only in TEXT ($BEGINDATA, $ENDDATA), as for files over 99 MB.
func fcsBytes(data int, largeOffsets bool) []byte {
	textStart := 58
	build := func(dataStart, dataEnd int) string {
		return fmt.Sprintf("/$BEGINANALYSIS/0/$ENDANALYSIS/0/$BEGINSTEXT/0/$ENDSTEXT/0/$BEGINDATA/%d/$ENDDATA/%d/$PAR/1/$TOT/%d/$DATATYPE/F/$MODE/L/$BYTEORD/1,2,3,4/$NEXTDATA/0/$P1N/FSC-A/$P1B/32/$P1E/0,0/$P1R/262144/", dataStart, dataEnd, data/4)
	}
	// The offsets change the TEXT length; settle them with a fixed width.
	text := build(10000000, 10000000+data-1)
	dataStart := textStart + len(text)
	text = build(dataStart, dataStart+data-1)
	for len(text) < dataStart-textStart {
		text += " "
	}
	dataStart = textStart + len(text)
	text = build(dataStart, dataStart+data-1)
	textEnd := textStart + len(text) - 1
	hd, he := dataStart, dataStart+data-1
	if largeOffsets {
		hd, he = 0, 0
	}
	header := fmt.Sprintf("FCS3.1    %8d%8d%8d%8d%8d%8d", textStart, textEnd, hd, he, 0, 0)
	out := []byte(header + text)
	for len(out) < dataStart {
		out = append(out, ' ')
	}
	out = append(out, make([]byte, data)...)
	return append(out, []byte("00000000")...)
}

func waitUntil(t *testing.T, what string, timeout time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func landedNames(w *folderWatch) []string {
	var names []string
	for _, f := range w.status(0).Files {
		names = append(names, f.Name)
	}
	return names
}

func TestFCSCompletenessFromTheHeader(t *testing.T) {
	dir := t.TempDir()
	for _, large := range []bool{false, true} {
		whole := fcsBytes(4000, large)
		path := filepath.Join(dir, fmt.Sprintf("f%v.fcs", large))
		for _, n := range []int{0, 30, 200, len(whole) - 1000, len(whole) - 8} {
			os.WriteFile(path, whole[:n], 0o644)
			// The data end within the file once only the CRC is missing.
			want := n >= len(whole)-8
			if got, why := fcsComplete(path, int64(n)); got != want {
				t.Fatalf("large=%v, %d of %d bytes: complete=%v (%s)", large, n, len(whole), got, why)
			}
		}
		os.WriteFile(path, whole, 0o644)
		if ok, why := fcsComplete(path, int64(len(whole))); !ok {
			t.Fatalf("whole file incomplete: %s", why)
		}
	}
	// Not FCS at all: complete, so the page reports it; preallocated zeros: still being written.
	other := filepath.Join(dir, "notes.fcs")
	os.WriteFile(other, []byte(strings.Repeat("hello world ", 10)), 0o644)
	if ok, _ := fcsComplete(other, 120); !ok {
		t.Fatal("a non-FCS file should be handed over to be reported")
	}
	os.WriteFile(other, make([]byte, 4096), 0o644)
	if ok, _ := fcsComplete(other, 4096); ok {
		t.Fatal("a file of zeros is not written yet")
	}
}

func TestWatchHandsOverOnlyCompleteNewFiles(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "before.fcs"), fcsBytes(400, false), 0o644)
	w := newFolderWatch(newLocalFiles())
	if err := w.start(dir, 20*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	defer w.stopWatching()
	if s := w.status(0); s.Existing != 1 || len(s.Files) != 0 {
		t.Fatalf("existing files are noted, not handed over: %+v", s)
	}

	// A slow writer that pauses mid-file for longer than several polls.
	whole := fcsBytes(40000, false)
	path := filepath.Join(dir, "tube 1.fcs")
	f, _ := os.Create(path)
	f.Write(whole[:len(whole)/3])
	f.Sync()
	time.Sleep(150 * time.Millisecond)
	if names := landedNames(w); len(names) != 0 {
		t.Fatalf("a file stopped mid-write was handed over: %v", names)
	}
	if s := w.status(0); len(s.Pending) != 1 || s.Pending[0] != "tube 1.fcs" {
		t.Fatalf("the half-written file should be pending: %+v", s.Pending)
	}
	f.Write(whole[len(whole)/3:])
	f.Close()
	waitUntil(t, "the finished file", 2*time.Second, func() bool { return len(landedNames(w)) == 1 })

	// Hidden and temporary names are ignored; a rename to .fcs lands.
	os.WriteFile(filepath.Join(dir, ".tube 2.fcs"), fcsBytes(400, false), 0o644)
	os.WriteFile(filepath.Join(dir, "~tube 2.fcs"), fcsBytes(400, false), 0o644)
	os.WriteFile(filepath.Join(dir, "tube 2.fcs.part"), fcsBytes(400, false), 0o644)
	time.Sleep(100 * time.Millisecond)
	if names := landedNames(w); len(names) != 1 {
		t.Fatalf("temporary files were handed over: %v", names)
	}
	os.Rename(filepath.Join(dir, "tube 2.fcs.part"), filepath.Join(dir, "tube 2.fcs"))
	// In a subfolder (exports by date) too.
	os.MkdirAll(filepath.Join(dir, "2026-10-03"), 0o755)
	os.WriteFile(filepath.Join(dir, "2026-10-03", "tube 3.fcs"), fcsBytes(400, true), 0o644)
	waitUntil(t, "the renamed and nested files", 2*time.Second, func() bool { return len(landedNames(w)) == 3 })

	s := w.status(0)
	for k, f := range s.Files {
		if f.Seq != k+1 || f.Folder != filepath.Base(dir) || !strings.HasPrefix(f.URL, "/api/local/") || f.Existing {
			t.Fatalf("landed file %d: %+v", k, f)
		}
	}
	if later := w.status(2).Files; len(later) != 1 || later[0].Seq != 3 {
		t.Fatalf("after=2 should return only the third file: %+v", later)
	}
	// Watched files are not among the files the page opens at once.
	if opened := w.files.opened(); len(opened) != 0 {
		t.Fatalf("watched files leaked into the opened list: %+v", opened)
	}
	// The files that were there before, on request.
	w.handOverExisting()
	if s := w.status(3); len(s.Files) != 1 || s.Files[0].Name != "before.fcs" || !s.Files[0].Existing || w.status(0).Existing != 0 {
		t.Fatalf("existing file not handed over: %+v", s)
	}
}

func TestWatchWaitsWhenModificationTimesAreCoarse(t *testing.T) {
	// Network shares can report a modification time that does not change while a file grows.
	dir := t.TempDir()
	w := newFolderWatch(newLocalFiles())
	if err := w.start(dir, 20*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	defer w.stopWatching()
	whole := fcsBytes(40000, false)
	path := filepath.Join(dir, "share.fcs")
	stamp := time.Date(2026, 10, 3, 9, 0, 0, 0, time.UTC)
	f, _ := os.Create(path)
	// The last part stops one byte short of the data (the 8-byte checksum after it is not required:
	// some instruments write none).
	short := len(whole) - 9
	for k := 0; k < 4; k++ {
		end := (k + 1) * len(whole) / 4
		if k == 3 {
			end = short
		}
		f.Write(whole[k*len(whole)/4 : end])
		f.Sync()
		os.Chtimes(path, stamp, stamp)
		time.Sleep(60 * time.Millisecond)
		if k < 3 && len(landedNames(w)) != 0 {
			t.Fatalf("handed over after %d of 4 parts", k+1)
		}
	}
	if len(landedNames(w)) != 0 {
		t.Fatal("handed over with its last data byte missing")
	}
	f.Write(whole[short:])
	f.Close()
	os.Chtimes(path, stamp, stamp)
	waitUntil(t, "the complete file", 2*time.Second, func() bool { return len(landedNames(w)) == 1 })
}

func TestWatchAPI(t *testing.T) {
	a, handler := testApp(t)
	defer a.watch.stopWatching()
	dir := t.TempDir()
	call := func(method, target, body, remote string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req.Host = "127.0.0.1:8770"
		req.RemoteAddr = remote
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	if rec := call(http.MethodPost, "/api/watch", `{"path": "`+dir+`"}`, "192.0.2.1:1234"); rec.Code != http.StatusForbidden {
		t.Fatalf("another computer may not start a watch: %d", rec.Code)
	}
	if rec := call(http.MethodPost, "/api/watch", `{"path": "`+filepath.Join(dir, "missing")+`"}`, "127.0.0.1:5555"); rec.Code != http.StatusBadRequest {
		t.Fatalf("a missing folder: %d", rec.Code)
	}
	rec := call(http.MethodPost, "/api/watch", `{"path": "`+dir+`", "intervalMs": 100}`, "127.0.0.1:5555")
	var status watchStatus
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &status) != nil || !status.Watching || status.Folder != dir {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
	os.WriteFile(filepath.Join(dir, "A01.fcs"), fcsBytes(400, false), 0o644)
	waitUntil(t, "A01 through the API", 3*time.Second, func() bool {
		rec := call(http.MethodGet, "/api/watch?after=0", "", "127.0.0.1:5555")
		json.Unmarshal(rec.Body.Bytes(), &status)
		return len(status.Files) == 1
	})
	// The landed file is served to the page.
	if rec := call(http.MethodGet, status.Files[0].URL, "", "127.0.0.1:5555"); rec.Code != http.StatusOK || rec.Body.Len() != len(fcsBytes(400, false)) {
		t.Fatalf("serving the landed file: %d, %d bytes", rec.Code, rec.Body.Len())
	}
	// /api/info names the watched folder but does not list its files to open.
	rec = call(http.MethodGet, "/api/info", "", "127.0.0.1:5555")
	var body info
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Watching != dir || len(body.Files) != 0 {
		t.Fatalf("info: %+v", body)
	}
	if rec := call(http.MethodDelete, "/api/watch", "", "127.0.0.1:5555"); rec.Code != http.StatusOK {
		t.Fatalf("stop: %d", rec.Code)
	}
	json.Unmarshal(call(http.MethodGet, "/api/watch", "", "127.0.0.1:5555").Body.Bytes(), &status)
	if status.Watching {
		t.Fatal("still watching after DELETE")
	}
}
