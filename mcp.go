package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"
)

// "cytoweave mcp" is a Model Context Protocol server for AI agents. It starts CytoWeave as usual,
// with remote control on, and answers the agent's JSON-RPC requests on stdin and stdout. Each tool
// is an action the open CytoWeave page performs (web/ui/remote.js); render_plot returns a PNG. The
// banner and logs go to stderr, since stdout carries the protocol. When the agent closes stdin,
// CytoWeave stops. Adapted from Proteoscope's MCP server.

var mcpProtocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const (
	mcpMaxLine      = 64 << 20
	mcpTextLimit    = 200_000
	mcpImageLimit   = 8 << 20
	mcpPageWait     = 40 * time.Second
	mcpReopenAfter  = 20 * time.Second
	mcpProgressTick = 5 * time.Second
	mcpEndGrace     = time.Second
	mcpInstructions = "CytoWeave analyzes flow, spectral and mass cytometry data (FCS files) in a window on this computer, which the user watches. Start with workspace_summary. Open data with open_files (absolute paths of FCS files, folders or workspaces) or open_example. Gates are drawn on two channels (or one) and their coordinates are data values on the channels' scales (logicle/arcsinh for fluorescence, linear for scatter); create_gate and auto_gate add populations under a parent population, list_populations shows the tree with counts and frequencies, population_statistics and statistics_table give numbers, render_plot shows a plot as an image, review_gate checks a gate across samples, adapt_gate proposes per-sample adjustments of a gate where the data have shifted, compare tests differences between groups of samples, check_robustness checks whether a comparison's conclusion survives other reasonable analysis choices, and methods writes a methods paragraph. The rest of the pipeline: annotate_samples sets metadata and roles, run_qc runs acquisition QC, unmix unmixes spectral files, explore clusters and maps cells, build_figure lays out a figure, save_template, list_templates and apply_template reuse an analysis on another experiment (channels matched by marker), suggest_cell_types names populations with Cell Ontology terms, titration analyzes an antibody titration or a detector voltage walk, watch_folder checks files as an instrument writes them, and export_flowjo, export_fcs, export_figure and export_table write files to absolute paths (never replacing a file unless overwrite is given). Your changes are proposals for the user to review: new gates, computed results (QC, unmixed channels, clusters, maps) and figures appear at once, marked as proposed, and you can use them; renaming or deleting existing gates, per-sample adjustments (adapt_gate), new compensation matrices (propose_compensation), sample annotations and a gate at the top of the tree (run_qc addGate) wait until the user accepts. The user accepts or rejects all your open changes together; proposals tells you what is still open and what was decided."
)

type mcpMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpServer struct {
	hub      *remoteHub
	url      string
	out      io.Writer
	outMu    sync.Mutex
	pageWait time.Duration
	calls    sync.WaitGroup
	openPage func()
	cancelMu sync.Mutex
	cancels  map[string]context.CancelFunc
	clientMu sync.Mutex
	client   string
}

func runMCP(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	log.SetOutput(stderr)
	cfg, err := parseConfig(args)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		return 2
	}
	if cfg.showVersion {
		fmt.Fprintf(stdout, "cytoweave %s\n", version)
		return 0
	}
	if !isLoopbackName(normalizeHost(cfg.host)) {
		fmt.Fprintln(stderr, "cytoweave mcp serves only this computer; leave out --host or use --host 127.0.0.1.")
		return 2
	}
	cfg.remote, cfg.mcp = true, true
	window := cfg.window
	cfg.window = "none"
	running, err := start(cfg, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintln(stderr, "MCP: answering on stdin and stdout; the CytoWeave window opens when a tool needs it.")
	served := make(chan error, 1)
	go func() { served <- running.serve() }()
	server := &mcpServer{hub: running.app.control, url: running.url, out: stdout, pageWait: mcpPageWait}
	if window != "none" {
		var mu sync.Mutex
		var last time.Time
		server.openPage = func() {
			mu.Lock()
			defer mu.Unlock()
			if time.Since(last) < mcpReopenAfter {
				return
			}
			last = time.Now()
			if _, err := openWindow(running.url, window, cfg.dataDir); err != nil {
				log.Printf("open window: %v", err)
			}
		}
	}
	err = server.serveStream(context.Background(), stdin)
	running.stop(2 * time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "MCP:", err)
		return 1
	}
	if err := <-served; err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// serveStream reads one JSON-RPC message per line until the input ends. Tool calls run
// concurrently; the page still performs them one at a time.
func (s *mcpServer) serveStream(ctx context.Context, in io.Reader) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	reader := bufio.NewReaderSize(in, 1<<20)
	var readErr error
	for {
		line, err := readLine(reader, mcpMaxLine)
		if errors.Is(err, errLineTooLong) {
			s.send(json.RawMessage("null"), nil, &mcpError{Code: -32700, Message: "Parse error: the message is longer than 64 MiB"})
			continue
		}
		if len(strings.TrimSpace(string(line))) > 0 {
			s.receive(ctx, line)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}
	grace := time.AfterFunc(mcpEndGrace, cancel)
	s.calls.Wait()
	grace.Stop()
	return readErr
}

var errLineTooLong = errors.New("line too long")

func readLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	tooLong := false
	for {
		chunk, err := reader.ReadSlice('\n')
		if !tooLong {
			if len(line)+len(chunk) > limit {
				tooLong, line = true, nil
			} else {
				line = append(line, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if tooLong && err == nil {
			return nil, errLineTooLong
		}
		return []byte(strings.TrimRight(string(line), "\r\n")), err
	}
}

func (s *mcpServer) receive(ctx context.Context, line []byte) {
	trimmed := strings.TrimSpace(string(line))
	if !strings.HasPrefix(trimmed, "{") {
		code, message := -32600, "Invalid Request: send one JSON-RPC object per line (batches are not supported)"
		if !json.Valid(line) {
			code, message = -32700, "Parse error"
		}
		s.send(json.RawMessage("null"), nil, &mcpError{Code: code, Message: message})
		return
	}
	var message mcpMessage
	if err := json.Unmarshal(line, &message); err != nil {
		s.send(json.RawMessage("null"), nil, &mcpError{Code: -32700, Message: "Parse error"})
		return
	}
	hasID := len(message.ID) > 0 && string(message.ID) != "null"
	if message.Method == "" {
		if hasID && (len(message.Result) > 0 || len(message.Error) > 0) {
			return
		}
		s.send(idOrNull(message.ID), nil, &mcpError{Code: -32600, Message: "Invalid Request"})
		return
	}
	if message.JSONRPC != "2.0" {
		if hasID {
			s.send(message.ID, nil, &mcpError{Code: -32600, Message: "Invalid Request: jsonrpc must be \"2.0\""})
		}
		return
	}
	if message.Method == "tools/call" && hasID {
		callCtx, cancel := context.WithCancel(ctx)
		key := string(message.ID)
		s.cancelMu.Lock()
		if s.cancels == nil {
			s.cancels = map[string]context.CancelFunc{}
		}
		s.cancels[key] = cancel
		s.cancelMu.Unlock()
		s.calls.Add(1)
		go func() {
			defer s.calls.Done()
			defer func() {
				s.cancelMu.Lock()
				delete(s.cancels, key)
				s.cancelMu.Unlock()
				cancel()
			}()
			s.handle(callCtx, message)
		}()
		return
	}
	s.handle(ctx, message)
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func (s *mcpServer) handle(ctx context.Context, request mcpMessage) {
	notification := len(request.ID) == 0 || string(request.ID) == "null"
	var result any
	var failure *mcpError
	switch request.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
			ClientInfo      struct {
				Name  string `json:"name"`
				Title string `json:"title"`
			} `json:"clientInfo"`
		}
		json.Unmarshal(request.Params, &params)
		s.clientMu.Lock()
		s.client = clientName(params.ClientInfo.Title, clientName(params.ClientInfo.Name, ""))
		s.clientMu.Unlock()
		result = map[string]any{
			"protocolVersion": negotiateVersion(params.ProtocolVersion),
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "cytoweave", "title": "CytoWeave", "version": version},
			"instructions":    mcpInstructions,
		}
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": mcpTools}
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
			Meta      struct {
				ProgressToken json.RawMessage `json:"progressToken"`
			} `json:"_meta"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			failure = &mcpError{Code: -32602, Message: "Invalid params"}
			break
		}
		tool, ok := mcpToolByName[params.Name]
		if !ok {
			failure = &mcpError{Code: -32602, Message: fmt.Sprintf("Unknown tool: %s", params.Name)}
			break
		}
		stop := s.reportProgress(params.Meta.ProgressToken)
		result = s.callTool(ctx, tool, params.Arguments)
		stop()
		if ctx.Err() != nil {
			return
		}
	case "notifications/cancelled":
		var params struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		json.Unmarshal(request.Params, &params)
		s.cancelMu.Lock()
		cancel := s.cancels[string(params.RequestID)]
		s.cancelMu.Unlock()
		if cancel != nil {
			cancel()
		}
		return
	default:
		if strings.HasPrefix(request.Method, "notifications/") {
			return
		}
		failure = &mcpError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", request.Method)}
	}
	if notification {
		return
	}
	s.send(request.ID, result, failure)
}

func (s *mcpServer) reportProgress(token json.RawMessage) func() {
	if len(token) == 0 || string(token) == "null" {
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(mcpProgressTick)
		defer ticker.Stop()
		for step := 1; ; step++ {
			select {
			case <-done:
				return
			case <-ticker.C:
				s.notify("notifications/progress", map[string]any{"progressToken": token, "progress": step, "message": "CytoWeave is working in the window"})
			}
		}
	}()
	return func() { close(done) }
}

func negotiateVersion(requested string) string {
	for _, supported := range mcpProtocolVersions {
		if requested == supported {
			return requested
		}
	}
	return mcpProtocolVersions[0]
}

func (s *mcpServer) send(id json.RawMessage, result any, failure *mcpError) {
	message := map[string]any{"jsonrpc": "2.0", "id": id}
	if failure != nil {
		message["error"] = failure
	} else {
		message["result"] = result
	}
	s.write(message, id)
}

func (s *mcpServer) notify(method string, params any) {
	s.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params}, nil)
}

func (s *mcpServer) write(message map[string]any, id json.RawMessage) {
	data, err := json.Marshal(message)
	if err != nil {
		data, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": idOrNull(id), "error": mcpError{Code: -32603, Message: err.Error()}})
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	s.out.Write(append(data, '\n'))
}

// callTool checks the arguments, waits for a page, sends it the action and shapes the reply.
func (s *mcpServer) callTool(ctx context.Context, tool mcpTool, raw json.RawMessage) map[string]any {
	var args map[string]any
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &args); err != nil {
			return toolError("The arguments are not a JSON object.")
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	for _, name := range tool.required() {
		if value, ok := args[name]; !ok || value == nil || value == "" {
			return toolError(fmt.Sprintf("%s is required.", name))
		}
	}
	if s.hub.latest() == nil && s.openPage != nil {
		s.openPage()
	}
	if !s.hub.waitForPage(ctx, s.pageWait) {
		return toolError(fmt.Sprintf("No CytoWeave page is connected. Open %s in a browser, then try again.", s.url))
	}
	encoded, _ := json.Marshal(args)
	s.clientMu.Lock()
	client := clientName(s.client, "an AI agent")
	s.clientMu.Unlock()
	event := remoteEvent{Action: tool.Name, Args: encoded, Client: client}
	if outputActions[tool.Name] {
		output, release, err := s.hub.prepareOutput(encoded)
		if err != nil {
			return toolError(err.Error())
		}
		defer release()
		event.Output = output
	}
	if tool.Name == "open_files" {
		var err error
		if event, err = s.hub.openEvent(encoded); err != nil {
			return toolError(err.Error())
		}
		event.Client = client
	}
	outcome, err := s.hub.dispatch(ctx, event)
	if err != nil {
		return toolError(err.Error())
	}
	if tool.image {
		return imageResult(outcome)
	}
	return commandResult(outcome)
}

func toolError(message string) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": message}}, "isError": true}
}

func commandResult(outcome remoteResult) map[string]any {
	if !outcome.OK {
		return toolError(outcome.Message)
	}
	text := outcome.Message
	structured := map[string]any{"message": outcome.Message}
	var images []mcpImage
	if len(outcome.Data) > 0 && string(outcome.Data) != "null" {
		var data any
		if err := json.Unmarshal(outcome.Data, &data); err == nil {
			var dropped int
			data, images, dropped = extractImages(data)
			structured["data"] = data
			serialized := string(outcome.Data)
			if len(images) > 0 || dropped > 0 {
				encoded, _ := json.Marshal(data)
				serialized = string(encoded)
			}
			if len(serialized) > mcpTextLimit {
				serialized = strings.ToValidUTF8(serialized[:mcpTextLimit], "") + " … (truncated; the structured content has everything)"
			}
			if text != "" {
				text += "\n\n"
			}
			text += serialized
			if dropped > 0 {
				text += fmt.Sprintf("\n\n%d more images left out (null above): the images of one result are limited to %d MB.", dropped, mcpImageLimit>>20)
			}
		}
	}
	if text == "" {
		text = "Done."
	}
	content := []any{map[string]any{"type": "text", "text": text}}
	for index, image := range images {
		content = append(content,
			map[string]any{"type": "text", "text": fmt.Sprintf("Image %d: %s", index+1, image.caption)},
			map[string]any{"type": "image", "data": image.data, "mimeType": image.mimeType})
	}
	return map[string]any{"content": content, "structuredContent": structured}
}

type mcpImage struct {
	data, mimeType, caption string
}

var dataURLImage = regexp.MustCompile(`^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$`)

// extractImages replaces image data URLs in a result's data with their 1-based number among the
// images returned (up to mcpImageLimit bytes in all), captioned from the fields next to them.
func extractImages(data any) (any, []mcpImage, int) {
	var images []mcpImage
	dropped, total := 0, 0
	var walk func(value any, siblings map[string]any) any
	walk = func(value any, siblings map[string]any) any {
		switch typed := value.(type) {
		case map[string]any:
			for key, item := range typed {
				typed[key] = walk(item, typed)
			}
			return typed
		case []any:
			for index, item := range typed {
				typed[index] = walk(item, nil)
			}
			return typed
		case string:
			match := dataURLImage.FindStringSubmatch(typed)
			if match == nil {
				return typed
			}
			if total+len(match[2]) > mcpImageLimit {
				dropped++
				return nil
			}
			total += len(match[2])
			images = append(images, mcpImage{data: match[2], mimeType: match[1], caption: imageCaption(siblings)})
			return len(images)
		}
		return value
	}
	data = walk(data, nil)
	return data, images, dropped
}

func imageCaption(fields map[string]any) string {
	var parts []string
	for _, key := range []string{"sample", "population", "title"} {
		if text, ok := fields[key].(string); ok && text != "" {
			parts = append(parts, text)
		}
	}
	if len(parts) == 0 {
		return "image"
	}
	return strings.Join(parts, ", ")
}

func imageResult(outcome remoteResult) map[string]any {
	if !outcome.OK {
		return toolError(outcome.Message)
	}
	var data struct {
		Image  string `json:"image"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	json.Unmarshal(outcome.Data, &data)
	encoded, found := strings.CutPrefix(data.Image, "data:image/png;base64,")
	if !found || encoded == "" {
		return toolError("The page did not return an image.")
	}
	if len(encoded) > mcpImageLimit {
		return toolError(fmt.Sprintf("The %d × %d image is %.1f MB, more than agents accept; render it smaller.", data.Width, data.Height, float64(len(encoded))*3/4/(1<<20)))
	}
	return map[string]any{"content": []any{
		map[string]any{"type": "image", "data": encoded, "mimeType": "image/png"},
		map[string]any{"type": "text", "text": outcome.Message},
	}}
}

/* ---------- Tools ---------- */

type mcpTool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
	image       bool
}

