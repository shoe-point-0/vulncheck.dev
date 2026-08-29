// Package contract defines the versioned evidence vocabulary shared by every
// vulncheck.dev producer and renderer. It intentionally has no I/O or runtime
// dependencies so adapters cannot bypass the report boundary.
package contract

import (
	"fmt"
	"strings"
	"time"
)

const ReportSchemaV1 = "v1"

const (
	maxCapabilityFeatures = 32
	maxTraceSteps         = 1_024
	maxDiagnostics        = 1_024
)

// AssuranceLevel identifies what evidence source was available for a report.
type AssuranceLevel string

const (
	AssuranceModuleView      AssuranceLevel = "module-view"
	AssuranceProjectEvidence AssuranceLevel = "project-evidence"
)

// VersionStatus is the outcome of canonical vulnerability version evaluation.
type VersionStatus string

const (
	VersionAffected    VersionStatus = "affected"
	VersionNotAffected VersionStatus = "not-affected"
	VersionUnknown     VersionStatus = "unknown"
)

// ReachabilityStatus is static evidence, not an execution or safety verdict.
type ReachabilityStatus string

const (
	ReachabilityReachable         ReachabilityStatus = "reachable"
	ReachabilityNoStaticPathFound ReachabilityStatus = "no-static-path-found"
	ReachabilityInconclusive      ReachabilityStatus = "inconclusive"
)

// RuleStatus is the outcome of a source-rule producer.
type RuleStatus string

const (
	RuleFinding           RuleStatus = "finding"
	RuleSuppressedFinding RuleStatus = "suppressed-finding"
	RuleNoFinding         RuleStatus = "no-finding"
	RuleNotAnalyzed       RuleStatus = "not-analyzed"
)

// IntegrityStatus reflects the declared artifact and module checks only.
type IntegrityStatus string

const (
	IntegrityVerified   IntegrityStatus = "verified"
	IntegrityUnverified IntegrityStatus = "unverified"
	IntegrityFailed     IntegrityStatus = "failed"
)

// FreshnessStatus lets consumers distinguish current, stale, and unavailable
// data without inferring a vulnerability result.
type FreshnessStatus string

const (
	FreshnessCurrent FreshnessStatus = "current"
	FreshnessStale   FreshnessStatus = "stale"
	FreshnessUnknown FreshnessStatus = "unknown"
)

// Report is the v1 normalized evidence envelope. All fields are deliberately
// bounded metadata or evidence identifiers; it never contains source content.
type Report struct {
	SchemaVersion string             `json:"schema_version"`
	Assurance     AssuranceLevel     `json:"assurance"`
	GeneratedAt   time.Time          `json:"generated_at"`
	Provenance    Provenance         `json:"provenance"`
	Capabilities  CapabilityReport   `json:"capability_report"`
	Version       VersionResult      `json:"version"`
	Reachability  ReachabilityResult `json:"reachability"`
	Rules         RuleResult         `json:"rules"`
	Integrity     IntegrityResult    `json:"integrity"`
	Freshness     FreshnessResult    `json:"freshness"`
	Diagnostics   []Diagnostic       `json:"diagnostics"`
}

// Provenance records the selected inputs and releases required to reproduce a
// result. "unknown" is permitted only as an explicit captured value.
type Provenance struct {
	GoToolchain     Toolchain         `json:"go_toolchain"`
	BuildProfile    BuildProfile      `json:"build_profile"`
	Dependency      DependencySource  `json:"dependency"`
	VulnerabilityDB VulnerabilityData `json:"vulnerability_database"`
	AnalyzerRelease DigestReference   `json:"analyzer_release"`
}

type Toolchain struct {
	Version string `json:"version"`
	Digest  string `json:"digest"`
}

type BuildProfile struct {
	GOOS      string   `json:"goos"`
	GOARCH    string   `json:"goarch"`
	BuildTags []string `json:"build_tags"`
	CGOPolicy string   `json:"cgo_policy"`
}

type DependencySource struct {
	Source string `json:"source"`
	Digest string `json:"digest"`
}

type VulnerabilityData struct {
	Revision string `json:"revision"`
	Digest   string `json:"digest"`
}

type DigestReference struct {
	Digest string `json:"digest"`
}

// CapabilityReport is supplied by the browser host for every analysis. Its
// selected fallback is required even when the preferred profile is available.
type CapabilityReport struct {
	SchemaVersion    string              `json:"schema_version"`
	ObservedAt       time.Time           `json:"observed_at"`
	SelectedProfile  string              `json:"selected_profile"`
	SelectedFallback string              `json:"selected_fallback"`
	Features         []CapabilityFeature `json:"features"`
}

type CapabilityFeature struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Detail    string `json:"detail"`
}

type VersionResult struct {
	Status VersionStatus `json:"status"`
}

type ReachabilityResult struct {
	Status ReachabilityStatus `json:"status"`
	Trace  []TraceStep        `json:"trace,omitempty"`
}

type TraceStep struct {
	Package string `json:"package"`
	Symbol  string `json:"symbol"`
}

type RuleResult struct {
	Status RuleStatus `json:"status"`
}

type IntegrityResult struct {
	Status               IntegrityStatus `json:"status"`
	ArtifactChecksPassed bool            `json:"artifact_checks_passed"`
	ModuleChecksPassed   bool            `json:"module_checks_passed"`
}

type FreshnessResult struct {
	Status FreshnessStatus `json:"status"`
}

