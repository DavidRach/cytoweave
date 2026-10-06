package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTemplateFile(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "panel.cwt")
	body := `{"format": "cytoweave-template", "name": "Panel", "gates": [], "channels": {}, "tables": [{"name": "CD4 T cells: % of parent"}, {"name": "CD4 T cells: % of parent"}], "figures": [{"name": "Strategy"}]}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func actions(steps []runStep) []string {
	var out []string
	for _, s := range steps {
		out = append(out, s.Action)
	}
	return out
}

func TestRunDefaultSteps(t *testing.T) {
	dir := t.TempDir()
	template := writeTemplateFile(t, dir)
	fcs := filepath.Join(dir, "fcs")
	os.Mkdir(fcs, 0o755)
	var stderr bytes.Buffer
	opts, err := parseRunArgs([]string{"--template", template, fcs, "--output", filepath.Join(dir, "out"), "--qc", "--flowjo", "--report", "pptx", "--report-by", "subject", "--overwrite"}, &stderr)
	if err != nil {
		t.Fatal(err)
	}
	steps, templatePath, err := planRun(opts)
	if err != nil {
		t.Fatal(err)
	}
	if templatePath != template {
		t.Errorf("template %q", templatePath)
	}
	want := "open_files run_qc apply_template accept_proposals export_table export_table export_table export_report export_flowjo export_workspace methods statistics_table"
	if got := strings.Join(actions(steps), " "); got != want {
		t.Fatalf("steps\n%s\nwant\n%s", got, want)
	}
	if !steps[0].Required || !steps[2].Required || steps[4].Required {
		t.Error("opening and applying must be required, exports not")
	}
	if text, _ := steps[2].Args["templateJSON"].(string); !strings.Contains(text, "cytoweave-template") {
		t.Error("the template's contents are not passed")
	}
	out := filepath.Join(dir, "out")
	paths := []string{}
	for _, s := range steps[4:] {
		if p, ok := s.Args["path"].(string); ok {
			paths = append(paths, strings.TrimPrefix(p, out+string(filepath.Separator)))
			if s.Args["overwrite"] != true {
				t.Errorf("%s: overwrite not passed", s.Action)
			}
		}
	}
	if got := strings.Join(paths, " "); got != "tables.xlsx CD4_T_cells_of_parent.csv CD4_T_cells_of_parent_2.csv report.pptx workspace.wsp workspace.cwz methods.txt" {
		t.Errorf("paths: %s", got)
	}
	if steps[7].Args["by"] != "subject" {
		t.Errorf("report by %v", steps[7].Args["by"])
	}
}

func TestRunNeedsAnOutputAndATemplate(t *testing.T) {
	dir := t.TempDir()
	var stderr bytes.Buffer
	if _, err := parseRunArgs([]string{dir}, &stderr); err == nil || !strings.Contains(err.Error(), "--output") {
		t.Errorf("no --output: %v", err)
	}
	if _, err := parseRunArgs([]string{"--output", dir, "--report", "docx", dir}, &stderr); err == nil {
		t.Error("--report docx accepted")
	}
	if _, err := parseRunArgs([]string{"--output", dir, filepath.Join(dir, "missing")}, &stderr); err == nil {
		t.Error("a missing input accepted")
	}
	opts, _ := parseRunArgs([]string{"--output", dir, dir}, &stderr)
	if _, _, err := planRun(opts); err == nil || !strings.Contains(err.Error(), "--template") {
		t.Errorf("no template: %v", err)
	}
	bad := filepath.Join(dir, "bad.cwt")
	os.WriteFile(bad, []byte(`{"format": "cytoweave-workspace"}`), 0o644)
	opts.template = bad
	if _, _, err := planRun(opts); err == nil || !strings.Contains(err.Error(), "not a CytoWeave template") {
		t.Errorf("a workspace taken for a template: %v", err)
	}
}

func TestRunStepsFile(t *testing.T) {
	dir := t.TempDir()
	writeTemplateFile(t, dir)
	stepsPath := filepath.Join(dir, "steps.json")
	os.WriteFile(stepsPath, []byte(`{"steps": [
		{"action": "open_files", "args": {"paths": ["$inputs", "layout.csv"]}},
		{"action": "apply_template", "args": {"templateFile": "panel.cwt"}},
		{"action": "accept_proposals"},
		{"action": "export_table", "args": {"statistic": "count", "path": "counts.csv"}},
		{"action": "export_events", "args": {"path": "/absolute/events.fcs"}}
	]}`), 0o644)
	input := filepath.Join(dir, "a.fcs")
	os.WriteFile(input, []byte("x"), 0o644)
	var stderr bytes.Buffer
	opts, err := parseRunArgs([]string{"--steps", stepsPath, "--output", filepath.Join(dir, "out"), input}, &stderr)
	if err != nil {
		t.Fatal(err)
	}
	steps, templatePath, err := planRun(opts)
	if err != nil {
		t.Fatal(err)
	}
	paths := steps[0].Args["paths"].([]any)
	if len(paths) != 2 || paths[0] != input || paths[1] != filepath.Join(dir, "layout.csv") {
		t.Errorf("open_files paths %v", paths)
	}
	if templatePath != filepath.Join(dir, "panel.cwt") || steps[1].Args["templateJSON"] == nil || steps[1].Args["templateFile"] != nil || !steps[1].Required {
		t.Errorf("templateFile not read: %v", steps[1].Args)
	}
	if steps[3].Args["path"] != filepath.Join(dir, "out", "counts.csv") || steps[4].Args["path"] != "/absolute/events.fcs" {
		t.Errorf("output paths %v %v", steps[3].Args["path"], steps[4].Args["path"])
	}
	os.WriteFile(stepsPath, []byte(`[{"args": {}}]`), 0o644)
	if _, _, err := planRun(opts); err == nil {
		t.Error("a step without an action accepted")
	}
}

func TestFileNamesAndProgressSentences(t *testing.T) {
	used := map[string]bool{}
	if got := fileName("Frequencies", used); got != "Frequencies" {
		t.Error(got)
	}
	if got := fileName("frequencies", used); got != "frequencies_2" {
		t.Error(got)
	}
	if got := fileName("// ", used); got != "table" {
		t.Error(got)
	}
	if got := firstSentence("Wrote x (3 bytes). Then more.\nAnd a line."); got != "Wrote x (3 bytes)." {
		t.Error(got)
	}
}

// Only the run sends trusted actions: an action posted by a script is never trusted, whatever
// its body says.
func TestScriptsCannotSendTrustedActions(t *testing.T) {
	hub := newRemoteHub()
	mux := http.NewServeMux()
	hub.register(mux)
	seen := make(chan remoteEvent, 1)
	stop := fakePage(t, hub, func(event remoteEvent) remoteResult {
		seen <- event
		return remoteResult{OK: true, Message: "done"}
	})
	defer stop()
	body, _ := json.Marshal(map[string]any{"action": "accept_proposals", "trusted": true, "args": map[string]any{"trusted": true}})
	req := httptest.NewRequest(http.MethodPost, "/api/remote/action", bytes.NewReader(body))
	req.Host = "127.0.0.1:8770"
	req.RemoteAddr = "127.0.0.1:50000"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	go mux.ServeHTTP(rec, req)
	select {
	case event := <-seen:
		if event.Action != "accept_proposals" || event.Trusted {
			t.Errorf("event %+v", event)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the action did not reach the page")
	}
}
