package vulndb

import (
	"sort"
	"strings"

	"vulncheck.dev/internal/analysisbundle"
)

// InputFromAnalysisBundle extracts the immutable, version-relevant subset of
// a validated Project Evidence bundle. It deliberately does not retain source
// paths, files, browser storage handles, or any other execution state.
func InputFromAnalysisBundle(manifest analysisbundle.AnalysisBundleManifest) (EvaluationInput, error) {
	if manifest.Assurance != "project-evidence" || manifest.CaptureKind != "native-go-list" {
		return EvaluationInput{}, dataError("vulndb-snapshot-invalid", "vulnerability evaluation requires a native Project Evidence bundle")
	}

	modules := make([]ModuleVersion, 0, len(manifest.ModuleGraph.Requirements))
	seenModules := make(map[string]struct{}, len(manifest.ModuleGraph.Requirements))
	for _, module := range manifest.ModuleGraph.Requirements {
		if strings.TrimSpace(module.Path) == "" || strings.TrimSpace(module.Version) == "" {
			return EvaluationInput{}, dataError("vulndb-snapshot-invalid", "analysis bundle contains an incomplete module requirement")
		}
		if _, duplicate := seenModules[module.Path]; duplicate {
			return EvaluationInput{}, dataError("vulndb-snapshot-invalid", "analysis bundle contains duplicate module requirements")
		}
		seenModules[module.Path] = struct{}{}
		modules = append(modules, ModuleVersion{Path: module.Path, Version: module.Version})
	}
	sort.Slice(modules, func(i, j int) bool { return modules[i].Path < modules[j].Path })

	imports := make(map[string]struct{}, len(manifest.PackageInventory))
	for _, pkg := range manifest.PackageInventory {
		if strings.TrimSpace(pkg.Path) != "" {
			imports[pkg.Path] = struct{}{}
		}
		for _, imported := range pkg.Imports {
			if strings.TrimSpace(imported) != "" {
				imports[imported] = struct{}{}
			}
		}
	}
	importPaths := make([]string, 0, len(imports))
	for path := range imports {
		importPaths = append(importPaths, path)
	}
	sort.Strings(importPaths)

	input := EvaluationInput{
		Modules:          modules,
		ToolchainVersion: manifest.Producer.GoVersion,
		ImportPaths:      importPaths,
		BuildProfile: BuildProfile{
			GOOS:   manifest.BuildProfile.Goos,
			GOARCH: manifest.BuildProfile.Goarch,
		},
	}
	if err := validateInput(input); err != nil {
		return EvaluationInput{}, err
	}
	return input, nil
}
