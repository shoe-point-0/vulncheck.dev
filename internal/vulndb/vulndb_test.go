package vulndb

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	"vulncheck.dev/contract"
)

var fixtureTime = time.Date(2024, time.May, 21, 0, 0, 0, 0, time.UTC)

func TestOfficialFixtureDifferentialAndIndexEquivalence(t *testing.T) {
	release, publicKey := fixtureRelease(t, officialRecords(t))
	tests := []struct {
		name    string
		input   EvaluationInput
		status  contract.VersionStatus
		finding string
		matches []string
	}{
		{
			name:   "affected module version",
			input:  fixtureInput([]ModuleVersion{{Path: "golang.org/x/text", Version: "v0.3.2"}}, "", []string{"golang.org/x/text/transform"}, "linux", "amd64"),
			status: contract.VersionAffected, finding: "GO-2020-0015", matches: []string{"golang.org/x/text/transform"},
		},
		{
			name:   "fixed module version",
			input:  fixtureInput([]ModuleVersion{{Path: "golang.org/x/text", Version: "v0.3.3"}}, "", []string{"golang.org/x/text/transform"}, "linux", "amd64"),
			status: contract.VersionNotAffected, finding: "GO-2020-0015", matches: []string{"golang.org/x/text/transform"},
		},
		{
			name:   "affected standard library prerelease interval",
			input:  fixtureInput(nil, "go1.11.0", []string{"crypto/x509"}, "linux", "amd64"),
			status: contract.VersionAffected, finding: "GO-2022-0191", matches: []string{"crypto/x509"},
		},
		{
			name:   "fixed standard library version",
			input:  fixtureInput(nil, "go1.11.3", []string{"crypto/x509"}, "linux", "amd64"),
			status: contract.VersionNotAffected, finding: "GO-2022-0191", matches: []string{"crypto/x509"},
		},
		{
			name:   "affected toolchain version",
			input:  fixtureInput(nil, "go1.11.0", []string{"cmd/go/internal/get"}, "linux", "amd64"),
			status: contract.VersionAffected, finding: "GO-2022-0189", matches: []string{"cmd/go/internal/get"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scalar := release.Evaluate(test.input, fixtureTime, false)
			indexed := release.Evaluate(test.input, fixtureTime, true)
			if !reflect.DeepEqual(scalar, indexed) {
				t.Fatalf("index changed the canonical report\nscalar: %#v\nindexed: %#v", scalar, indexed)
			}
			if scalar.Status != test.status || scalar.Freshness != contract.FreshnessCurrent {
				t.Fatalf("status = %q/%q, want %q/current", scalar.Status, scalar.Freshness, test.status)
			}
			finding := findingByID(t, scalar.Findings, test.finding)
			if finding.AdvisoryURL == "" || len(finding.Record) == 0 {
				t.Fatal("finding did not retain canonical advisory evidence")
			}
			if paths := importPaths(finding.MatchedImports); !reflect.DeepEqual(paths, test.matches) {
				t.Fatalf("matched imports = %#v, want %#v", paths, test.matches)
			}
		})
	}
	if _, found := release.Record("GO-2020-0015"); !found {
		t.Fatal("verified release does not retain the canonical module advisory")
	}
	if len(publicKey) != ed25519.PublicKeySize {
		t.Fatal("fixture public key is invalid")
	}
}

func TestBuildAndLoadArchiveAreDeterministicAndSigned(t *testing.T) {
	records := officialRecords(t)
	options, publicKey := fixtureOptions()
	first, firstManifest, err := BuildArchive(records, options)
	if err != nil {
		t.Fatalf("build first archive: %v", err)
	}
	second, secondManifest, err := BuildArchive(records, options)
	if err != nil {
		t.Fatalf("build second archive: %v", err)
	}
	if !bytes.Equal(first, second) || !reflect.DeepEqual(firstManifest, secondManifest) {
		t.Fatal("identical records and provenance did not produce a deterministic signed release")
	}
	if firstManifest.ArchiveBytes != int64(len(first)) || firstManifest.RecordsCompressedBytes == 0 || firstManifest.RecordsUncompressedBytes == 0 || !validDigest(firstManifest.ContentDigest) {
		t.Fatalf("manifest has unmeasured release data: %#v", firstManifest)
	}
	release, err := LoadArchive(first, publicKey)
	if err != nil {
		t.Fatalf("load signed archive: %v", err)
	}
	if !reflect.DeepEqual(release.Manifest(), firstManifest) {
		t.Fatal("loaded manifest differs from signed manifest")
	}

	corrupt := append([]byte(nil), first...)
	corrupt[len(corrupt)/2] ^= 1
	if _, err := LoadArchive(corrupt, publicKey); err == nil {
		t.Fatal("corrupt release loaded successfully")
	}
}

