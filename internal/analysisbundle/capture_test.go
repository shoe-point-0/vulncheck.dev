package analysisbundle

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestCaptureBundleNativeFixtureIsDeterministicAndBrowserReadable(t *testing.T) {
	moduleDir := t.TempDir()
	if err := writeFixtureModule(moduleDir); err != nil {
		t.Fatalf("write fixture module: %v", err)
	}

	firstPath := filepath.Join(t.TempDir(), "first.zip")
	secondPath := filepath.Join(t.TempDir(), "second.zip")
	options := fixtureCaptureOptions(moduleDir, firstPath)
	first, err := CaptureBundle(context.Background(), options)
	if err != nil {
		t.Fatalf("capture first bundle: %v", err)
	}
	options.OutputPath = secondPath
	second, err := CaptureBundle(context.Background(), options)
	if err != nil {
		t.Fatalf("capture second bundle: %v", err)
	}

	if !reflect.DeepEqual(first, second) {
		t.Fatalf("identical capture inputs produced different manifests\nfirst: %#v\nsecond: %#v", first, second)
	}
	firstBytes, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatalf("read first bundle: %v", err)
	}
	secondBytes, err := os.ReadFile(secondPath)
	if err != nil {
		t.Fatalf("read second bundle: %v", err)
	}
	if !bytes.Equal(firstBytes, secondBytes) {
		t.Fatal("identical capture inputs produced different archive bytes")
	}

	if first.SchemaVersion != schemaVersion || first.Assurance != assuranceProjectEvidence || first.CaptureKind != captureKindNativeGoList {
		t.Fatalf("unexpected capture provenance: %#v", first)
	}
	if first.Producer.GoVersion == "" || !strings.HasPrefix(first.Producer.GoVersion, "go") {
		t.Fatalf("capture did not record the Go toolchain used: %q", first.Producer.GoVersion)
	}
	if !reflect.DeepEqual(first.BuildProfile, BuildProfile{
		Goos: runtime.GOOS, Goarch: runtime.GOARCH, BuildTags: []string{}, CGOPolicy: "disabled",
	}) {
		t.Fatalf("unexpected build profile: %#v", first.BuildProfile)
	}
	if !reflect.DeepEqual(first.Roots, []string{"example.com/capture-fixture", "example.com/capture-fixture/pkg"}) {
		t.Fatalf("unexpected roots: %#v", first.Roots)
	}
	if !reflect.DeepEqual(first.PackageInventory, []PackageInventoryEntry{
		{
			Path: "example.com/capture-fixture", ModulePath: "example.com/capture-fixture", ModuleVersion: "devel",
			Files: []string{"main.go"}, Imports: []string{},
		},
		{
			Path: "example.com/capture-fixture/pkg", ModulePath: "example.com/capture-fixture", ModuleVersion: "devel",
			Files: []string{"pkg/leaf.go"}, Imports: []string{},
		},
	}) {
		t.Fatalf("capture does not agree with the fixture package selection: %#v", first.PackageInventory)
	}
	if len(first.Content) != 2 || first.Content[0].Path != "main.go" || first.Content[1].Path != "pkg/leaf.go" {
		t.Fatalf("unexpected selected source files: %#v", first.Content)
	}
	for _, entry := range first.Content {
		if entry.LengthPrefixedDigest != lengthPrefixedDigest(entry.Size, entry.Digest) {
			t.Fatalf("content entry %q has an invalid length-prefixed digest", entry.Path)
		}
	}

	expected := computeBundleDigest(first, zeroDigestPlaceholder)
	if expected != first.BundleDigest {
		t.Fatalf("manifest bundle digest mismatch: got %q expected %q", first.BundleDigest, expected)
	}
	assertArchiveEntries(t, firstPath, first)
	assertCanonicalDigestAgreement(t, firstPath, first)
	verifyBrowserHydration(t, firstPath, first.BundleDigest)
}

