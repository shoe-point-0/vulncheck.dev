package vulndb

import "vulncheck.dev/contract"

// evaluateRecord makes a decision only from the preserved OSV record and the
// exact input. The compact index is no longer involved at this boundary.
func evaluateRecord(record Record, input EvaluationInput) Finding {
	finding := Finding{
		ID: record.ID, AdvisoryURL: record.DatabaseSpecific.URL, Status: contract.VersionNotAffected,
		Record: append([]byte(nil), record.Raw...), Input: cloneInput(input),
	}
	if record.DatabaseSpecific.ReviewStatus != "REVIEWED" {
		finding.Status = contract.VersionUnknown
		finding.Diagnostics = []Diagnostic{{Code: "vulndb-unreviewed", Message: "canonical vulnerability record has not been reviewed"}}
		return finding
	}

	matchedAny, unknown := false, false
	for _, affected := range record.Affected {
		version, applies := versionForPackage(affected.Package.Name, input)
		if !applies {
			continue
		}
		imports, importsApply := matchingImports(affected.EcosystemSpecific.Imports, input)
		if !importsApply {
			continue
		}
		matchedAny = true
		finding.MatchedImports = append(finding.MatchedImports, imports...)
		status, diagnostic := evaluateRanges(affected.Ranges, version)
		if diagnostic != nil {
			unknown = true
			finding.Diagnostics = append(finding.Diagnostics, *diagnostic)
			continue
		}
		if status == contract.VersionAffected {
			finding.Status = contract.VersionAffected
			return finding
		}
	}
	if unknown {
		finding.Status = contract.VersionUnknown
	} else if !matchedAny {
		finding.Status = contract.VersionNotAffected
	}
	return finding
}

func recordCouldApply(record Record, input EvaluationInput) bool {
	for _, affected := range record.Affected {
		if _, applies := versionForPackage(affected.Package.Name, input); applies {
			return true
		}
	}
	return false
}

func versionForPackage(name string, input EvaluationInput) (string, bool) {
	if name == "stdlib" || name == "toolchain" {
		version, valid := normalizeToolchainVersion(input.ToolchainVersion)
		return version, valid
	}
	for _, module := range input.Modules {
		if module.Path == name {
			return module.Version, true
		}
	}
	return "", false
}

func matchingImports(imports []AffectedImport, input EvaluationInput) ([]AffectedImport, bool) {
	if len(imports) == 0 {
		return nil, true
	}
	selected := map[string]struct{}{}
	for _, value := range input.ImportPaths {
		selected[value] = struct{}{}
	}
	matches := make([]AffectedImport, 0, len(imports))
	for _, item := range imports {
		if _, found := selected[item.Path]; !found || !platformMatches(item, input.BuildProfile) {
			continue
		}
		matches = append(matches, cloneAffectedImport(item))
	}
	return matches, len(matches) > 0
}

func platformMatches(item AffectedImport, profile BuildProfile) bool {
	return selectorMatches(item.GOOS, profile.GOOS) && selectorMatches(item.GOARCH, profile.GOARCH)
}

func selectorMatches(selectors []string, value string) bool {
	if len(selectors) == 0 {
		return true
	}
	for _, selector := range selectors {
		if selector == value {
			return true
		}
	}
	return false
}

func cloneAffectedImport(value AffectedImport) AffectedImport {
	value.Symbols = append([]string(nil), value.Symbols...)
	value.GOOS = append([]string(nil), value.GOOS...)
	value.GOARCH = append([]string(nil), value.GOARCH...)
	return value
}