func (t mcpTool) required() []string {
	list, _ := t.InputSchema["required"].([]string)
	return list
}

func schema(properties map[string]any, required ...string) map[string]any {
	result := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

func str(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func num(description string) map[string]any {
	return map[string]any{"type": "number", "description": description}
}

func strList(description string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": description}
}

var readOnly = map[string]any{"readOnlyHint": true, "openWorldHint": false}
var edits = map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}

// Writes a file outside the workspace (never replacing one unless overwrite is given).
var writesFile = map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}

const sampleHelp = "Sample name or id (default: the sample shown in the window)"
const populationHelp = "Population name, path (\"Lymphocytes/Single cells/CD3+\") or id; \"All events\" or omitted for all events"

var mcpTools = []mcpTool{
	{Name: "workspace_summary", Title: "Describe the workspace", Annotations: readOnly,
		Description: "The open workspace: its samples (name, events, role, metadata, channels with markers), groups, the gating tree with counts for the current sample, compensation matrices, derived results, and what the window shows. Start here.",
		InputSchema: schema(map[string]any{})},
	{Name: "open_files", Title: "Open FCS files", Annotations: edits,
		Description: "Open FCS files, folders of FCS files (each folder becomes a group), CytoWeave workspaces (.cwz), FlowJo workspaces (.wsp) or Gating-ML files, by absolute path on this computer.",
		InputSchema: schema(map[string]any{"paths": strList("Absolute paths of files or folders")}, "paths")},
	{Name: "open_example", Title: "Open an example experiment", Annotations: edits,
		Description: "Generate and open a simulated example experiment as a new workspace: pbmc-immunophenotyping, flowjo-workspace (four samples and a FlowJo workspace, which opens in the FlowJo import dialog for the user), spectral-25color, cell-cycle, proliferation, cytof-cohort, cytof-barcoded (a pooled, palladium-barcoded plate), index-sort, qc-showcase or bead-qc (30 daily runs of multi-level beads for Q, B and Levey–Jennings).",
		InputSchema: schema(map[string]any{"id": map[string]any{"type": "string", "enum": []string{"pbmc-immunophenotyping", "flowjo-workspace", "spectral-25color", "cell-cycle", "proliferation", "cytof-cohort", "cytof-barcoded", "index-sort", "qc-showcase", "bead-qc"}}}, "id")},
	{Name: "select", Title: "Show a sample, population or view", Annotations: edits,
		Description: "Change what the window shows: a sample, a population, and/or a view (gate, qc, compensate, spectral, explore, tables, compare, figures, report).",
		InputSchema: schema(map[string]any{"sample": str(sampleHelp), "population": str(populationHelp), "view": str("View to show")})},
	{Name: "list_populations", Title: "List populations with counts", Annotations: readOnly,
		Description: "The gating tree for a sample: every population's path, gate type and channels, event count, % of parent and % of total.",
		InputSchema: schema(map[string]any{"sample": str(sampleHelp)})},
	{Name: "population_statistics", Title: "Statistics of a population", Annotations: readOnly,
		Description: "Count, frequencies and per-channel statistics (median, mean, geometric mean, SD, robust SD, CV, robust CV, percentiles) of one population in one sample, on compensated values.",
		InputSchema: schema(map[string]any{"sample": str(sampleHelp), "population": str(populationHelp), "channels": strList("Channels or markers (default: all fluorescence channels)")})},
	{Name: "statistics_table", Title: "A statistic across samples", Annotations: readOnly,
		Description: "One or more statistics of one or more populations for every sample (or a group): e.g. freqParent of CD4 T cells, or median of CD25 in Tregs. Statistics: count, freqParent, freqTotal, freqGrandparent, median, mean, geomean, sd, rsd, cv, rcv, percentile, mode, positive.",
		InputSchema: schema(map[string]any{"populations": strList("Populations (default: all)"), "statistic": str("Statistic id (default freqParent)"), "channel": str("Channel or marker for channel statistics"), "group": str("Group name (default: all samples)")})},
	{Name: "render_plot", Title: "Render a plot", Annotations: readOnly, image: true,
		Description: "A PNG image of a plot: a population of a sample on one or two channels, with the child gates drawn and labeled. Types: pseudocolor, dot, density, contour, zebra, histogram.",
		InputSchema: schema(map[string]any{"sample": str(sampleHelp), "population": str(populationHelp), "x": str("X channel or marker"), "y": str("Y channel or marker (omit for a histogram)"), "type": str("Plot type"), "width": num("Width in pixels (default 520)"), "height": num("Height in pixels (default 480)")}, "x")},
	{Name: "create_gate", Title: "Create a gate", Annotations: edits,
		Description: "Add a gate under a parent population. Coordinates are data values (as on the plot axes). Types and coordinates: rectangle {xMin, xMax, yMin, yMax} (omit a bound to leave it open), polygon {vertices: [[x, y], ...]}, ellipse {center: [x, y], semiAxes in fractions of the axes [rx, ry], angle in degrees}, range on one channel {min, max}, quadrant {at: [x, y]} (creates four populations), split on one channel {threshold} (two populations). The gate is proposed for the user's review (shown as proposed, usable as a parent at once). Returns the new populations with their counts.",
		InputSchema: schema(map[string]any{"parent": str(populationHelp), "name": str("Name (default: from the markers)"), "type": map[string]any{"type": "string", "enum": []string{"rectangle", "polygon", "ellipse", "range", "quadrant", "split"}}, "x": str("X channel or marker"), "y": str("Y channel or marker (not for range or split)"), "coordinates": map[string]any{"type": "object", "description": "Type-specific coordinates in data values"}, "sample": str("Sample whose counts are reported (default: the current sample); the gate applies to every sample")}, "type", "x", "coordinates")},
	{Name: "auto_gate", Title: "Propose a gate from the data", Annotations: edits,
		Description: "Add a gate found from the data's density: method \"density\" gates the population around a point (at: [x, y] in data values) like a magic wand; \"singlets\" gates single cells on an area-versus-height plot (x = FSC-A, y = FSC-H); \"valley\" splits one channel at the density minimum between its two main modes. The explanation says what was found. The gate is proposed for the user's review.",
		InputSchema: schema(map[string]any{"parent": str(populationHelp), "method": map[string]any{"type": "string", "enum": []string{"density", "singlets", "valley"}}, "x": str("X channel or marker"), "y": str("Y channel or marker"), "at": map[string]any{"type": "array", "items": map[string]any{"type": "number"}, "description": "[x, y] data values (density)"}, "name": str("Name"), "sample": str(sampleHelp)}, "method", "x")},
	{Name: "edit_gate", Title: "Rename, recolor or delete a gate", Annotations: map[string]any{"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false},
		Description: "Rename a population, change its color, or delete it (with its subpopulations). Changes to gates the user has accepted wait for the user's review; changes to gates you proposed apply at once.",
		InputSchema: schema(map[string]any{"population": str(populationHelp), "name": str("New name"), "color": str("New color (#rrggbb)"), "delete": map[string]any{"type": "boolean"}}, "population")},
	{Name: "review_gate", Title: "Review a gate across samples", Annotations: readOnly,
		Description: "A gate's frequency on every sample with a robust z-score against the cohort and the boundary robustness (how much the frequency depends on exactly where the boundary is), outliers first.",
		InputSchema: schema(map[string]any{"population": str(populationHelp)}, "population")},
	{Name: "adapt_gate", Title: "Adapt a gate to each sample", Annotations: edits,
		Description: "Adapt a gate to every sample by registering the density landmarks of its parent population along the gate's axes, learning from the samples the user drew, adjusted or confirmed it on. Each sample gets a confidence and a status: keep (the gate already fits), adjust (a confident adjustment, which is proposed for the user's review) or review (uncertain, left for the user to check by hand, with the reason). Adapt parents before their children: a sample under review for a parent stays under review for the children. A gate is moved only where it cuts into a population, since populations also move for biological reasons. When samples of one donor or subject differ by a stimulation being measured, pass groupBy (the metadata field) so that each group keeps one gate. Polygons, rectangles, ellipses, ranges, splits and quadrants can be adapted.",
		InputSchema: schema(map[string]any{"population": str(populationHelp), "groupBy": str("Sample metadata field whose samples keep one gate, adapted on their pooled events (e.g. donor or subject); default: each sample alone")}, "population")},
	{Name: "compare", Title: "Compare groups of samples", Annotations: readOnly,
		Description: "Test a population statistic between groups of samples defined by a metadata field (e.g. condition), optionally paired by another (e.g. subject): per-group values, effect size with confidence interval, and t-test and rank tests.",
		InputSchema: schema(map[string]any{"population": str(populationHelp), "statistic": str("Statistic id (default freqParent)"), "channel": str("Channel or marker for channel statistics"), "groupBy": str("Metadata field that defines the groups"), "pairBy": str("Metadata field that pairs samples (optional)")}, "population", "groupBy")},
	{Name: "check_robustness", Title: "Check a comparison against other analysis choices", Annotations: readOnly,
		Description: "Repeat a two-group comparison (as compare) under other reasonable analysis choices — each gate on the population's path moved 1% and 2% of the axis, the gates adapted to each sample or without per-sample adjustments, without acquisition QC (and, with rerunQC, QC re-run with MAD 4 and 8), other compensation matrices, a rank test — alone and in random combinations (64 analyses), and report whether the conclusion holds (in at least 90% of them), mostly holds (70%) or is fragile, which single choices change it, and which change the size of a difference found beyond its confidence interval. The declared analysis stays the result; report fragility rather than choosing the analysis that gives the answer you want. Takes seconds to a minute.",
		InputSchema: schema(map[string]any{"population": str(populationHelp), "statistic": str("Statistic id (default freqParent)"), "channel": str("Channel or marker for channel statistics"), "groupBy": str("Metadata field that defines the groups"), "groups": strList("The two groups to compare, reference first (default: the field's two values)"), "pairBy": str("Metadata field that pairs samples (optional)"), "rerunQC": map[string]any{"type": "boolean", "description": "Also re-run acquisition QC with stricter and looser settings (slower)"}}, "population", "groupBy")},
	{Name: "propose_compensation", Title: "Propose a compensation matrix from the controls", Annotations: edits,
		Description: "Compute a spillover matrix from the workspace's single-stain controls (samples with the role single-stain and a stained channel), optionally within a population of each control (e.g. its singlets) and with an unstained sample as the negative reference, and propose it for the samples. The user reviews it with your other changes; the result lists the largest spillover values and any warnings about the controls.",
		InputSchema: schema(map[string]any{"population": str("Population of each control to use (default: all events)"), "unstained": str("Unstained sample used as the negative reference (default: the dim events of each control)"), "method": map[string]any{"type": "string", "enum": []string{"median", "regression"}}, "samples": strList("Samples to apply it to (default: every sample that is not a control)")})},
	{Name: "annotate_samples", Title: "Annotate samples", Annotations: edits,
		Description: "Set samples' metadata fields (condition, subject, donor, batch, timepoint, … or any field; null removes one), their role (sample, unstained, single-stain, fmo, isotype, bead, reference) and, for single-stain controls, the stained channel. Compare, check_robustness, adapt_gate (groupBy), propose_compensation and unmix use these. The annotations wait for the user's review: until the user accepts, the tools see the current ones.",
		InputSchema: schema(map[string]any{"samples": map[string]any{"type": "array", "description": "One entry per sample: {sample, meta: {field: value}, role, stain}", "items": map[string]any{"type": "object", "properties": map[string]any{"sample": str(sampleHelp), "meta": map[string]any{"type": "object", "description": "Field → value (string; null removes the field)"}, "role": str("Role"), "stain": str("Stained channel of a single-stain control (name or marker)")}, "required": []string{"sample"}}}}, "samples")},
	{Name: "run_qc", Title: "Run acquisition QC", Annotations: edits,
		Description: "Acquisition QC of samples, as the QC view runs it: PeacoQC (refined by default, or classic as in R), a flow-rate check, margin events and per-channel drift. Returns each sample's score (0–100), the share of events removed and the findings, worst first. The result is proposed: its \"QC pass\" channel (1 = passed) can be gated at once. With addGate, a \"QC pass\" gate is proposed at the top of the gating tree, which moves every population beneath it when the user accepts. Samples the user has already checked keep the user's result. Takes seconds per sample.",
		InputSchema: schema(map[string]any{"samples": strList("Samples (default: every sample that is not a control)"), "includeControls": map[string]any{"type": "boolean", "description": "Also check controls (default false)"}, "variant": map[string]any{"type": "string", "enum": []string{"refined", "classic"}}, "mad": num("PeacoQC MAD threshold (default 6; lower is stricter)"), "addGate": map[string]any{"type": "boolean", "description": "Propose a \"QC pass\" gate at the top of the tree"}})},
	{Name: "unmix", Title: "Unmix spectral data", Annotations: edits,
		Description: "Spectral unmixing of raw spectral files (Aurora, ID7000, FACSDiscover and others) with reference spectra from the single-stain controls (role single-stain), each gated automatically, and autofluorescence signatures from the unstained control (role unstained). The user's reference library is used when there is one; otherwise one is computed and proposed. Methods: ols (default), wls, wls-fixed, nnls; autofluorescenceMode: none, single, perEvent. Returns the unmixed channels (proposed, usable at once), each reference's peak detector, stain index and warnings, the panel's complexity index and each sample's median residual.",
		InputSchema: schema(map[string]any{"samples": strList("Samples to unmix (default: every sample that is not a control)"), "method": str("ols, wls, wls-fixed or nnls"), "autofluorescenceMode": str("none, single or perEvent"), "autofluorescence": map[string]any{"type": "boolean", "description": "Extract autofluorescence signatures when building a library (default true)"}, "unstainedPopulation": str("Population of the unstained control for the signatures (e.g. its live single cells)"), "recompute": map[string]any{"type": "boolean", "description": "Recompute your own proposed library"}})},
	{Name: "explore", Title: "Cluster and map cells", Annotations: edits,
		Description: "Cluster the events of a population across samples (flowsom, phenograph (Leiden), louvain, kmeans or none; every event gets a cluster) and map them (umap, tsne, pca or none, on an equal subsample per sample), as the Explore view does. Returns each cluster's name from marker enrichment, frequency and abundance per sample, and the map's faithfulness (trustworthiness, continuity, neighbor preservation, sample mixing) with warnings. The channels (e.g. \"FlowSOM cluster\", \"UMAP 1\") are proposed and usable at once; with populations: true the clusters are proposed as populations (category gates) to compare. Markers default to the lineage and phenotype markers (viability, DNA and dump channels left out).",
		InputSchema: schema(map[string]any{"population": str(populationHelp), "samples": strList("Samples (default: every sample that is not a control)"), "group": str("A group of samples instead"), "markers": strList("Channels or markers to cluster on"), "clustering": str("flowsom (default), phenograph, louvain, kmeans or none"), "embedding": str("umap (default), tsne, pca or none"), "k": num("Metaclusters (FlowSOM) or clusters (k-means), default 12"), "neighbors": num("k of the neighbor graph (Leiden, Louvain), default 30"), "resolution": num("Leiden or Louvain resolution, default 1"), "nNeighbors": num("UMAP n_neighbors, default 15"), "minDist": num("UMAP min_dist, default 0.1"), "perplexity": num("t-SNE perplexity, default 30"), "eventsPerSample": num("Events per sample in the map, default 5000"), "seed": num("Random seed, default 42"), "populations": map[string]any{"type": "boolean", "description": "Propose the clusters as populations"}})},
	{Name: "build_figure", Title: "Build a figure", Annotations: edits,
		Description: "Lay out a publication figure, proposed for the user's review: kind gating-strategy shows one plot per gate on the path to a population in one sample, each gate on its parent, with arrows; kind across-samples shows the same plots (plots: [{x, y, type}], default the population's plots in the Gate view) of a population in a row per sample. The plots stay live (they follow gate and compensation changes) until export_figure writes the figure.",
		InputSchema: schema(map[string]any{"kind": map[string]any{"type": "string", "enum": []string{"gating-strategy", "across-samples"}}, "population": str(populationHelp), "sample": str("Sample of a gating strategy (default: the current sample)"), "samples": strList("Samples of an across-samples figure (default: every sample, at most 24)"), "group": str("A group of samples instead"), "plots": map[string]any{"type": "array", "description": "Plots of an across-samples figure: {x, y (omit for a histogram), type}", "items": map[string]any{"type": "object"}}, "name": str("Figure name")}, "population")},
	{Name: "export_flowjo", Title: "Export a FlowJo workspace", Annotations: writesFile,
		Description: "Write the workspace as a FlowJo 10 workspace (.wsp), opened by FlowJo 10 and 11: one gating tree per sample with its adjustments, the compensation, scales, groups and, by default, CytoWeave's counts to check against. With files: true, a .zip holding the workspace and its FCS files; with deidentify, identifying keywords are removed from both. Returns the populations not written exactly (traced on another scale, or not exported) and why. The file must not exist unless overwrite is true.",
		InputSchema: schema(map[string]any{"path": str("Absolute path of the file to write (.wsp, or .zip with files)"), "files": map[string]any{"type": "boolean", "description": "Include the FCS files (a .zip)"}, "deidentify": map[string]any{"type": "boolean"}, "counts": map[string]any{"type": "boolean", "description": "Include population counts (default true)"}, "samples": strList("Samples (default: all)"), "overwrite": map[string]any{"type": "boolean"}}, "path")},
	{Name: "export_fcs", Title: "Export de-identified FCS files", Annotations: writesFile,
		Description: "Write de-identified copies of the samples' FCS files: only the keywords needed to read and analyze them are kept (operator, specimen and patient fields, free-text comments, dates unless keepDates, serial numbers and vendor keywords are removed), the events copied byte for byte. A .zip of the files, or an .acs archive with the workspace. Files are named after their samples, whose names are kept.",
		InputSchema: schema(map[string]any{"path": str("Absolute path of the file to write (.zip or .acs)"), "samples": strList("Samples (default: all)"), "keepDates": map[string]any{"type": "boolean"}, "overwrite": map[string]any{"type": "boolean"}}, "path")},
	{Name: "export_figure", Title: "Export a figure", Annotations: writesFile,
		Description: "Write a figure (by name; default the newest) as SVG (vector), PNG (3×) or PDF (300 dpi), chosen by the path's extension. By default the file carries the analysis behind each plot (gates, scales, compensation, file checksums), so opening it in CytoWeave shows what changed since.",
		InputSchema: schema(map[string]any{"path": str("Absolute path of the file to write (.svg, .png or .pdf)"), "figure": str("Figure name"), "provenance": map[string]any{"type": "boolean", "description": "Embed the analysis (default true)"}, "overwrite": map[string]any{"type": "boolean"}}, "path")},
	{Name: "export_table", Title: "Export a statistics table", Annotations: writesFile,
		Description: "Write a statistic of populations for every sample (as statistics_table) to a CSV or TSV file: one row per sample with its metadata, one column per population.",
		InputSchema: schema(map[string]any{"path": str("Absolute path of the file to write (.csv or .tsv)"), "populations": strList("Populations (default: all)"), "statistic": str("Statistic id (default freqParent)"), "channel": str("Channel or marker for channel statistics"), "group": str("Group name (default: all samples)"), "overwrite": map[string]any{"type": "boolean"}}, "path")},
	{Name: "list_templates", Title: "List analysis templates", Annotations: readOnly,
		Description: "The analysis templates in the library (saved by the user or save_template): each one's name, populations and the markers its channels measure; and the published gating strategies (OMIP-101 major leukocyte populations, OMIP-090 regulatory T cells) that apply_template places on the data, with their citations and where they differ from the articles.",
		InputSchema: schema(map[string]any{})},
	{Name: "save_template", Title: "Save the analysis as a template", Annotations: edits,
		Description: "Save the workspace's analysis (or one population and those under it) as a template in the library: the gates, scales, plots, tables and figure layouts, with channels described by marker (scatter and time by name) so that it applies to another panel. Gates on computed channels and per-sample adjustments are left out and listed.",
		InputSchema: schema(map[string]any{"name": str("Template name"), "population": str("Keep only this population and those under it (default: the whole tree)")}, "name")},
	{Name: "apply_template", Title: "Apply an analysis template", Annotations: edits,
		Description: "Apply a template from the library, or a published gating strategy (omip-101, omip-090; see list_templates), to the open samples: each of its channels is matched by marker (preferring the same area/height suffix), scatter and time by name, and the report says how each matched and which populations could not be applied (with the reason). A strategy's gates are placed on the events of one sample (sample, default the current one), each from its parent population: density peaks for scatter, valleys between a marker's modes for positive and negative cells, and come with suggested Cell Ontology terms. The gates and figures are proposed for the user's review; gates keep their position in data values, so check them across samples with review_gate and adjust with adapt_gate. channels overrides a match: {\"CD3\": \"FL4-A\"}.",
		InputSchema: schema(map[string]any{"template": str("Template name, or a strategy id (omip-101)"), "sample": str("Sample whose events a strategy's gates are placed on (default: the current sample)"), "parent": str("Population to put the template's top gates under (default: the top of the tree)"), "channels": map[string]any{"type": "object", "description": "Template marker or channel name → channel here"}, "figures": map[string]any{"type": "boolean", "description": "Also propose its figures (default true)"}}, "template")},
	{Name: "suggest_cell_types", Title: "Suggest Cell Ontology terms", Annotations: edits,
		Description: "Suggest a Cell Ontology term for each population (or the ones named) from its marker phenotype in a sample: which side of each gate's markers it lies on and, for scatter gates, where it sits, never from its name. Each suggestion has a confidence (exact: every marker the term requires is gated; likely: only negative markers are not gated) and the markers it rests on. With propose: true, the top terms are proposed for the user to confirm; confirmed terms go into the FlowJo and Gating-ML exports and the methods.",
		InputSchema: schema(map[string]any{"populations": strList("Populations (default: all)"), "sample": str(sampleHelp), "propose": map[string]any{"type": "boolean", "description": "Propose the top terms for the user to confirm"}})},
	{Name: "titration", Title: "Analyze a titration or voltage walk", Annotations: edits,
		Description: "A reagent titration (samples stained with a series of amounts of one antibody, read from their names, such as \"125 ng\" or \"1:200\", or an \"amount\" annotation) or a detector voltage walk (samples acquired at a series of PMT voltages, from each file's $PnV). On one channel (default: the one the names mention, or found from the data), within a population (default: one named like lymphocytes), each step's positive and negative cells give the stain index (Maecker), separation index (Bigos) and medians. Titration: a saturation curve fitted to the stain index; the recommended amount is the first tested at or above twice the amount giving 90% of saturation (Bonilla et al. 2024). Voltage walk: the minimum voltage, where the negative cells' rSD reaches 2.5 times the detector's electronic noise (rsdEN from the cytometer's baseline report, or estimated from the walk), and the maximum, where the positive cells' 99th percentile reaches the top of the linear range (linearMax, default 90% of the range). With save, the result is proposed for the workspace, and the methods describe it.",
		InputSchema: schema(map[string]any{"mode": map[string]any{"type": "string", "enum": []string{"titration", "voltage"}}, "samples": strList("The samples of the series (default: found from names and voltages)"), "channel": str("Channel or marker (default: detected)"), "population": str("Population to analyze within (default: a lymphocyte gate if any, else all events)"), "rsdEN": map[string]any{"type": "number", "description": "The detector's electronic noise rSD (voltage walk)"}, "linearMax": map[string]any{"type": "number", "description": "Top of the detector's linear range (voltage walk)"}, "save": map[string]any{"type": "boolean", "description": "Propose the result for the workspace"}}, "mode")},
	{Name: "watch_folder", Title: "Watch an instrument's export folder", Annotations: edits,
		Description: "QC as files are acquired: action start watches a folder (absolute path) the instrument exports to; each FCS file is added to the workspace once complete and checked at once (acquisition QC for samples and controls, Q and B for bead files, against the instrument's Levey–Jennings rules). The folder is only read. Files already there wait for action existing. action status lists every file with its result (call it again to follow new files); stop ends the watch.",
		InputSchema: schema(map[string]any{"action": map[string]any{"type": "string", "enum": []string{"start", "stop", "existing", "status"}}, "path": str("Folder to watch (start)"), "existing": map[string]any{"type": "boolean", "description": "Also check the files already there (start)"}, "qc": map[string]any{"type": "boolean", "description": "Run acquisition QC on samples (default true)"}, "beads": map[string]any{"type": "boolean", "description": "Measure Q and B on bead files (default true)"}}, "action")},
	{Name: "proposals", Title: "Proposals and the user's decisions", Annotations: readOnly,
		Description: "Your open proposal (what is waiting for the user's review) and the user's recent decisions on proposals (accepted or rejected, by whom).",
		InputSchema: schema(map[string]any{})},
	{Name: "methods", Title: "Write the methods", Annotations: readOnly,
		Description: "A methods paragraph for the analysis in the workspace, with numbered references and DOIs.",
		InputSchema: schema(map[string]any{})},
	{Name: "export_gating_ml", Title: "Export gates as Gating-ML", Annotations: readOnly,
		Description: "The gating strategy as ISAC Gating-ML 2.0 XML text.",
		InputSchema: schema(map[string]any{})},
}

var mcpToolByName = func() map[string]mcpTool {
	byName := make(map[string]mcpTool, len(mcpTools))
	for _, tool := range mcpTools {
		byName[tool.Name] = tool
	}
	return byName
}()