func TestCaptureBundleDoesNotExecuteCodeOrEmitLocalSecrets(t *testing.T) {
	moduleDir := t.TempDir()
	if err := writeFixtureModule(moduleDir); err != nil {
		t.Fatalf("write fixture module: %v", err)
	}
	markerPath := filepath.Join(moduleDir, "executed.marker")
	mainSource := `package capture_fixture

import "os"

func init() { _ = os.WriteFile("executed.marker", []byte("executed"), 0o600) }
func main() {}
`
	if err := os.WriteFile(filepath.Join(moduleDir, "main.go"), []byte(mainSource), 0o644); err != nil {
		t.Fatalf("write executable fixture: %v", err)
	}
	secret := "capture-token-must-not-be-emitted"
	t.Setenv("VULNCHECK_CAPTURE_TEST_TOKEN", secret)
	outPath := filepath.Join(t.TempDir(), "privacy.zip")
	manifest, err := CaptureBundle(context.Background(), fixtureCaptureOptions(moduleDir, outPath))
	if err != nil {
		t.Fatalf("capture privacy bundle: %v", err)
	}
	if _, err := os.Stat(markerPath); !os.IsNotExist(err) {
		t.Fatalf("capture executed application code, marker stat error: %v", err)
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read privacy bundle: %v", err)
	}
	if bytes.Contains(raw, []byte(secret)) || bytes.Contains(raw, []byte(moduleDir)) {
		t.Fatal("bundle emitted a local secret or absolute module path")
	}
	for _, content := range manifest.Content {
		if filepath.IsAbs(content.Path) || strings.Contains(content.Path, "\\") {
			t.Fatalf("bundle emitted a non-portable source identifier: %q", content.Path)
		}
	}
}

func TestCaptureBundleHonorsExplicitBuildProfile(t *testing.T) {
	moduleDir := t.TempDir()
	if err := writeFixtureModule(moduleDir); err != nil {
		t.Fatalf("write fixture module: %v", err)
	}
	for _, profile := range []struct {
		name string
		cgo  string
		tags []string
		want []string
	}{
		{name: "cgo disabled", cgo: "disabled", tags: []string{}, want: []string{"main.go", "pkg/leaf.go"}},
		{name: "cgo enabled with build tag", cgo: "enabled", tags: []string{"fixturetag"}, want: []string{"main.go", "pkg/leaf.go", "tagged.go"}},
	} {
		t.Run(profile.name, func(t *testing.T) {
			options := fixtureCaptureOptions(moduleDir, filepath.Join(t.TempDir(), "profile.zip"))
			options.CGOPolicy = profile.cgo
			options.BuildTags = profile.tags
			manifest, err := CaptureBundle(context.Background(), options)
			if err != nil {
				t.Fatalf("capture profile: %v", err)
			}
			if manifest.BuildProfile.CGOPolicy != profile.cgo || !reflect.DeepEqual(manifest.BuildProfile.BuildTags, profile.tags) {
				t.Fatalf("capture profile was not preserved: %#v", manifest.BuildProfile)
			}
			got := make([]string, 0, len(manifest.Content))
			for _, entry := range manifest.Content {
				got = append(got, entry.Path)
			}
			if !reflect.DeepEqual(got, profile.want) {
				t.Fatalf("selected source files = %#v, want %#v", got, profile.want)
			}
		})
	}
}

func TestCaptureBundleRejectsIncompleteProfile(t *testing.T) {
	moduleDir := t.TempDir()
	if err := writeFixtureModule(moduleDir); err != nil {
		t.Fatalf("write fixture module: %v", err)
	}
	for name, mutate := range map[string]func(*CaptureOptions){
		"unsupported cgo":   func(options *CaptureOptions) { options.CGOPolicy = "any" },
		"invalid build tag": func(options *CaptureOptions) { options.BuildTags = []string{"bad tag"} },
		"invalid timestamp": func(options *CaptureOptions) { options.GeneratedAt = "not-a-timestamp" },
	} {
		t.Run(name, func(t *testing.T) {
			options := fixtureCaptureOptions(moduleDir, filepath.Join(t.TempDir(), "invalid.zip"))
			mutate(&options)
			if _, err := CaptureBundle(context.Background(), options); err == nil {
				t.Fatal("capture accepted an incomplete build profile")
			}
		})
	}
}

