package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"vulncheck.dev/internal/analysisbundle"
)

func main() {
	moduleDir := flag.String("module-dir", ".", "module directory to inspect")
	outputPath := flag.String("out", "analysis-bundle.zip", "output path for analysis-bundle.zip")
	goos := flag.String("goos", "", "target GOOS (defaults to the companion host)")
	goarch := flag.String("goarch", "", "target GOARCH (defaults to the companion host)")
	cgoPolicy := flag.String("cgo-policy", "disabled", "CGO policy: disabled|enabled")
	buildTags := flag.String("build-tags", "", "comma-separated Go build tags")
	producerID := flag.String("producer-id", "vulncheck-bundle", "producer identifier")
	producerName := flag.String("producer-name", "vulncheck bundle", "producer display name")
	producerVersion := flag.String("producer-version", "dev", "producer semantic version")
	expectedGoVersion := flag.String("go-version", "", "optional expected Go toolchain version")
	generatedAt := flag.String("generated-at", "", "optional RFC3339 capture timestamp for reproducible output")
	flag.Parse()

	tags := parseBuildTags(*buildTags)
	options := analysisbundle.CaptureOptions{
		ModuleDir:         *moduleDir,
		OutputPath:        *outputPath,
		Goos:              *goos,
		Goarch:            *goarch,
		BuildTags:         tags,
		CGOPolicy:         *cgoPolicy,
		ProducerID:        *producerID,
		ProducerName:      *producerName,
		ProducerVersion:   *producerVersion,
		ProducerGoVersion: *expectedGoVersion,
		GeneratedAt:       *generatedAt,
	}

	if err := ensureOutputDirectory(*outputPath); err != nil {
		fmt.Fprintf(os.Stderr, "prepare output: %v\n", err)
		os.Exit(1)
	}

	manifest, err := analysisbundle.CaptureBundle(context.Background(), options)
	if err != nil {
		fmt.Fprintf(os.Stderr, "capture bundle: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("%s\n", manifest.BundleDigest)
}

func parseBuildTags(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	tags := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			tags = append(tags, trimmed)
		}
	}
	return tags
}

func ensureOutputDirectory(outputPath string) error {
	parent := filepath.Dir(outputPath)
	if parent == "." {
		return nil
	}
	return os.MkdirAll(parent, 0o755)
}
