package contract

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestReportExamplesCoverEveryResultVocabulary(t *testing.T) {
	contents, err := os.ReadFile("testdata/report-examples-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var reports []Report
	if err := json.Unmarshal(contents, &reports); err != nil {
		t.Fatal(err)
	}
	versions := map[VersionStatus]bool{}
	reachability := map[ReachabilityStatus]bool{}
	rules := map[RuleStatus]bool{}
	integrity := map[IntegrityStatus]bool{}
	for _, report := range reports {
		if err := report.Validate(); err != nil {
			t.Fatalf("example report is invalid: %v", err)
		}
		versions[report.Version.Status] = true
		reachability[report.Reachability.Status] = true
		rules[report.Rules.Status] = true
		integrity[report.Integrity.Status] = true
	}
	for _, status := range []VersionStatus{VersionAffected, VersionNotAffected, VersionUnknown} {
		if !versions[status] {
			t.Errorf("missing version example for %q", status)
		}
	}
	for _, status := range []ReachabilityStatus{ReachabilityReachable, ReachabilityNoStaticPathFound, ReachabilityInconclusive} {
		if !reachability[status] {
			t.Errorf("missing reachability example for %q", status)
		}
	}
	for _, status := range []RuleStatus{RuleFinding, RuleSuppressedFinding, RuleNoFinding, RuleNotAnalyzed} {
		if !rules[status] {
			t.Errorf("missing rule example for %q", status)
		}
	}
	for _, status := range []IntegrityStatus{IntegrityVerified, IntegrityUnverified, IntegrityFailed} {
		if !integrity[status] {
			t.Errorf("missing integrity example for %q", status)
		}
	}
}

func TestReportRejectsImpossibleIntegrityAndReachability(t *testing.T) {
	report := validReport()
	report.Integrity = IntegrityResult{Status: IntegrityVerified, ArtifactChecksPassed: true}
	if err := report.Validate(); err == nil {
		t.Fatal("verified report without module checks was accepted")
	}
	report = validReport()
	report.Reachability = ReachabilityResult{Status: ReachabilityReachable}
	if err := report.Validate(); err == nil {
		t.Fatal("reachable report without a trace was accepted")
	}
}

func TestProhibitedDisplayLanguageSnapshot(t *testing.T) {
	contents, err := os.ReadFile("testdata/prohibited-display-labels.json")
	if err != nil {
		t.Fatal(err)
	}
	var labels []string
	if err := json.Unmarshal(contents, &labels); err != nil {
		t.Fatal(err)
	}
	for _, label := range labels {
		if err := ValidateDisplayText(label); err == nil {
			t.Errorf("prohibited label %q was accepted", label)
		}
	}
	if err := ValidateDisplayText("no-static-path-found"); err != nil {
		t.Fatalf("evidence label was rejected: %v", err)
	}
}

func validReport() Report {
	observed := time.Date(2026, time.August, 22, 0, 0, 0, 0, time.UTC)
	return Report{
		SchemaVersion: ReportSchemaV1,
		Assurance:     AssuranceProjectEvidence,
		GeneratedAt:   observed,
		Provenance: Provenance{
			GoToolchain:     Toolchain{Version: "go1.26.3", Digest: "sha256:toolchain"},
			BuildProfile:    BuildProfile{GOOS: "linux", GOARCH: "amd64", BuildTags: []string{}, CGOPolicy: "disabled"},
			Dependency:      DependencySource{Source: "local-bundle", Digest: "sha256:dependency"},
			VulnerabilityDB: VulnerabilityData{Revision: "2026-08-22", Digest: "sha256:osv"},
			AnalyzerRelease: DigestReference{Digest: "sha256:analyzer"},
		},
		Capabilities: CapabilityReport{
			SchemaVersion:    ReportSchemaV1,
			ObservedAt:       observed,
			SelectedProfile:  "baseline-worker",
			SelectedFallback: "in-memory-blob-storage",
			Features:         []CapabilityFeature{{Name: "dedicated-worker", Available: true, Detail: "available"}},
		},
		Version:      VersionResult{Status: VersionNotAffected},
		Reachability: ReachabilityResult{Status: ReachabilityInconclusive},
		Rules:        RuleResult{Status: RuleNoFinding},
		Integrity:    IntegrityResult{Status: IntegrityVerified, ArtifactChecksPassed: true, ModuleChecksPassed: true},
		Freshness:    FreshnessResult{Status: FreshnessCurrent},
	}
}
