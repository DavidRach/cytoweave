package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// fakePage answers every action the hub sends, like the browser page would.
func fakePage(t *testing.T, hub *remoteHub, answer func(remoteEvent) remoteResult) func() {
	t.Helper()
	client := hub.connect()
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case event := <-client.events:
				result, ok := hub.take(event.ID)
				if ok {
					result <- answer(event)
				}
			}
		}
	}()
	return func() {
		close(stop)
		hub.disconnect(client)
	}
}

func runLines(t *testing.T, server *mcpServer, lines ...string) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	server.out = &out
	if err := server.serveStream(context.Background(), strings.NewReader(strings.Join(lines, "\n")+"\n")); err != nil {
		t.Fatal(err)
	}
	var replies []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var reply map[string]any
		if err := json.Unmarshal([]byte(line), &reply); err != nil {
			t.Fatalf("bad reply %q: %v", line, err)
		}
		replies = append(replies, reply)
	}
	return replies
}

func TestMCPInitializeAndListTools(t *testing.T) {
	server := &mcpServer{hub: newRemoteHub(), pageWait: 50 * time.Millisecond}
	replies := runLines(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"nope"}`,
		`not json`,
	)
	if len(replies) != 4 {
		t.Fatalf("got %d replies: %v", len(replies), replies)
	}
	init := replies[0]["result"].(map[string]any)
	if init["protocolVersion"] != "2025-06-18" || init["serverInfo"].(map[string]any)["name"] != "cytoweave" {
		t.Fatalf("initialize: %v", init)
	}
	tools := replies[1]["result"].(map[string]any)["tools"].([]any)
	names := map[string]bool{}
	for _, tool := range tools {
		names[tool.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"workspace_summary", "create_gate", "render_plot", "compare", "methods"} {
		if !names[want] {
			t.Errorf("tool %s missing", want)
		}
	}
	if replies[2]["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatalf("unknown method: %v", replies[2])
	}
	if replies[3]["error"].(map[string]any)["code"].(float64) != -32700 {
		t.Fatalf("parse error: %v", replies[3])
	}
}

func TestMCPToolCallsReachThePage(t *testing.T) {
	hub := newRemoteHub()
	var seen remoteEvent
	stop := fakePage(t, hub, func(event remoteEvent) remoteResult {
		seen = event
		if event.Action == "render_plot" {
			return remoteResult{OK: true, Message: "plot", Data: json.RawMessage(`{"image":"data:image/png;base64,iVBORw0KGgo=","width":10,"height":10}`)}
		}
		return remoteResult{OK: true, Message: "3 samples", Data: json.RawMessage(`{"samples":[{"name":"A"}]}`)}
	})
	defer stop()
	server := &mcpServer{hub: hub, pageWait: time.Second}
	replies := runLines(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workspace_summary","arguments":{}}}`,
	)
	result := replies[0]["result"].(map[string]any)
	if seen.Action != "workspace_summary" {
		t.Fatalf("page saw %+v", seen)
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "3 samples") || !strings.Contains(text, `"name":"A"`) {
		t.Fatalf("text %q", text)
	}
	if result["structuredContent"].(map[string]any)["message"] != "3 samples" {
		t.Fatalf("structured %v", result["structuredContent"])
	}
	image := runLines(t, server, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"render_plot","arguments":{"x":"CD3"}}}`)
	content := image[0]["result"].(map[string]any)["content"].([]any)
	if content[0].(map[string]any)["type"] != "image" || content[0].(map[string]any)["mimeType"] != "image/png" {
		t.Fatalf("image result %v", content)
	}
	var args map[string]any
	json.Unmarshal(seen.Args, &args)
	if args["x"] != "CD3" {
		t.Fatalf("arguments not passed: %s", seen.Args)
	}
}

func TestMCPRequiredArgumentsAndMissingPage(t *testing.T) {
	server := &mcpServer{hub: newRemoteHub(), pageWait: 20 * time.Millisecond}
	replies := runLines(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_gate","arguments":{"type":"rectangle"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workspace_summary","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"unknown_tool"}}`,
	)
	byID := map[float64]map[string]any{}
	for _, reply := range replies {
		byID[reply["id"].(float64)] = reply
	}
	first := byID[1]["result"].(map[string]any)
	if first["isError"] != true || !strings.Contains(first["content"].([]any)[0].(map[string]any)["text"].(string), "x is required") {
		t.Fatalf("missing argument: %v", first)
	}
	second := byID[2]["result"].(map[string]any)
	if second["isError"] != true || !strings.Contains(second["content"].([]any)[0].(map[string]any)["text"].(string), "No CytoWeave page") {
		t.Fatalf("no page: %v", second)
	}
	if byID[3]["error"] == nil {
		t.Fatalf("unknown tool: %v", byID[3])
	}
}

func TestPageErrorsBecomeToolErrors(t *testing.T) {
	hub := newRemoteHub()
	stop := fakePage(t, hub, func(remoteEvent) remoteResult {
		return remoteResult{OK: false, Message: `No population "CD99".`}
	})
	defer stop()
	server := &mcpServer{hub: hub, pageWait: time.Second}
	replies := runLines(t, server, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"review_gate","arguments":{"population":"CD99"}}}`)
	result := replies[0]["result"].(map[string]any)
	if result["isError"] != true || !strings.Contains(result["content"].([]any)[0].(map[string]any)["text"].(string), "CD99") {
		t.Fatalf("%v", result)
	}
}