func TestUnknownOutcomesPreserveFailureReason(t *testing.T) {
	release, publicKey := fixtureRelease(t, officialRecords(t))
	input := fixtureInput([]ModuleVersion{{Path: "golang.org/x/text", Version: "v0.3.3"}}, "", []string{"golang.org/x/text/transform"}, "linux", "amd64")

	stale := release.Evaluate(input, fixtureTime.Add(8*24*time.Hour), true)
	assertUnknownCode(t, stale, "vulndb-stale")
	assertUnknownCode(t, UnavailableEvaluation(), "vulndb-unavailable")
	assertUnknownCode(t, EvaluateArchive([]byte("not a zip"), publicKey, input, fixtureTime, true), "vulndb-corrupt")
	assertUnknownCode(t, EvaluateArchive(schemaIncompatibleArchive(t), publicKey, input, fixtureTime, true), "vulndb-schema-incompatible")

	unreviewed := append(recordByID(t, officialRecords(t), "GO-2020-0015"), []byte{}...)
	unreviewed = bytes.Replace(unreviewed, []byte(`"review_status":"REVIEWED"`), []byte(`"review_status":"UNREVIEWED"`), 1)
	unreviewedRelease, _ := fixtureRelease(t, [][]byte{unreviewed})
	unknown := unreviewedRelease.Evaluate(input, fixtureTime, true)
	assertUnknownCode(t, unknown, "vulndb-unreviewed")

	badSchema := bytes.Replace(recordByID(t, officialRecords(t), "GO-2020-0015"), []byte(`"schema_version":"1.3.1"`), []byte(`"schema_version":"9.0.0"`), 1)
	if _, err := ParseRecord(badSchema); errorCode(err) != "vulndb-schema-incompatible" {
		t.Fatalf("schema failure code = %q, want vulndb-schema-incompatible", errorCode(err))
	}
}