type Diagnostic struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Validate rejects incomplete reports and impossible status combinations
// before a report crosses an adapter boundary.
func (r Report) Validate() error {
	if r.SchemaVersion != ReportSchemaV1 {
		return fmt.Errorf("unsupported report schema version %q", r.SchemaVersion)
	}
	if r.Assurance != AssuranceModuleView && r.Assurance != AssuranceProjectEvidence {
		return fmt.Errorf("unsupported assurance level %q", r.Assurance)
	}
	if r.GeneratedAt.IsZero() {
		return fmt.Errorf("report timestamp is required")
	}
	if err := r.Provenance.validate(); err != nil {
		return err
	}
	if err := r.Capabilities.Validate(); err != nil {
		return err
	}
	if !validVersionStatus(r.Version.Status) {
		return fmt.Errorf("unsupported version status %q", r.Version.Status)
	}
	if !validReachabilityStatus(r.Reachability.Status) {
		return fmt.Errorf("unsupported reachability status %q", r.Reachability.Status)
	}
	if len(r.Reachability.Trace) > maxTraceSteps {
		return fmt.Errorf("reachability trace exceeds the maximum step count")
	}
	if r.Reachability.Status == ReachabilityReachable && len(r.Reachability.Trace) == 0 {
		return fmt.Errorf("reachable status requires a reproducible trace")
	}
	if !validRuleStatus(r.Rules.Status) {
		return fmt.Errorf("unsupported rule status %q", r.Rules.Status)
	}
	if err := r.Integrity.Validate(); err != nil {
		return err
	}
	if !validFreshnessStatus(r.Freshness.Status) {
		return fmt.Errorf("unsupported freshness status %q", r.Freshness.Status)
	}
	if len(r.Diagnostics) > maxDiagnostics {
		return fmt.Errorf("diagnostics exceed the maximum count")
	}
	for _, diagnostic := range r.Diagnostics {
		if strings.TrimSpace(diagnostic.Code) == "" || strings.TrimSpace(diagnostic.Message) == "" {
			return fmt.Errorf("diagnostics require a code and message")
		}
	}
	return nil
}

func (p Provenance) validate() error {
	values := []struct {
		name  string
		value string
	}{
		{"go toolchain version", p.GoToolchain.Version},
		{"go toolchain digest", p.GoToolchain.Digest},
		{"goos", p.BuildProfile.GOOS},
		{"goarch", p.BuildProfile.GOARCH},
		{"cgo policy", p.BuildProfile.CGOPolicy},
		{"dependency source", p.Dependency.Source},
		{"dependency digest", p.Dependency.Digest},
		{"vulnerability database revision", p.VulnerabilityDB.Revision},
		{"vulnerability database digest", p.VulnerabilityDB.Digest},
		{"analyzer release digest", p.AnalyzerRelease.Digest},
	}
	for _, value := range values {
		if strings.TrimSpace(value.value) == "" {
			return fmt.Errorf("%s is required", value.name)
		}
		if len(value.value) > 2_048 {
			return fmt.Errorf("%s exceeds the maximum length", value.name)
		}
	}
	if len(p.BuildProfile.BuildTags) > 128 {
		return fmt.Errorf("build tags exceed the maximum count")
	}
	for _, tag := range p.BuildProfile.BuildTags {
		if strings.TrimSpace(tag) == "" || len(tag) > 128 {
			return fmt.Errorf("build tags must be non-empty and bounded")
		}
	}
	return nil
}

func (c CapabilityReport) Validate() error {
	if c.SchemaVersion != ReportSchemaV1 {
		return fmt.Errorf("unsupported capability schema version %q", c.SchemaVersion)
	}
	if c.ObservedAt.IsZero() {
		return fmt.Errorf("capability timestamp is required")
	}
	if strings.TrimSpace(c.SelectedProfile) == "" || strings.TrimSpace(c.SelectedFallback) == "" {
		return fmt.Errorf("capability profile and fallback are required")
	}
	if len(c.Features) == 0 || len(c.Features) > maxCapabilityFeatures {
		return fmt.Errorf("at least one capability feature is required")
	}
	seen := make(map[string]struct{}, len(c.Features))
	for _, feature := range c.Features {
		if strings.TrimSpace(feature.Name) == "" || strings.TrimSpace(feature.Detail) == "" {
			return fmt.Errorf("capability features require a name and detail")
		}
		if len(feature.Name) > 128 || len(feature.Detail) > 256 {
			return fmt.Errorf("capability features exceed the maximum length")
		}
		if _, duplicate := seen[feature.Name]; duplicate {
			return fmt.Errorf("duplicate capability feature %q", feature.Name)
		}
		seen[feature.Name] = struct{}{}
	}
	return nil
}

func (i IntegrityResult) Validate() error {
	if i.Status != IntegrityVerified && i.Status != IntegrityUnverified && i.Status != IntegrityFailed {
		return fmt.Errorf("unsupported integrity status %q", i.Status)
	}
	if i.Status == IntegrityVerified && (!i.ArtifactChecksPassed || !i.ModuleChecksPassed) {
		return fmt.Errorf("verified integrity requires artifact and module checks")
	}
	return nil
}

func validVersionStatus(status VersionStatus) bool {
	return status == VersionAffected || status == VersionNotAffected || status == VersionUnknown
}

func validReachabilityStatus(status ReachabilityStatus) bool {
	return status == ReachabilityReachable || status == ReachabilityNoStaticPathFound || status == ReachabilityInconclusive
}

func validRuleStatus(status RuleStatus) bool {
	return status == RuleFinding || status == RuleSuppressedFinding || status == RuleNoFinding || status == RuleNotAnalyzed
}

func validFreshnessStatus(status FreshnessStatus) bool {
	return status == FreshnessCurrent || status == FreshnessStale || status == FreshnessUnknown
}
