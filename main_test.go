package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func testApp(t *testing.T, files ...string) (*app, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	a, err := newApp(config{dataDir: dir, files: files})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := a.handler()
	if err != nil {
		t.Fatal(err)
	}
	return a, protect(handler, "127.0.0.1", 8770)
}

func request(t *testing.T, handler http.Handler, method, target string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	req.Host = "127.0.0.1:8770"
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestServesTheAppWithSecurityHeaders(t *testing.T) {
	_, handler := testApp(t)
	rec := request(t, handler, http.MethodGet, "/", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "CytoWeave") {
		t.Fatal("index.html not served")
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") {
		t.Fatalf("missing CSP: %q", csp)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff")
	}
	js := request(t, handler, http.MethodGet, "/app.js", nil, nil)
	if !strings.HasPrefix(js.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("app.js content type %q", js.Header().Get("Content-Type"))
	}
	lib := request(t, handler, http.MethodGet, "/lib/fcs.js", nil, nil)
	if lib.Code != http.StatusOK {
		t.Fatalf("lib/fcs.js status %d", lib.Code)
	}
}

func TestInfoDescribesTheDesktopProgram(t *testing.T) {
	_, handler := testApp(t)
	rec := request(t, handler, http.MethodGet, "/api/info", nil, nil)
	var body info
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Name != "CytoWeave" || body.Version != version || !body.Library || body.Session == "" {
		t.Fatalf("unexpected info %+v", body)
	}
}

func TestRejectsForeignHostsAndCrossOriginAPI(t *testing.T) {
	_, handler := testApp(t)
	req := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	req.Host = "evil.example:8770"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("DNS-rebinding host allowed: %d", rec.Code)
	}
	cross := request(t, handler, http.MethodPut, "/api/library/workspaces/abc", strings.NewReader("{}"), map[string]string{"Origin": "https://evil.example"})
	if cross.Code != http.StatusForbidden {
		t.Fatalf("cross-origin write allowed: %d", cross.Code)
	}
	site := request(t, handler, http.MethodGet, "/api/info", nil, map[string]string{"Sec-Fetch-Site": "cross-site"})
	if site.Code != http.StatusForbidden {
		t.Fatalf("cross-site fetch allowed: %d", site.Code)
	}
	same := request(t, handler, http.MethodGet, "/api/info", nil, map[string]string{"Origin": "http://127.0.0.1:8770", "Sec-Fetch-Site": "same-origin"})
	if same.Code != http.StatusOK {
		t.Fatalf("same-origin request refused: %d", same.Code)
	}
}

func TestWorkspaceLibraryRoundTrip(t *testing.T) {
	_, handler := testApp(t)
	doc := `{"format":"cytoweave-workspace","version":1,"name":"Plate 1","modified":"2026-10-01T12:00:00Z","samples":[{},{}]}`
	put := request(t, handler, http.MethodPut, "/api/library/workspaces/w1", strings.NewReader(doc), nil)
	if put.Code != http.StatusOK {
		t.Fatalf("put %d %s", put.Code, put.Body)
	}
	list := request(t, handler, http.MethodGet, "/api/library/workspaces", nil, nil)
	var listed struct {
		Workspaces []workspaceSummary `json:"workspaces"`
	}
	json.NewDecoder(list.Body).Decode(&listed)
	if len(listed.Workspaces) != 1 || listed.Workspaces[0].Name != "Plate 1" || listed.Workspaces[0].Samples != 2 {
		t.Fatalf("unexpected list %+v", listed)
	}
	get := request(t, handler, http.MethodGet, "/api/library/workspaces/w1", nil, nil)
	if get.Body.String() != doc {
		t.Fatalf("round trip changed the document: %s", get.Body)
	}
	if bad := request(t, handler, http.MethodPut, "/api/library/workspaces/w2", strings.NewReader("{not json"), nil); bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid JSON accepted: %d", bad.Code)
	}
	if traversal := request(t, handler, http.MethodGet, "/api/library/workspaces/..%2Fsecret", nil, nil); traversal.Code == http.StatusOK {
		t.Fatal("path traversal allowed")
	}
	del := request(t, handler, http.MethodDelete, "/api/library/workspaces/w1", nil, nil)
	if del.Code != http.StatusOK {
		t.Fatalf("delete %d", del.Code)
	}
	if gone := request(t, handler, http.MethodGet, "/api/library/workspaces/w1", nil, nil); gone.Code != http.StatusNotFound {
		t.Fatalf("deleted workspace still served: %d", gone.Code)
	}
}

