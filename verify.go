package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// "cytoweave verify" verifies a reproducibility certificate (web/lib/certificate.js) without a
// window: in a headless browser, as "cytoweave run" does, it checks every file's SHA-256, the
// workspace, the change log's chain and certificate.json's fingerprint, computes every number
// again from the files and compares them bit for bit. It prints the verdict and, with --report,
// writes what was found as JSON. The exit status says the verdict, for scripts and CI.

const (
	exitVerifyDiffers    = 1
	exitVerifyUsage      = 2
	exitVerifyIncomplete = 3
)

type verifyOptions struct {
	certificate string
	data        []string
	report      string
	overwrite   bool
	chrome      string
	timeout     time.Duration
	dev         bool
}

type pathList []string

func (p *pathList) String() string     { return strings.Join(*p, ", ") }
func (p *pathList) Set(v string) error { *p = append(*p, v); return nil }

func parseVerifyArgs(args []string, stderr io.Writer) (verifyOptions, error) {
	var opts verifyOptions
	var data pathList
	flags := flag.NewFlagSet("cytoweave verify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Var(&data, "data", "a folder (or an FCS file) with the data, for a certificate written without it; may be repeated")
	flags.StringVar(&opts.report, "report", "", "also write what was found as JSON to this file")
	flags.BoolVar(&opts.overwrite, "overwrite", false, "replace the report file if it exists")
	flags.StringVar(&opts.chrome, "chrome", "", "the Chrome, Chromium, Edge or Brave to run in (default: CHROME, else one installed)")
	flags.DurationVar(&opts.timeout, "timeout", 2*time.Hour, "stop a verification that takes longer")
	flags.BoolVar(&opts.dev, "dev", false, "serve web/ from the working directory instead of the embedded copy")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "Usage: cytoweave verify [flags] analysis.certificate.acs")
		fmt.Fprintln(flags.Output(), "Computes every number of a CytoWeave reproducibility certificate again from its files and compares them.")
		fmt.Fprintln(flags.Output(), "Exit status: 0 confirmed, 1 not confirmed, 2 usage error, 3 incomplete (files missing).")
		flags.PrintDefaults()
	}
	positional, err := parseArgs(flags, args)
	if err != nil {
		return opts, err
	}
	if len(positional) != 1 {
		return opts, errors.New("give one certificate (.acs) to verify")
	}
	if opts.certificate, err = absPath(positional[0]); err != nil {
		return opts, err
	}
	if info, err := os.Stat(opts.certificate); err != nil {
		return opts, fmt.Errorf("%s: %v", positional[0], err)
	} else if info.IsDir() || fileKind(info.Name()) != "archive" {
		return opts, fmt.Errorf("%s is not a certificate (an .acs or .zip file)", positional[0])
	}
	for _, d := range data {
		path, err := absPath(d)
		if err != nil {
			return opts, err
		}
		if _, err := os.Stat(path); err != nil {
			return opts, fmt.Errorf("%s: %v", d, err)
		}
		opts.data = append(opts.data, path)
	}
	if opts.report != "" {
		if opts.report, err = absPath(opts.report); err != nil {
			return opts, err
		}
		if _, err := os.Stat(opts.report); err == nil && !opts.overwrite {
			return opts, fmt.Errorf("%s exists; give --overwrite to replace it", opts.report)
		}
	}
	if opts.timeout <= 0 {
		return opts, errors.New("--timeout must be positive")
	}
	return opts, nil
}

// What the page's verify_certificate returns (web/ui/remote.js), as far as the command needs it.
type verifyData struct {
	Verdict string `json:"verdict"`
	Files   struct {
		Total   int      `json:"total"`
		OK      int      `json:"ok"`
		Missing []string `json:"missing"`
		Changed []string `json:"changed"`
	} `json:"files"`
	Numbers struct {
		Checked     int `json:"checked"`
		Identical   int `json:"identical"`
		Close       int `json:"equalTo12Digits"`
		Differ      int `json:"differ"`
		NotComputed int `json:"notComputed"`
	} `json:"numbers"`
}

func runVerify(args []string, stdout, stderr io.Writer) int {
	opts, err := parseVerifyArgs(args, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave verify:", err)
		return exitVerifyUsage
	}
	browser := opts.chrome
	if browser == "" {
		browser = os.Getenv("CHROME")
	}
	if browser == "" {
		browser = findChromium()
	}
	if browser == "" {
		fmt.Fprintln(stderr, "cytoweave verify: it needs Chrome, Chromium, Edge or Brave to run in; none was found (give --chrome PATH or set CHROME).")
		return exitVerifyUsage
	}
	ctx, cancel := context.WithTimeout(context.Background(), opts.timeout)
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			fmt.Fprintln(stderr, "cytoweave verify: interrupted")
			cancel()
		case <-ctx.Done():
		}
	}()
	hub, stop, err := headlessPage(ctx, browser, opts.dev)
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave verify:", err)
		return exitVerifyDiffers
	}
	defer stop()
	fmt.Fprintf(stdout, "CytoWeave %s: verifying %s in %s\n", version, filepath.Base(opts.certificate), filepath.Base(browser))
	if !hub.waitForPage(ctx, runPageTimeout) {
		fmt.Fprintln(stderr, "cytoweave verify: the page did not start in the browser")
		return exitVerifyDiffers
	}
	params := map[string]any{"path": opts.certificate}
	if len(opts.data) > 0 {
		params["data"] = opts.data
	}
	encoded, _ := json.Marshal(params)
	event, err := hub.verifyEvent(encoded)
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave verify:", err)
		return exitVerifyUsage
	}
	event.Client = "cytoweave verify"
	began := time.Now()
	outcome, err := hub.dispatch(ctx, event)
	if err == nil && !outcome.OK {
		err = errors.New(outcome.Message)
	}
	if err != nil {
		fmt.Fprintln(stderr, "cytoweave verify:", err)
		return exitVerifyDiffers
	}
	var found verifyData
	if err := json.Unmarshal(outcome.Data, &found); err != nil {
		fmt.Fprintln(stderr, "cytoweave verify: the page's answer could not be read:", err)
		return exitVerifyDiffers
	}
	fmt.Fprintln(stdout, outcome.Message)
	close := ""
	if found.Numbers.Close > 0 {
		close = fmt.Sprintf(", %d equal to 12 significant digits", found.Numbers.Close)
	}
	fmt.Fprintf(stdout, "Files: %d of %d match their SHA-256. Numbers: %d identical%s of %d (%.1f s).\n", found.Files.OK, found.Files.Total, found.Numbers.Identical, close, found.Numbers.Checked, time.Since(began).Seconds())
	if opts.report != "" {
		var pretty any
		json.Unmarshal(outcome.Data, &pretty)
		text, _ := json.MarshalIndent(pretty, "", " ")
		if err := writeTextOutput(opts.report, string(text)+"\n", opts.overwrite); err != nil {
			fmt.Fprintln(stderr, "cytoweave verify: could not write the report:", err)
			return exitVerifyDiffers
		}
	}
	switch found.Verdict {
	case "confirmed":
		return 0
	case "incomplete":
		return exitVerifyIncomplete
	default:
		return exitVerifyDiffers
	}
}
