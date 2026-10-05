package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

// How scripts find a running CytoWeave. With --remote-control, CytoWeave writes remote.json to its
// data folder: its URL and the token that opening and writing files need, readable by this user
// only (as Jupyter's runtime files are), and removes it when it stops. The R and Python clients
// (clients/) read it when no URL or token is given. GET /api/remote/tools describes every action
// (the agent tools' names, descriptions and argument schemas), for the clients' help.

const connectionFileName = "remote.json"

type connectionInfo struct {
	URL     string `json:"url"`
	Token   string `json:"token"`
	Version string `json:"version"`
	PID     int    `json:"pid"`
}

// writeConnectionFile writes dir/remote.json through a temporary file renamed into place, so a
// reader never sees half a file. Returns its path.
func writeConnectionFile(dir, url, token string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(connectionInfo{URL: url, Token: token, Version: version, PID: os.Getpid()}, "", "  ")
	if err != nil {
		return "", err
	}
	temp, err := os.CreateTemp(dir, ".remote-*.json")
	if err != nil {
		return "", err
	}
	name := temp.Name()
	if err = temp.Chmod(0o600); err == nil {
		_, err = temp.Write(append(data, '\n'))
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	path := filepath.Join(dir, connectionFileName)
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		os.Remove(name)
		return "", err
	}
	return path, nil
}

// removeConnectionFile removes the file if it still describes this CytoWeave (another one started
// later with the same data folder replaces it, and keeps it).
func removeConnectionFile(path, token string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var info connectionInfo
	if json.Unmarshal(data, &info) == nil && info.Token == token {
		os.Remove(path)
	}
}

func (h *remoteHub) serveTools(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"version": version, "tools": mcpTools})
}

// connectionNotice is the banner line that names the file.
func connectionNotice(path string) string {
	return fmt.Sprintf("Scripts and the R and Python clients connect through %s", path)
}
