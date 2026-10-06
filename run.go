package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// "cytoweave run" applies an analysis template to FCS files without a window, for a core's nightly
// runs, pipelines and CI: it starts CytoWeave on a private port with no workspace library, opens
// it in a headless Chrome (or Chromium, Edge, Brave), performs the steps through the same actions
// agents and scripts use, writes the outputs to a folder, and stops. The run stands for the user
// who started it, so the proposals its steps make are accepted (accept_proposals, a step only the
// run itself can send). run.json in the output folder records what was read (with checksums),
// each step's outcome, every population's count per sample and what was written.
//
// Default steps: open the files (and an annotations or plate-layout CSV), optionally run QC, apply
// the template, accept, then write its tables (an Excel workbook and a CSV per table), a batch
// report of its last figure, optionally a FlowJo workspace, the workspace (.cwz) and the methods.
// --steps replaces them with a JSON list of {action, args}: any agent action (see docs/MCP.md),
// with "$inputs" in open_files' paths for the files named on the command line, relative paths
// in open_files and templateFile (a template file read into templateJSON) from the steps file's
// folder, and relative output paths in the output folder.

const (
	runClient      = "cytoweave run"
	runPageTimeout = 90 * time.Second
	exitRunFailed  = 1
	exitRunUsage   = 2
)

type runStep struct {
	Action string         `json:"action"`
	Args   map[string]any `json:"args,omitempty"`
	// Required steps stop the run when they fail (opening the files, applying the template).
	Required bool `json:"required,omitempty"`
}

type runFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type runStepRecord struct {
	Action  string          `json:"action"`
	OK      bool            `json:"ok"`
	Message string          `json:"message"`
	Seconds float64         `json:"seconds"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type runRecord struct {
	CytoWeave string          `json:"cytoweave"`
	Command   []string        `json:"command"`
	Started   string          `json:"started"`
	Finished  string          `json:"finished"`
	Seconds   float64         `json:"seconds"`
	OK        bool            `json:"ok"`
	Template  *runFile        `json:"template,omitempty"`
	Inputs    []runFile       `json:"inputs"`
	Steps     []runStepRecord `json:"steps"`
	Outputs   []runFile       `json:"outputs"`
}

type runOptions struct {
	template    string
	output      string
	annotations string
	report      string
	reportBy    string
	qc          bool
	flowjo      bool
	steps       string
	overwrite   bool
	chrome      string
	timeout     time.Duration
	dev         bool
	inputs      []string
}

func runHeadless(args []string, stdout, stderr io.Writer) int {
	opts, err := parseRunArgs(args, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave run:", err)
		return exitRunUsage
	}
	steps, template, err := planRun(opts)
	if err == nil && !opts.overwrite {
		err = existingOutputs(steps)
	}
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave run:", err)
		return exitRunUsage
	}
	browser := opts.chrome
	if browser == "" {
		browser = os.Getenv("CHROME")
	}
	if browser == "" {
		browser = findChromium()
	}
	if browser == "" {
		fmt.Fprintln(stderr, "cytoweave run: it needs Chrome, Chromium, Edge or Brave to run in; none was found (give --chrome PATH or set CHROME).")
		return exitRunUsage
	}
	ctx, cancel := context.WithTimeout(context.Background(), opts.timeout)
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			fmt.Fprintln(stderr, "cytoweave run: interrupted")
			cancel()
		case <-ctx.Done():
		}
	}()
	record := runRecord{CytoWeave: version, Command: append([]string{"cytoweave", "run"}, args...), Started: time.Now().UTC().Format(time.RFC3339), Inputs: []runFile{}, Steps: []runStepRecord{}, Outputs: []runFile{}}
	if template != "" {
		if f, err := describeFile(template); err == nil {
			record.Template = &f
		}
	}
	started := time.Now()
	ok := execute(ctx, opts, steps, browser, &record, stdout, stderr)
	record.Finished = time.Now().UTC().Format(time.RFC3339)
	record.Seconds = time.Since(started).Seconds()
	record.OK = ok
	if err := writeRunRecord(filepath.Join(opts.output, "run.json"), record); err != nil {
		fmt.Fprintln(stderr, "cytoweave run: could not write run.json:", err)
		return exitRunFailed
	}
	if !ok {
		fmt.Fprintf(stderr, "cytoweave run: finished with errors in %.1f s; see %s\n", record.Seconds, filepath.Join(opts.output, "run.json"))
		return exitRunFailed
	}
	fmt.Fprintf(stdout, "Done in %.1f s: %d files written to %s (run.json lists them).\n", record.Seconds, len(record.Outputs), opts.output)
	return 0
}

func parseRunArgs(args []string, stderr io.Writer) (runOptions, error) {
	var opts runOptions
	flags := flag.NewFlagSet("cytoweave run", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&opts.template, "template", "", "the analysis template (.cwt) to apply")
	flags.StringVar(&opts.output, "output", "", "folder for the outputs (made if missing)")
	flags.StringVar(&opts.annotations, "annotations", "", "a CSV of sample annotations (first column the sample) or a plate layout (a \"well\" column, or plate maps)")
	flags.StringVar(&opts.report, "report", "pdf", "the batch report of the template's last figure: pdf, pptx or none")
	flags.StringVar(&opts.reportBy, "report-by", "", "the report's pages: sample, or an annotation such as subject (default: the figure's own choice)")
	flags.BoolVar(&opts.qc, "qc", false, "run acquisition QC first, with a \"QC pass\" population above the template's")
	flags.BoolVar(&opts.flowjo, "flowjo", false, "also write a FlowJo workspace (workspace.wsp)")
	flags.StringVar(&opts.steps, "steps", "", "a JSON file of steps ({action, args}) to run instead of the default ones")
	flags.BoolVar(&opts.overwrite, "overwrite", false, "replace outputs that already exist")
	flags.StringVar(&opts.chrome, "chrome", "", "the Chrome, Chromium, Edge or Brave to run in (default: CHROME, else one installed)")
	flags.DurationVar(&opts.timeout, "timeout", 2*time.Hour, "stop a run that takes longer")
	flags.BoolVar(&opts.dev, "dev", false, "serve web/ from the working directory instead of the embedded copy")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "Usage: cytoweave run --template panel.cwt --output results/ [flags] FCS files or folders...")
		fmt.Fprintln(flags.Output(), "       cytoweave run --steps steps.json --output results/ [flags] [FCS files or folders...]")
		fmt.Fprintln(flags.Output(), "Applies an analysis without a window and writes its tables, report, workspace and methods.")
		flags.PrintDefaults()
	}
	inputs, err := parseArgs(flags, args)
	if err != nil {
		return opts, err
	}
	opts.inputs = inputs
	if opts.output == "" {
		return opts, errors.New("give --output, the folder for the outputs")
	}
	if opts.output, err = absPath(opts.output); err != nil {
		return opts, err
	}
	switch opts.report {
	case "pdf", "pptx", "none":
	default:
		return opts, fmt.Errorf("--report is pdf, pptx or none, not %q", opts.report)
	}
	if opts.timeout <= 0 {
		return opts, errors.New("--timeout must be positive")
	}
	for i, input := range opts.inputs {
		path, err := absPath(input)
		if err != nil {
			return opts, err
		}
		if _, err := os.Stat(path); err != nil {
			return opts, fmt.Errorf("%s: %v", input, err)
		}
		opts.inputs[i] = path
	}
	return opts, nil
}

// The template's name and what it holds, from its file.
type templateSummary struct {
	Format  string                  `json:"format"`
	Name    string                  `json:"name"`
	Tables  []struct{ Name string } `json:"tables"`
	Figures []struct{ Name string } `json:"figures"`
}

func readTemplate(path string) (string, templateSummary, error) {
	var summary templateSummary
	data, err := os.ReadFile(path)
	if err != nil {
		return "", summary, err
	}
	if err := json.Unmarshal(data, &summary); err != nil || summary.Format != "cytoweave-template" {
		return "", summary, fmt.Errorf("%s is not a CytoWeave template (.cwt)", path)
	}
	return string(data), summary, nil
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// fileName makes a table's name a file name: "CD4 T cells: % of parent" → "CD4_T_cells_of_parent".
func fileName(name string, used map[string]bool) string {
	base := strings.Trim(unsafeName.ReplaceAllString(name, "_"), "_.")
	if base == "" {
		base = "table"
	}
	candidate := base
	for n := 2; used[strings.ToLower(candidate)]; n++ {
		candidate = fmt.Sprintf("%s_%d", base, n)
	}
	used[strings.ToLower(candidate)] = true
	return candidate
}

// planRun makes the steps (the default ones, or the steps file's) with their paths resolved.
// Returns the steps and the template's path (for run.json).
func planRun(opts runOptions) ([]runStep, string, error) {
	out := func(name string) string { return filepath.Join(opts.output, name) }
	if opts.steps != "" {
		return readSteps(opts)
	}
	if opts.template == "" {
		return nil, "", errors.New("give --template (the analysis to apply), or --steps")
	}
	if len(opts.inputs) == 0 {
		return nil, "", errors.New("name the FCS files or folders to analyze")
	}
	templatePath, err := absPath(opts.template)
	if err != nil {
		return nil, "", err
	}
	text, summary, err := readTemplate(templatePath)
	if err != nil {
		return nil, "", err
	}
	paths := append([]string{}, opts.inputs...)
	if opts.annotations != "" {
		path, err := absPath(opts.annotations)
		if err != nil {
			return nil, "", err
		}
		if _, err := os.Stat(path); err != nil {
			return nil, "", fmt.Errorf("%s: %v", opts.annotations, err)
		}
		paths = append(paths, path)
	}
	steps := []runStep{{Action: "open_files", Args: map[string]any{"paths": paths}, Required: true}}
	if opts.qc {
		steps = append(steps, runStep{Action: "run_qc", Args: map[string]any{"addGate": true}})
	}
	steps = append(steps,
		runStep{Action: "apply_template", Args: map[string]any{"templateJSON": text}, Required: true},
		runStep{Action: "accept_proposals", Required: true},
	)
	if len(summary.Tables) > 0 {
		steps = append(steps, runStep{Action: "export_table", Args: map[string]any{"path": out("tables.xlsx")}})
		used := map[string]bool{"tables": true, "run": true, "methods": true, "report": true, "workspace": true}
		for _, table := range summary.Tables {
			steps = append(steps, runStep{Action: "export_table", Args: map[string]any{"table": table.Name, "path": out(fileName(table.Name, used) + ".csv")}})
		}
	}
	if len(summary.Figures) > 0 && opts.report != "none" {
		report := map[string]any{"path": out("report." + opts.report)}
		if opts.reportBy != "" {
			report["by"] = opts.reportBy
		}
		steps = append(steps, runStep{Action: "export_report", Args: report})
	}
	if opts.flowjo {
		steps = append(steps, runStep{Action: "export_flowjo", Args: map[string]any{"path": out("workspace.wsp")}})
	}
	steps = append(steps,
		runStep{Action: "export_workspace", Args: map[string]any{"path": out("workspace.cwz")}},
		runStep{Action: "methods", Args: map[string]any{"path": out("methods.txt")}},
		runStep{Action: "statistics_table", Args: map[string]any{"statistic": "count"}},
	)
	for i := range steps {
		if _, has := steps[i].Args["path"]; has && opts.overwrite {
			steps[i].Args["overwrite"] = true
		}
	}
	return steps, templatePath, nil
}

func readSteps(opts runOptions) ([]runStep, string, error) {
	stepsPath, err := absPath(opts.steps)
	if err != nil {
		return nil, "", err
	}
	data, err := os.ReadFile(stepsPath)
	if err != nil {
		return nil, "", err
	}
	var steps []runStep
	if err := json.Unmarshal(data, &steps); err != nil {
		var wrapped struct {
			Steps []runStep `json:"steps"`
		}
		if err2 := json.Unmarshal(data, &wrapped); err2 != nil || wrapped.Steps == nil {
			return nil, "", fmt.Errorf("%s: a JSON list of {\"action\": ..., \"args\": {...}} steps was expected", opts.steps)
		}
		steps = wrapped.Steps
	}
	if len(steps) == 0 {
		return nil, "", fmt.Errorf("%s has no steps", opts.steps)
	}
	base := filepath.Dir(stepsPath)
	local := func(p string) string {
		if filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(base, p)
	}
	templatePath := ""
	for i := range steps {
		step := &steps[i]
		if step.Action == "" {
			return nil, "", fmt.Errorf("%s: step %d has no action", opts.steps, i+1)
		}
		if step.Args == nil {
			step.Args = map[string]any{}
		}
		if step.Action == "open_files" {
			step.Required = true
			raw, _ := step.Args["paths"].([]any)
			var paths []any
			for _, p := range raw {
				text, _ := p.(string)
				if text == "$inputs" {
					for _, input := range opts.inputs {
						paths = append(paths, input)
					}
					continue
				}
				paths = append(paths, local(text))
			}
			step.Args["paths"] = paths
		}
		if file, ok := step.Args["templateFile"].(string); ok {
			text, _, err := readTemplate(local(file))
			if err != nil {
				return nil, "", err
			}
			delete(step.Args, "templateFile")
			step.Args["templateJSON"] = text
			templatePath = local(file)
			step.Required = true
		}
		if path, ok := step.Args["path"].(string); ok && !filepath.IsAbs(path) {
			step.Args["path"] = filepath.Join(opts.output, path)
		}
		if _, has := step.Args["path"]; has && opts.overwrite {
			if _, set := step.Args["overwrite"]; !set {
				step.Args["overwrite"] = true
			}
		}
	}
	return steps, templatePath, nil
}

// existingOutputs refuses, before anything runs, outputs that would replace files already there
// (unless a step says overwrite).
func existingOutputs(steps []runStep) error {
	var found []string
	for _, step := range steps {
		path, _ := step.Args["path"].(string)
		if path == "" || step.Args["overwrite"] == true {
			continue
		}
		if _, err := os.Stat(path); err == nil {
			found = append(found, path)
		}
	}
	if len(found) == 0 {
		return nil
	}
	return fmt.Errorf("%d output(s) already exist (%s); give --overwrite to replace them, or another --output", len(found), strings.Join(found, ", "))
}

// execute starts CytoWeave and the headless browser, performs the steps and records them.
func execute(ctx context.Context, opts runOptions, steps []runStep, browser string, record *runRecord, stdout, stderr io.Writer) bool {
	if err := os.MkdirAll(opts.output, 0o755); err != nil {
		record.Steps = append(record.Steps, runStepRecord{Action: "start", Message: err.Error()})
		fmt.Fprintln(stderr, "cytoweave run:", err)
		return false
	}
	scratch, err := os.MkdirTemp("", "cytoweave-run-")
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave run:", err)
		return false
	}
	defer os.RemoveAll(scratch)
	cfg := config{host: "127.0.0.1", port: 0, window: "none", noStore: true, remote: true, mcp: true, dev: opts.dev, dataDir: scratch}
	running, err := start(cfg, io.Discard)
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave run:", err)
		return false
	}
	go running.serve()
	defer running.stop(3 * time.Second)
	hub := running.app.control
	chrome := exec.CommandContext(ctx, browser,
		"--headless=new",
		"--user-data-dir="+filepath.Join(scratch, "profile"),
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-features=Translate,MediaRouter",
		"--window-size=1600,1000",
		running.url,
	)
	if err := chrome.Start(); err != nil {
		fmt.Fprintf(stderr, "cytoweave run: could not start %s: %v\n", browser, err)
		return false
	}
	exited := make(chan struct{})
	go func() {
		chrome.Wait()
		close(exited)
	}()
	defer func() {
		if chrome.Process != nil {
			chrome.Process.Kill()
		}
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
		}
	}()
	fmt.Fprintf(stdout, "CytoWeave %s: running %d steps in %s\n", version, len(steps), filepath.Base(browser))
	if !hub.waitForPage(ctx, runPageTimeout) {
		fmt.Fprintln(stderr, "cytoweave run: the page did not start in the browser")
		return false
	}
	ok := true
	for i, step := range steps {
		if ctx.Err() != nil {
			record.Steps = append(record.Steps, runStepRecord{Action: step.Action, Message: "Not run: the run was interrupted or timed out."})
			ok = false
			break
		}
		began := time.Now()
		outcome, err := performStep(ctx, hub, step, record)
		entry := runStepRecord{Action: step.Action, Seconds: time.Since(began).Seconds()}
		switch {
		case err != nil:
			entry.Message = err.Error()
		case !outcome.OK:
			entry.Message = outcome.Message
		default:
			entry.OK = true
			entry.Message = outcome.Message
			entry.Data = outcome.Data
		}
		if entry.OK && step.Action == "methods" {
			if path, _ := step.Args["path"].(string); path != "" {
				if err := writeTextOutput(path, outcome.Message+"\n", opts.overwrite); err != nil {
					entry.OK = false
					entry.Message = err.Error()
				} else if f, err := describeFile(path); err == nil {
					record.Outputs = append(record.Outputs, f)
				}
			}
			entry.Data = nil
		}
		if entry.OK && outputActions[step.Action] {
			if path, _ := step.Args["path"].(string); path != "" {
				if f, err := describeFile(path); err == nil {
					record.Outputs = append(record.Outputs, f)
				}
			}
		}
		record.Steps = append(record.Steps, entry)
		status := "ok"
		if !entry.OK {
			status = "FAILED"
			ok = false
		}
		fmt.Fprintf(stdout, "[%d/%d] %s: %s (%.1f s) %s\n", i+1, len(steps), step.Action, status, entry.Seconds, firstSentence(entry.Message))
		if !entry.OK && step.Required {
			fmt.Fprintf(stderr, "cytoweave run: %s failed, so the run stops: %s\n", step.Action, entry.Message)
			break
		}
	}
	return ok
}

func performStep(ctx context.Context, hub *remoteHub, step runStep, record *runRecord) (remoteResult, error) {
	args := step.Args
	if args == nil {
		args = map[string]any{}
	}
	encoded, err := json.Marshal(args)
	if err != nil {
		return remoteResult{}, err
	}
	if step.Action == "methods" {
		encoded = []byte("{}")
	}
	event := remoteEvent{Action: step.Action, Args: encoded, Client: runClient, Trusted: true}
	if outputActions[step.Action] {
		output, release, err := hub.prepareOutput(encoded)
		if err != nil {
			return remoteResult{}, errors.New(strings.Replace(err.Error(), "pass overwrite: true", "give --overwrite", 1))
		}
		defer release()
		event.Output = output
	}
	if step.Action == "open_files" {
		opened, err := hub.openEvent(encoded)
		if err != nil {
			return remoteResult{}, err
		}
		opened.Client, opened.Trusted = runClient, true
		event = opened
		for _, file := range opened.Files {
			if f, err := describeFile(file.path); err == nil {
				record.Inputs = append(record.Inputs, f)
			}
		}
	}
	return hub.dispatch(ctx, event)
}

func describeFile(path string) (runFile, error) {
	file, err := os.Open(path)
	if err != nil {
		return runFile{}, err
	}
	defer file.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, file)
	if err != nil {
		return runFile{}, err
	}
	return runFile{Path: path, Bytes: n, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func writeTextOutput(path, text string, overwrite bool) error {
	if _, err := os.Stat(path); err == nil && !overwrite {
		return fmt.Errorf("%s exists; give --overwrite to replace it", path)
	}
	_, err := writeOutput(path, true, strings.NewReader(text))
	return err
}

func writeRunRecord(path string, record runRecord) error {
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	_, err = writeOutput(path, true, strings.NewReader(string(data)+"\n"))
	return err
}

// The first sentence of a message, for the progress lines.
func firstSentence(message string) string {
	message = strings.TrimSpace(strings.SplitN(message, "\n", 2)[0])
	if i := strings.Index(message, ". "); i > 0 && i < 200 {
		return message[:i+1]
	}
	if len(message) > 200 {
		return message[:197] + "…"
	}
	return message
}