func schemaIncompatibleArchive(t testing.TB) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range map[string][]byte{
		manifestPath: []byte(`{"schema_version":"next"}`),
		indexPath:    []byte(`{}`),
	} {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestRangePlatformPseudoVersionAndModuleMajorPath(t *testing.T) {
	record := []byte(`{"schema_version":"1.3.1","id":"GO-2025-0001","modified":"2025-01-01T00:00:00Z","affected":[{"package":{"ecosystem":"Go","name":"example.com/mod/v2"},"ranges":[{"type":"SEMVER","events":[{"introduced":"2.0.0-0"},{"fixed":"2.1.0"}]}],"ecosystem_specific":{"imports":[{"path":"example.com/mod/v2/pkg","symbols":["Run"],"goos":["linux"],"goarch":["amd64"]}]}}],"database_specific":{"url":"https://pkg.go.dev/vuln/GO-2025-0001","review_status":"REVIEWED"}}`)
	release, _ := fixtureRelease(t, [][]byte{record})
	affected := release.Evaluate(fixtureInput([]ModuleVersion{{Path: "example.com/mod/v2", Version: "v2.0.0-20250101000000-abcdefabcdef"}}, "", []string{"example.com/mod/v2/pkg"}, "linux", "amd64"), fixtureTime, true)
	if affected.Status != contract.VersionAffected || len(affected.Findings[0].MatchedImports[0].Symbols) != 1 {
		t.Fatalf("major-path pseudo-version input was not matched: %#v", affected)
	}
	notAffected := release.Evaluate(fixtureInput([]ModuleVersion{{Path: "example.com/mod/v2", Version: "v2.0.1"}}, "", []string{"example.com/mod/v2/pkg"}, "darwin", "amd64"), fixtureTime, true)
	if notAffected.Status != contract.VersionNotAffected {
		t.Fatalf("platform restriction was ignored: %#v", notAffected)
	}

	malformed := bytes.Replace(record, []byte(`"fixed":"2.1.0"`), []byte(`"fixed":"not-a-version"`), 1)
	malformedRelease, _ := fixtureRelease(t, [][]byte{malformed})
	unknown := malformedRelease.Evaluate(fixtureInput([]ModuleVersion{{Path: "example.com/mod/v2", Version: "v2.0.0"}}, "", []string{"example.com/mod/v2/pkg"}, "linux", "amd64"), fixtureTime, false)
	assertUnknownCode(t, unknown, "vulndb-range-invalid")
}

func TestRangeIntervalsAndToolchainReleaseCandidates(t *testing.T) {
	ranges := []Range{{Type: "SEMVER", Events: []Event{
		{Introduced: "1.0.0"}, {Fixed: "2.0.0"},
		{Introduced: "3.0.0"}, {LastAffected: "4.0.0"},
	}}}
	for version, want := range map[string]contract.VersionStatus{
		"v0.9.9": contract.VersionNotAffected,
		"v1.5.0": contract.VersionAffected,
		"v2.0.0": contract.VersionNotAffected,
		"v3.5.0": contract.VersionAffected,
		"v4.0.0": contract.VersionAffected,
		"v4.0.1": contract.VersionNotAffected,
	} {
		got, diagnostic := evaluateRanges(ranges, version)
		if diagnostic != nil || got != want {
			t.Fatalf("range %s = %q/%#v, want %q/nil", version, got, diagnostic, want)
		}
	}
	if normalized, ok := normalizeToolchainVersion("go1.22rc2"); !ok || normalized != "v1.22.0-rc.2" {
		t.Fatalf("release candidate normalization = %q/%t", normalized, ok)
	}
	malformed := []Range{{Type: "SEMVER", Events: []Event{{Introduced: "2.0.0"}, {Fixed: "1.0.0"}}}}
	if status, diagnostic := evaluateRanges(malformed, "v2.0.0"); status != contract.VersionUnknown || diagnostic == nil {
		t.Fatalf("malformed range = %q/%#v, want unknown diagnostic", status, diagnostic)
	}
}

func TestExtractOfficialRecordsUsesDocumentedBulkLayout(t *testing.T) {
	var bytesBuffer bytes.Buffer
	writer := zip.NewWriter(&bytesBuffer)
	for _, entry := range []struct {
		name string
		data []byte
	}{
		{"index/db.json", []byte(`{"modified":"2024-05-20T16:03:47Z"}`)},
		{"ID/GO-2020-0015.json", officialRecords(t)[2]},
	} {
		file, err := writer.Create(entry.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := ExtractOfficialRecords(bytesBuffer.Bytes())
	if err != nil {
		t.Fatalf("extract documented bulk layout: %v", err)
	}
	if len(records) != 1 || !bytes.Equal(records[0], officialRecords(t)[2]) {
		t.Fatal("bulk extractor did not preserve the canonical ID record")
	}
}

func FuzzParseRecord(f *testing.F) {
	for _, record := range officialRecordsForFuzz() {
		f.Add(record)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		_, _ = ParseRecord(raw)
	})
}

func FuzzEvaluateRanges(f *testing.F) {
	f.Add("v1.5.0", "1.0.0", "2.0.0")
	f.Add("v2.0.0-20250101000000-abcdefabcdef", "2.0.0-0", "2.1.0")
	f.Fuzz(func(t *testing.T, version, introduced, fixed string) {
		_, _ = evaluateRanges([]Range{{Type: "SEMVER", Events: []Event{{Introduced: introduced}, {Fixed: fixed}}}}, version)
	})
}

func BenchmarkEvaluateScalar(b *testing.B)  { benchmarkEvaluate(b, false) }
func BenchmarkEvaluateIndexed(b *testing.B) { benchmarkEvaluate(b, true) }

func benchmarkEvaluate(b *testing.B, indexed bool) {
	release, _ := fixtureReleaseForBenchmark(b)
	input := fixtureInput([]ModuleVersion{{Path: "golang.org/x/text", Version: "v0.3.2"}}, "go1.11.0", []string{"golang.org/x/text/transform", "crypto/x509"}, "linux", "amd64")
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		_ = release.Evaluate(input, fixtureTime, indexed)
	}
}

func fixtureRelease(t testing.TB, records [][]byte) (Release, ed25519.PublicKey) {
	t.Helper()
	options, publicKey := fixtureOptions()
	archive, _, err := BuildArchive(records, options)
	if err != nil {
		t.Fatalf("build fixture release: %v", err)
	}
	release, err := LoadArchive(archive, publicKey)
	if err != nil {
		t.Fatalf("load fixture release: %v", err)
	}
	return release, publicKey
}

func fixtureReleaseForBenchmark(b *testing.B) (Release, ed25519.PublicKey) {
	b.Helper()
	return fixtureRelease(b, officialRecordsForBenchmark(b))
}

func fixtureOptions() (BuildOptions, ed25519.PublicKey) {
	seed := bytes.Repeat([]byte{7}, ed25519.SeedSize)
	key := ed25519.NewKeyFromSeed(seed)
	return BuildOptions{
		SourceURL: "https://vuln.go.dev/vulndb.zip", DatabaseModified: fixtureTime,
		FetchedAt: fixtureTime, IndexBuilderRevision: "test-revision", StaleAfter: 7 * 24 * time.Hour,
		SigningKey: key, KeyID: "test-key",
	}, key.Public().(ed25519.PublicKey)
}

func officialRecords(t testing.TB) [][]byte {
	t.Helper()
	directory := filepath.Join("testdata", "official-go-vulndb-2024-05-20")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	var records [][]byte
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, raw)
	}
	sort.Slice(records, func(i, j int) bool {
		var left, right struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(records[i], &left)
		_ = json.Unmarshal(records[j], &right)
		return left.ID < right.ID
	})
	return records
}

