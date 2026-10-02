package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Remote control, enabled with --remote-control (and always on for "cytoweave mcp"): a program on
// this computer POSTs an action to /api/remote/action. The open CytoWeave page receives it over
// Server-Sent Events from /api/remote/events, performs it, and POSTs the outcome to
// /api/remote/result/{id}, which the server returns to the waiting caller. Adapted from
// Proteoscope's remote-control hub.
//
// Only requests from this computer that name it in their Host header are accepted, and browsers
// on other origins are refused. Opening files by path also needs the token printed at startup,
// since it makes the server read files: another user of a shared computer can reach the loopback
// port but not the owner's terminal.

const (
	maxRemoteActionBytes = 1 << 20
	maxRemoteResultBytes = 64 << 20
	remoteHeartbeat      = 15 * time.Second
	longActionTimeout    = 60 * time.Minute
	remoteTokenHeader    = "X-CytoWeave-Token"
)

type remoteHub struct {
	mu        sync.Mutex
	counter   uint64
	clients   []*remoteClient
	pending   map[string]chan remoteResult
	timeout   time.Duration
	turn      chan struct{}
	connected chan struct{}
	// open registers local files for the page to read.
	open    func(paths []string) ([]localFile, []string)
	token   string
	scripts bool
}

type remoteClient struct {
	id     uint64
	events chan remoteEvent
	done   chan struct{}
}

// An event carries an action for the page: { id, action, args }.
type remoteEvent struct {
	ID     string          `json:"id"`
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args,omitempty"`
	Files  []localFile     `json:"files,omitempty"`
}

var (
	errNoPage      = errors.New("No CytoWeave page is connected. Open CytoWeave in a browser first.")
	errPageBusy    = errors.New("The CytoWeave page is busy; try again.")
	errPageTimeout = errors.New("The CytoWeave page did not answer in time.")
	errPageGone    = errors.New("The CytoWeave page was closed or reloaded before it answered.")
)

type remoteResult struct {
	OK      bool            `json:"ok"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Actions that can run for a long time (analyses over many samples).
var longActions = map[string]bool{"open_files": true, "open_example": true, "statistics_table": true, "review_gate": true, "compare": true}

func newRemoteHub() *remoteHub {
	return &remoteHub{
		pending:   map[string]chan remoteResult{},
		timeout:   5 * time.Minute,
		turn:      make(chan struct{}, 1),
		connected: make(chan struct{}),
		token:     randomToken(),
		scripts:   true,
	}
}

func randomToken() string {
	buffer := make([]byte, 18)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

func (h *remoteHub) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/remote/events", localOnly(h.serveEvents))
	mux.HandleFunc("POST /api/remote/result/{id}", localOnly(h.serveResult))
	if h.scripts {
		mux.HandleFunc("POST /api/remote/action", localOnly(h.serveAction))
	}
}

// localOnly refuses requests from other machines and from web pages that reach the loopback
// port under another name (DNS rebinding).
func localOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			writeError(w, http.StatusForbidden, "Forbidden: remote control only accepts requests from this computer, addressed to localhost or 127.0.0.1.")
			return
		}
		next(w, r)
	}
}

func (h *remoteHub) connect() *remoteClient {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counter++
	client := &remoteClient{id: h.counter, events: make(chan remoteEvent, 16), done: make(chan struct{})}
	h.clients = append(h.clients, client)
	close(h.connected)
	h.connected = make(chan struct{})
	return client
}

func (h *remoteHub) disconnect(client *remoteClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for index, item := range h.clients {
		if item == client {
			h.clients = append(h.clients[:index], h.clients[index+1:]...)
			close(client.done)
			return
		}
	}
}

// Actions go to the most recently opened page.
func (h *remoteHub) latest() *remoteClient {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) == 0 {
		return nil
	}
	return h.clients[len(h.clients)-1]
}

func (h *remoteHub) expect() (string, chan remoteResult) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counter++
	id := strconv.FormatUint(h.counter, 10)
	result := make(chan remoteResult, 1)
	h.pending[id] = result
	return id, result
}

func (h *remoteHub) take(id string) (chan remoteResult, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	result, ok := h.pending[id]
	delete(h.pending, id)
	return result, ok
}

func (h *remoteHub) serveEvents(w http.ResponseWriter, r *http.Request) {
	stream := http.NewResponseController(w)
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-store")
	header.Set("Connection", "keep-alive")
	fmt.Fprint(w, ": connected\n\n")
	if err := stream.Flush(); err != nil {
		return
	}
	client := h.connect()
	defer h.disconnect(client)
	ticker := time.NewTicker(remoteHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event := <-client.events:
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: action\ndata: %s\n\n", data)
			if err := stream.Flush(); err != nil {
				return
			}
		case <-ticker.C:
			fmt.Fprint(w, ": ping\n\n")
			if err := stream.Flush(); err != nil {
				return
			}
		}
	}
}

// serveAction runs {"action": "...", "args": {...}} in the page. open_files needs the token.
func (h *remoteHub) serveAction(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Action string          `json:"action"`
		Args   json.RawMessage `json:"args"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRemoteActionBytes))
	if err == nil {
		err = json.Unmarshal(body, &request)
	}
	if err != nil || request.Action == "" {
		writeError(w, http.StatusBadRequest, `Send JSON such as {"action": "workspace_summary"}.`)
		return
	}
	event := remoteEvent{Action: request.Action, Args: request.Args}
	if request.Action == "open_files" {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get(remoteTokenHeader)), []byte(h.token)) != 1 {
			writeError(w, http.StatusUnauthorized, "Opening files needs the X-CytoWeave-Token header with the token CytoWeave printed when it started.")
			return
		}
		if event, err = h.openEvent(request.Args); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	h.respond(w, r, event)
}

