package vulndb

import (
	"reflect"
	"testing"

	"vulncheck.dev/internal/analysisbundle"
)

func TestInputFromAnalysisBundleRetainsExactEvaluationFacts(t *testing.T) {
	manifest := analysisbundle.AnalysisBundleManifest{
		Assurance:   "project-evidence",
		CaptureKind: "native-go-list",
		Producer:    analysisbundle.Producer{GoVersion: "go1.22.4"},
		BuildProfile: analysisbundle.BuildProfile{
			Goos: "linux", Goarch: "amd64",
		},
		PackageInventory: []analysisbundle.PackageInventoryEntry{
			{Path: "example.com/project", Imports: []string{"golang.org/x/text/transform", "crypto/x509"}},
			{Path: "golang.org/x/text/transform", Imports: []string{"bytes"}},
		},
	}
	// ModuleGraph has an unexported type, but its exported fields remain part of
	// the bundle's public data contract and are populated by native capture.
	manifest.ModuleGraph.Requirements = []analysisbundle.ModuleRef{{Path: "golang.org/x/text", Version: "v0.3.2"}}

	input, err := InputFromAnalysisBundle(manifest)
	if err != nil {
		t.Fatalf("extract evaluation input: %v", err)
	}
	want := EvaluationInput{
		Modules:          []ModuleVersion{{Path: "golang.org/x/text", Version: "v0.3.2"}},
		ToolchainVersion: "go1.22.4",
		ImportPaths:      []string{"bytes", "crypto/x509", "example.com/project", "golang.org/x/text/transform"},
		BuildProfile:     BuildProfile{GOOS: "linux", GOARCH: "amd64"},
	}
	if !reflect.DeepEqual(input, want) {
		t.Fatalf("input = %#v, want %#v", input, want)
	}
}

func TestInputFromAnalysisBundleRejectsUntrustedCapture(t *testing.T) {
	_, err := InputFromAnalysisBundle(analysisbundle.AnalysisBundleManifest{Assurance: "module-view", CaptureKind: "manual"})
	if errorCode(err) != "vulndb-snapshot-invalid" {
		t.Fatalf("error code = %q, want vulndb-snapshot-invalid", errorCode(err))
	}
}