func officialRecordsForFuzz() [][]byte {
	return [][]byte{[]byte(`{"schema_version":"1.3.1","id":"GO-2024-0001","modified":"2024-01-01T00:00:00Z","affected":[{"package":{"ecosystem":"Go","name":"example.com/mod"}}],"database_specific":{"url":"https://pkg.go.dev/vuln/GO-2024-0001"}}`)}
}

func officialRecordsForBenchmark(b *testing.B) [][]byte {
	b.Helper()
	return officialRecords(b)
}

func fixtureInput(modules []ModuleVersion, toolchain string, imports []string, goos, goarch string) EvaluationInput {
	return EvaluationInput{Modules: modules, ToolchainVersion: toolchain, ImportPaths: imports, BuildProfile: BuildProfile{GOOS: goos, GOARCH: goarch}}
}

func findingByID(t *testing.T, findings []Finding, id string) Finding {
	t.Helper()
	for _, finding := range findings {
		if finding.ID == id {
			return finding
		}
	}
	t.Fatalf("finding %q not present: %#v", id, findings)
	return Finding{}
}

func recordByID(t testing.TB, records [][]byte, id string) []byte {
	t.Helper()
	for _, raw := range records {
		var record struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &record); err != nil {
			t.Fatal(err)
		}
		if record.ID == id {
			return raw
		}
	}
	t.Fatalf("record %q not present", id)
	return nil
}

func importPaths(imports []AffectedImport) []string {
	paths := make([]string, 0, len(imports))
	for _, item := range imports {
		paths = append(paths, item.Path)
	}
	return paths
}

func assertUnknownCode(t *testing.T, evaluation Evaluation, code string) {
	t.Helper()
	if evaluation.Status != contract.VersionUnknown || len(evaluation.Diagnostics) == 0 || evaluation.Diagnostics[0].Code != code {
		t.Fatalf("evaluation = %#v, want unknown with %q", evaluation, code)
	}
}

func errorCode(err error) string {
	if typed, ok := err.(*DataError); ok {
		return typed.Code
	}
	return ""
}