func (h *remoteHub) openEvent(args json.RawMessage) (remoteEvent, error) {
	var params struct {
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(args, &params); err != nil || len(params.Paths) == 0 {
		return remoteEvent{}, errors.New(`open_files needs {"paths": ["/path/to/file.fcs", "/path/to/folder"]}`)
	}
	if h.open == nil {
		return remoteEvent{}, errors.New("Opening files by path is not available.")
	}
	files, problems := h.open(params.Paths)
	if len(files) == 0 {
		message := "No FCS files or workspaces were found."
		if len(problems) > 0 {
			message = problems[0]
		}
		return remoteEvent{}, errors.New(message)
	}
	return remoteEvent{Action: "open_files", Args: args, Files: files}, nil
}

func (h *remoteHub) respond(w http.ResponseWriter, r *http.Request, event remoteEvent) {
	outcome, err := h.dispatch(r.Context(), event)
	switch {
	case err == nil:
		writeJSON(w, outcome)
	case errors.Is(err, errPageTimeout):
		writeError(w, http.StatusGatewayTimeout, err.Error())
	case errors.Is(err, errNoPage), errors.Is(err, errPageBusy), errors.Is(err, errPageGone):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

// dispatch sends an event to the most recently opened page and waits for its result, one at a
// time; a request waiting its turn can still be cancelled.
func (h *remoteHub) dispatch(ctx context.Context, event remoteEvent) (remoteResult, error) {
	select {
	case h.turn <- struct{}{}:
	case <-ctx.Done():
		return remoteResult{}, ctx.Err()
	}
	defer func() { <-h.turn }()
	client := h.latest()
	if client == nil {
		return remoteResult{}, errNoPage
	}
	id, result := h.expect()
	event.ID = id
	select {
	case client.events <- event:
	default:
		h.take(id)
		return remoteResult{}, errPageBusy
	}
	limit := h.timeout
	if longActions[event.Action] && limit < longActionTimeout {
		limit = longActionTimeout
	}
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case outcome := <-result:
		return outcome, nil
	case <-client.done:
		h.take(id)
		return remoteResult{}, errPageGone
	case <-timer.C:
		h.take(id)
		return remoteResult{}, errPageTimeout
	case <-ctx.Done():
		h.take(id)
		return remoteResult{}, ctx.Err()
	}
}

// waitForPage waits until a page is connected, for example one the browser is still opening.
func (h *remoteHub) waitForPage(ctx context.Context, limit time.Duration) bool {
	timer := time.NewTimer(limit)
	defer timer.Stop()
	for {
		h.mu.Lock()
		connected, ready := h.connected, len(h.clients) > 0
		h.mu.Unlock()
		if ready {
			return true
		}
		select {
		case <-connected:
		case <-timer.C:
			return false
		case <-ctx.Done():
			return false
		}
	}
}

func (h *remoteHub) serveResult(w http.ResponseWriter, r *http.Request) {
	result, ok := h.take(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "No action is waiting for that result.")
		return
	}
	var outcome remoteResult
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRemoteResultBytes))
	if err == nil {
		err = json.Unmarshal(body, &outcome)
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		message := "The result could not be read."
		if errors.As(err, &tooLarge) {
			message = "The result is too large."
		}
		outcome = remoteResult{OK: false, Message: message}
	}
	result <- outcome
	w.WriteHeader(http.StatusNoContent)
}
