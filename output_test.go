package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A page that answers export actions by uploading a file, as remote.js does.
func uploadingPage(t *testing.T, hub *remoteHub, mux http.Handler, body string) func() {
	return fakePage(t, hub, func(event remoteEvent) remoteResult {
		if event.Output == "" {
			return remoteResult{OK: false, Message: "no output slot"}
		}
		req := httptest.NewRequest(http.MethodPost, "/"+event.Output, strings.NewReader(body))
		req.Host = "127.0.0.1:8770"
		req.RemoteAddr = "127.0.0.1:50000"
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			return remoteResult{OK: false, Message: rec.Body.String()}
		}
		return remoteResult{OK: true, Message: "Wrote " + rec.Body.String()}
	})
}

func TestExportsWriteWhereAskedAndNeverReplaceUnlessTold(t *testing.T) {
	hub := newRemoteHub()
	mux := http.NewServeMux()
	hub.register(mux)
	stop := uploadingPage(t, hub, mux, "<svg/>")
	defer stop()
	server := &mcpServer{hub: hub, pageWait: time.Second}
	dir := t.TempDir()
	target := filepath.Join(dir, "figure.svg")
	call := func(id int, args map[string]any) map[string]any {
		encoded, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{"name": "export_figure", "arguments": args}})
		return runLines(t, server, string(encoded))[0]["result"].(map[string]any)
	}
	text := func(result map[string]any) string {
		return result["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	if r := call(1, map[string]any{"path": target}); r["isError"] == true {
		t.Fatalf("export failed: %s", text(r))
	}
	if got, _ := os.ReadFile(target); string(got) != "<svg/>" {
		t.Fatalf("file holds %q", got)
	}
	// Refused before the page is asked: an existing file, a relative path, a missing folder.
	for _, args := range []map[string]any{
		{"path": target},
		{"path": "figure.svg"},
		{"path": filepath.Join(dir, "missing", "figure.svg")},
		{"path": dir},
	} {
		if r := call(2, args); r["isError"] != true {
			t.Fatalf("%v should be refused: %s", args, text(r))
		}
	}
	if r := call(3, map[string]any{"path": target, "overwrite": true}); r["isError"] == true {
		t.Fatalf("overwrite refused: %s", text(r))
	}
	// No temporary file is left behind.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("folder holds %d entries", len(entries))
	}
}

func TestAnUploadSlotTakesOneUploadAndScriptsNeedTheToken(t *testing.T) {
	hub := newRemoteHub()
	mux := http.NewServeMux()
	hub.register(mux)
	dir := t.TempDir()
	args, _ := json.Marshal(map[string]any{"path": filepath.Join(dir, "table.csv")})
	output, release, err := hub.prepareOutput(args)
	if err != nil {
		t.Fatal(err)
	}
	post := func(path, body string, headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Host = "127.0.0.1:8770"
		req.RemoteAddr = "127.0.0.1:50000"
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	if rec := post("/"+output, "a,b\n", nil); rec.Code != http.StatusOK {
		t.Fatalf("first upload: %d %s", rec.Code, rec.Body)
	}
	if rec := post("/"+output, "again", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("second upload should be refused, got %d", rec.Code)
	}
	release()
	if rec := post("/api/remote/output/unknown", "x", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown slot: %d", rec.Code)
	}
	action := `{"action":"export_table","args":{"path":"` + filepath.ToSlash(filepath.Join(dir, "other.csv")) + `"}}`
	if rec := post("/api/remote/action", action, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("an export without the token should be refused, got %d", rec.Code)
	}
}
