package vulndb

import (
	"sort"
	"strings"
	"time"

	"vulncheck.dev/contract"
)

// EvaluationInput is the plain-data subset of a ProjectSnapshot required for
// version evaluation. It deliberately has no filesystem, browser, or runtime
// handles. Import paths may contain both selected package paths and imports.
type EvaluationInput struct {
	Modules          []ModuleVersion
	ToolchainVersion string
	ImportPaths      []string
	BuildProfile     BuildProfile
}

type ModuleVersion struct {
	Path    string
	Version string
}

type BuildProfile struct {
	GOOS   string
	GOARCH string
}

type Evaluation struct {
	Status      contract.VersionStatus
	Freshness   contract.FreshnessStatus
	Findings    []Finding
	Diagnostics []Diagnostic
}

// Finding links the original canonical record and its exact evaluation input
// to a version outcome. Symbols are evidence only; call-graph reachability is
// a later analysis step and is never inferred here.
type Finding struct {
	ID             string
	AdvisoryURL    string
	Status         contract.VersionStatus
	Record         []byte
	Input          EvaluationInput
	MatchedImports []AffectedImport
	Diagnostics    []Diagnostic
}

type Diagnostic struct {
	Code    string
	Message string
}

// Evaluate uses the deterministic compact index when indexed is true. Both
// paths evaluate the same canonical records and produce identical reports.
func (r Release) Evaluate(input EvaluationInput, now time.Time, indexed bool) Evaluation {
	if err := validateInput(input); err != nil {
		return unknownEvaluation(contract.FreshnessUnknown, "vulndb-input-invalid", err.Error())
	}
	ids := r.candidateIDs(input, indexed)
	freshness := r.freshness(now)
	if freshness != contract.FreshnessCurrent {
		code, message := "vulndb-freshness-unknown", "offline vulnerability release freshness is unknown"
		if freshness == contract.FreshnessStale {
			code, message = "vulndb-stale", "offline vulnerability release is older than its declared policy"
		}
		return r.unknownCandidates(ids, input, freshness, code, message)
	}

	findings := make([]Finding, 0, len(ids))
	for _, id := range ids {
		findings = append(findings, evaluateRecord(r.records[id], input))
	}
	return summarize(findings, freshness)
}

// EvaluateArchive maps unavailable, corrupt, invalid-signature, or
// schema-incompatible data to a typed unknown outcome.
func EvaluateArchive(data []byte, publicKey []byte, input EvaluationInput, now time.Time, indexed bool) Evaluation {
	release, err := LoadArchive(data, publicKey)
	if err != nil {
		if typed, ok := err.(*DataError); ok {
			return unknownEvaluation(contract.FreshnessUnknown, typed.Code, typed.Text)
		}
		return UnavailableEvaluation()
	}
	return release.Evaluate(input, now, indexed)
}

func UnavailableEvaluation() Evaluation {
	return unknownEvaluation(contract.FreshnessUnknown, "vulndb-unavailable", "offline vulnerability release is unavailable")
}

func (r Release) candidateIDs(input EvaluationInput, indexed bool) []string {
	if !indexed {
		ids := make([]string, 0, len(r.records))
		for id, record := range r.records {
			if recordCouldApply(record, input) {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		return ids
	}
	paths := map[string]struct{}{}
	for _, module := range input.Modules {
		paths[module.Path] = struct{}{}
	}
	if input.ToolchainVersion != "" {
		paths["stdlib"] = struct{}{}
		paths["toolchain"] = struct{}{}
	}
	ids := map[string]struct{}{}
	for path := range paths {
		for _, id := range r.index[path] {
			ids[id] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	return ordered
}

func (r Release) freshness(now time.Time) contract.FreshnessStatus {
	return (contract.FreshnessPolicy{MaxAge: time.Duration(r.manifest.StaleAfterSeconds) * time.Second}).Evaluate(now, r.manifest.FetchedAt)
}

func (r Release) unknownCandidates(ids []string, input EvaluationInput, freshness contract.FreshnessStatus, code, message string) Evaluation {
	findings := make([]Finding, 0, len(ids))
	for _, id := range ids {
		record := r.records[id]
		findings = append(findings, Finding{
			ID: record.ID, AdvisoryURL: record.DatabaseSpecific.URL, Status: contract.VersionUnknown,
			Record: append([]byte(nil), record.Raw...), Input: cloneInput(input),
			Diagnostics: []Diagnostic{{Code: code, Message: message}},
		})
	}
	return Evaluation{Status: contract.VersionUnknown, Freshness: freshness, Findings: findings, Diagnostics: []Diagnostic{{Code: code, Message: message}}}
}

func summarize(findings []Finding, freshness contract.FreshnessStatus) Evaluation {
	status := contract.VersionNotAffected
	diagnostics := []Diagnostic{}
	for _, finding := range findings {
		diagnostics = append(diagnostics, finding.Diagnostics...)
		if finding.Status == contract.VersionAffected {
			status = contract.VersionAffected
		} else if finding.Status == contract.VersionUnknown && status != contract.VersionAffected {
			status = contract.VersionUnknown
		}
	}
	return Evaluation{Status: status, Freshness: freshness, Findings: findings, Diagnostics: diagnostics}
}

func unknownEvaluation(freshness contract.FreshnessStatus, code, message string) Evaluation {
	return Evaluation{Status: contract.VersionUnknown, Freshness: freshness, Diagnostics: []Diagnostic{{Code: code, Message: message}}}
}

func validateInput(input EvaluationInput) error {
	if strings.TrimSpace(input.BuildProfile.GOOS) == "" || strings.TrimSpace(input.BuildProfile.GOARCH) == "" {
		return dataError("vulndb-input-invalid", "vulnerability evaluation build profile is incomplete")
	}
	if len(input.Modules) > maxRecords || len(input.ImportPaths) > maxRecords {
		return dataError("vulndb-input-limit", "vulnerability evaluation input exceeds its limit")
	}
	for _, module := range input.Modules {
		if module.Path == "" || module.Version == "" {
			return dataError("vulndb-input-invalid", "vulnerability evaluation module is incomplete")
		}
	}
	return nil
}

func cloneInput(input EvaluationInput) EvaluationInput {
	input.Modules = append([]ModuleVersion(nil), input.Modules...)
	input.ImportPaths = append([]string(nil), input.ImportPaths...)
	return input
}