func TestFilesAreStoredUnderTheirHash(t *testing.T) {
	a, handler := testApp(t)
	content := []byte("FCS3.1    pretend event data")
	sum := sha256.Sum256(content)
	sha := hex.EncodeToString(sum[:])
	wrong := strings.Repeat("0", 64)
	if rec := request(t, handler, http.MethodPut, "/api/library/files/"+wrong, bytes.NewReader(content), nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatched hash accepted: %d", rec.Code)
	}
	if rec := request(t, handler, http.MethodPut, "/api/library/files/"+sha, bytes.NewReader(content), nil); rec.Code != http.StatusOK {
		t.Fatalf("put %d %s", rec.Code, rec.Body)
	}
	has := request(t, handler, http.MethodGet, "/api/library/has/"+sha, nil, nil)
	if !strings.Contains(has.Body.String(), `"exists":true`) {
		t.Fatalf("has: %s", has.Body)
	}
	missing := request(t, handler, http.MethodGet, "/api/library/has/"+wrong, nil, nil)
	if !strings.Contains(missing.Body.String(), `"exists":false`) {
		t.Fatalf("has missing: %s", missing.Body)
	}
	get := request(t, handler, http.MethodGet, "/api/library/files/"+sha, nil, nil)
	if !bytes.Equal(get.Body.Bytes(), content) {
		t.Fatal("stored file differs")
	}
	if _, err := os.Stat(filepath.Join(a.store.dir, "files", sha[:2], sha+".fcs")); err != nil {
		t.Fatalf("file not at its content address: %v", err)
	}
}

func TestLocalFilesFromFoldersAreServed(t *testing.T) {
	dir := t.TempDir()
	plate := filepath.Join(dir, "plate1")
	os.MkdirAll(filepath.Join(plate, ".hidden"), 0o755)
	for _, name := range []string{"A10.fcs", "A2.fcs", "A1.fcs", "notes.txt", ".hidden/x.fcs"} {
		os.WriteFile(filepath.Join(plate, name), []byte("data "+name), 0o644)
	}
	_, handler := testApp(t, plate)
	rec := request(t, handler, http.MethodGet, "/api/info", nil, nil)
	var body info
	json.NewDecoder(rec.Body).Decode(&body)
	var names []string
	for _, f := range body.Files {
		names = append(names, f.Name)
		if f.Folder != "plate1" || f.Kind != "fcs" {
			t.Fatalf("unexpected file %+v", f)
		}
	}
	if strings.Join(names, ",") != "A1.fcs,A2.fcs,A10.fcs" {
		t.Fatalf("files not in natural order or hidden files included: %v", names)
	}
	served := request(t, handler, http.MethodGet, body.Files[2].URL, nil, nil)
	if served.Body.String() != "data A10.fcs" {
		t.Fatalf("served %q", served.Body.String())
	}
	if rec := request(t, handler, http.MethodGet, "/api/local/99", nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown local file: %d", rec.Code)
	}
}

func TestOpenRequiresThisComputer(t *testing.T) {
	_, handler := testApp(t)
	req := httptest.NewRequest(http.MethodPost, "/api/open", strings.NewReader(`{"paths":["/tmp"]}`))
	req.Host = "127.0.0.1:8770"
	req.RemoteAddr = "10.0.0.5:5555"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("remote peer allowed to open files: %d", rec.Code)
	}
}

func TestNaturalOrder(t *testing.T) {
	names := []string{"Well 10", "well 2", "Well 1", "Plate B3", "Plate A11", "Plate A3"}
	sort.Slice(names, func(i, j int) bool { return naturalLess(names[i], names[j]) })
	want := "Plate A3,Plate A11,Plate B3,Well 1,well 2,Well 10"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestParseConfig(t *testing.T) {
	cfg, err := parseConfig([]string{"plate/", "--port", "9000", "--window", "none", "a.fcs"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.port != 9000 || cfg.window != "none" || len(cfg.files) != 2 || cfg.dataDir == "" {
		t.Fatalf("unexpected config %+v", cfg)
	}
	if _, err := parseConfig([]string{"--window", "fullscreen"}); err == nil {
		t.Fatal("invalid --window accepted")
	}
	noOpen, _ := parseConfig([]string{"--no-open"})
	if noOpen.window != "none" {
		t.Fatal("--no-open should mean --window none")
	}
}

func TestFileKinds(t *testing.T) {
	cases := map[string]string{"a.FCS": "fcs", "b.lmd": "fcs", "w.cwz": "workspace", "x.wsp": "flowjo", "g.xml": "gatingml", "t.csv": "table", "p.acs": "archive", "r.txt": ""}
	for name, want := range cases {
		if got := fileKind(name); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
}