func TestValidateArchiveByteLimitRejectsOversizedBundle(t *testing.T) {
	entry := ContentEntry{Path: "sources/large.go", Size: maxBundleArchiveBytes}
	if err := validateArchiveByteLimit([]byte("{}"), []ContentEntry{entry}); err == nil {
		t.Fatal("archive byte limit accepted an oversized bundle")
	}
}

func FuzzValidateBundlePath(f *testing.F) {
	f.Add("main.go")
	f.Add("../main.go")
	f.Add("sources/\\windows.go")
	f.Fuzz(func(t *testing.T, candidate string) {
		_ = validateBundlePath(candidate, t.TempDir())
	})
}

func fixtureCaptureOptions(moduleDir, outputPath string) CaptureOptions {
	return CaptureOptions{
		ModuleDir:       moduleDir,
		OutputPath:      outputPath,
		Goos:            runtime.GOOS,
		Goarch:          runtime.GOARCH,
		CGOPolicy:       "disabled",
		GeneratedAt:     "2026-08-29T00:00:00Z",
		ProducerID:      "test-producer",
		ProducerName:    "test-producer-name",
		ProducerVersion: "0.0.1",
	}
}

func writeFixtureModule(moduleDir string) error {
	if err := os.MkdirAll(filepath.Join(moduleDir, "pkg"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "go.mod"), []byte("module example.com/capture-fixture\n\ngo 1.22\n"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "main.go"), []byte("package capture_fixture\n\nfunc main() {}\n"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "tagged.go"), []byte("//go:build fixturetag\n\npackage capture_fixture\n\nfunc Tagged() {}\n"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "pkg", "leaf.go"), []byte("package pkg\n\nfunc Leaf() string { return \"leaf\" }\n"), 0o644); err != nil {
		return err
	}
	return nil
}

func assertArchiveEntries(t *testing.T, outPath string, manifest AnalysisBundleManifest) {
	t.Helper()
	read, err := zip.OpenReader(outPath)
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	defer read.Close()

	entries := map[string]struct{}{}
	for _, entry := range read.File {
		entries[entry.Name] = struct{}{}
	}
	if _, found := entries[manifestPath]; !found {
		t.Fatal("zip output missing manifest.json")
	}
	for _, content := range manifest.Content {
		if _, found := entries[content.Path]; !found {
			t.Fatalf("zip output missing content file %q", content.Path)
		}
	}
}

func verifyBrowserHydration(t *testing.T, bundlePath, bundleDigest string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required for cross-runtime AnalysisBundle verification")
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve repository root: %v", err)
	}
	command := exec.Command(node, filepath.Join(repositoryRoot, "scripts", "verify-analysis-bundle.mjs"), bundlePath)
	command.Dir = repositoryRoot
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("browser hydration of native bundle failed: %v\n%s", err, output)
	}
	var summary struct {
		BundleDigest string `json:"bundle_digest"`
	}
	if err := json.Unmarshal(output, &summary); err != nil {
		t.Fatalf("decode browser hydration summary: %v\n%s", err, output)
	}
	if summary.BundleDigest != bundleDigest {
		t.Fatalf("browser hydration returned digest %q, want %q", summary.BundleDigest, bundleDigest)
	}
}

func assertCanonicalDigestAgreement(t *testing.T, bundlePath string, manifest AnalysisBundleManifest) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required for cross-runtime AnalysisBundle verification")
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve repository root: %v", err)
	}
	command := exec.Command(node, filepath.Join(repositoryRoot, "scripts", "verify-analysis-bundle.mjs"), "--canonical", bundlePath)
	command.Dir = repositoryRoot
	browserCanonical, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("produce browser canonical payload: %v\n%s", err, browserCanonical)
	}
	nativeCanonical, err := marshalCanonicalJSON(bundleDigestValue(manifest, zeroDigestPlaceholder))
	if err != nil {
		t.Fatalf("produce native canonical payload: %v", err)
	}
	if !bytes.Equal(nativeCanonical, browserCanonical) {
		t.Fatalf("native and browser canonical payloads differ\nnative: %s\nbrowser: %s", nativeCanonical, browserCanonical)
	}
}
