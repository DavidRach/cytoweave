package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyArguments(t *testing.T) {
	dir := t.TempDir()
	certificate := filepath.Join(dir, "analysis.certificate.acs")
	os.WriteFile(certificate, []byte("PK"), 0o644)
	report := filepath.Join(dir, "report.json")
	var stderr bytes.Buffer
	if _, err := parseVerifyArgs([]string{}, &stderr); err == nil || !strings.Contains(err.Error(), "one certificate") {
		t.Errorf("no certificate: %v", err)
	}
	if _, err := parseVerifyArgs([]string{filepath.Join(dir, "missing.acs")}, &stderr); err == nil {
		t.Error("a missing certificate accepted")
	}
	workspace := filepath.Join(dir, "a.cwz")
	os.WriteFile(workspace, []byte("{}"), 0o644)
	if _, err := parseVerifyArgs([]string{workspace}, &stderr); err == nil || !strings.Contains(err.Error(), "not a certificate") {
		t.Errorf("a workspace taken for a certificate: %v", err)
	}
	if _, err := parseVerifyArgs([]string{"--data", filepath.Join(dir, "nowhere"), certificate}, &stderr); err == nil {
		t.Error("a missing data folder accepted")
	}
	// Flags may follow the certificate, and --data may be repeated.
	opts, err := parseVerifyArgs([]string{certificate, "--data", dir, "--data", certificate, "--report", report}, &stderr)
	if err != nil {
		t.Fatal(err)
	}
	if opts.certificate != certificate || len(opts.data) != 2 || opts.report != report {
		t.Errorf("parsed %+v", opts)
	}
	os.WriteFile(report, []byte("{}"), 0o644)
	if _, err := parseVerifyArgs([]string{"--report", report, certificate}, &stderr); err == nil || !strings.Contains(err.Error(), "--overwrite") {
		t.Errorf("an existing report replaced: %v", err)
	}
	if _, err := parseVerifyArgs([]string{"--report", report, "--overwrite", certificate}, &stderr); err != nil {
		t.Errorf("--overwrite: %v", err)
	}
}

func TestVerifyEventRegistersTheCertificateAndItsData(t *testing.T) {
	dir := t.TempDir()
	certificate := filepath.Join(dir, "analysis.certificate.acs")
	os.WriteFile(certificate, []byte("PK"), 0o644)
	data := filepath.Join(dir, "data")
	os.Mkdir(data, 0o755)
	os.WriteFile(filepath.Join(data, "A.fcs"), []byte("FCS3.1"), 0o644)
	os.WriteFile(filepath.Join(data, "notes.csv"), []byte("x"), 0o644)
	local := newLocalFiles()
	hub := &remoteHub{open: local.register}
	encode := func(v any) json.RawMessage {
		b, _ := json.Marshal(v)
		return b
	}
	event, err := hub.verifyEvent(encode(map[string]any{"path": certificate, "data": data}))
	if err != nil {
		t.Fatal(err)
	}
	if event.Action != "verify_certificate" || len(event.Files) != 2 || event.Files[0].Kind != "archive" || event.Files[1].Name != "A.fcs" {
		t.Errorf("files %+v", event.Files)
	}
	if _, err := hub.verifyEvent(encode(map[string]any{"path": filepath.Join(data, "A.fcs")})); err == nil || !strings.Contains(err.Error(), "not a certificate") {
		t.Errorf("an FCS file taken for a certificate: %v", err)
	}
	if _, err := hub.verifyEvent(encode(map[string]any{"path": certificate, "data": []string{filepath.Join(data, "notes.csv")}})); err == nil {
		t.Error("data without FCS files accepted")
	}
	if _, err := hub.verifyEvent(encode(map[string]any{})); err == nil {
		t.Error("no path accepted")
	}
}
