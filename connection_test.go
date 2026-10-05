package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTheConnectionFileIsPrivateAndRemovedOnStop(t *testing.T) {
	dir := t.TempDir()
	var banner bytes.Buffer
	running, err := start(config{host: "127.0.0.1", port: 0, dataDir: dir, remote: true, window: "none"}, &banner)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, connectionFileName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("no connection file: %v\n%s", err, banner.String())
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("connection file mode %v, want 0600", info.Mode().Perm())
	}
	var c connectionInfo
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &c); err != nil || c.URL != running.url || c.Token != running.app.control.token || c.Version != version || c.PID != os.Getpid() {
		t.Fatalf("connection file %s does not describe the server at %s", data, running.url)
	}
	if !strings.Contains(banner.String(), path) {
		t.Fatalf("the banner does not name the file:\n%s", banner.String())
	}
	running.stop(time.Second)
	running.listener.Close()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the connection file is still there after stopping")
	}
}

func TestAConnectionFileOfAnotherServerIsKept(t *testing.T) {
	dir := t.TempDir()
	path, err := writeConnectionFile(dir, "http://127.0.0.1:1", "theirs")
	if err != nil {
		t.Fatal(err)
	}
	removeConnectionFile(path, "ours")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("another server's file was removed")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("the folder holds %d entries, want only remote.json", len(entries))
	}
}

func TestScriptsListTheTools(t *testing.T) {
	hub := newRemoteHub()
	mux := http.NewServeMux()
	hub.register(mux)
	req := httptest.NewRequest(http.MethodGet, "/api/remote/tools", nil)
	req.Host = "127.0.0.1:8770"
	req.RemoteAddr = "127.0.0.1:50000"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var body struct {
		Version string    `json:"version"`
		Tools   []mcpTool `json:"tools"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("tools: %d %s", rec.Code, rec.Body)
	}
	if body.Version != version || len(body.Tools) != len(mcpTools) || body.Tools[0].Name != mcpTools[0].Name {
		t.Fatalf("tools: version %s, %d tools", body.Version, len(body.Tools))
	}
	// Not for other machines.
	req = httptest.NewRequest(http.MethodGet, "/api/remote/tools", nil)
	req.Host = "example.com"
	req.RemoteAddr = "10.0.0.2:50000"
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a request from another machine got %d", rec.Code)
	}
}

var updateClients = flag.Bool("update", false, "rewrite clients/tools.json from the tool definitions")

// clients/tools.json is the tool list the R and Python clients are generated from
// (clients/generate.mjs); it must describe the tools this program has.
func TestTheClientsToolListIsCurrent(t *testing.T) {
	data, err := json.MarshalIndent(mcpTools, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	path := filepath.Join("clients", "tools.json")
	if *updateClients {
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(current, data) {
		t.Fatalf("clients/tools.json is out of date: run go test -run TestTheClientsToolListIsCurrent -update, then node clients/generate.mjs")
	}
}
