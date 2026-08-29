package analysisbundle

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	schemaVersion            = "v1"
	assuranceProjectEvidence = "project-evidence"
	captureKindNativeGoList  = "native-go-list"
	manifestPath             = "manifest.json"
	maxBundleFileCount       = 10_000
	maxContentFileBytes      = 64 * 1024 * 1024
	maxBundleArchiveBytes    = 64 * 1024 * 1024
)

var zeroDigestPlaceholder = "sha256:" + strings.Repeat("0", 64)

var supportedCGOPolicies = map[string]struct{}{
	"disabled": {},
	"enabled":  {},
}

type goModule struct {
	Path    string `json:"Path"`
	Version string `json:"Version"`
	Sum     string `json:"Sum"`
	Main    bool   `json:"Main"`
}

type goPackageModule struct {
	Path    string `json:"Path"`
	Version string `json:"Version"`
}

type goPackage struct {
	ImportPath string           `json:"ImportPath"`
	GoFiles    []string         `json:"GoFiles"`
	CgoFiles   []string         `json:"CgoFiles"`
	Imports    []string         `json:"Imports"`
	Dir        string           `json:"Dir"`
	Module     *goPackageModule `json:"Module"`
}

type BuildProfile struct {
	Goos      string   `json:"goos"`
	Goarch    string   `json:"goarch"`
	BuildTags []string `json:"build_tags"`
	CGOPolicy string   `json:"cgo_policy"`
}

type Producer struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	GoVersion string `json:"go_version"`
}

type ModuleRef struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Sum     string `json:"sum"`
}

type ContentEntry struct {
	Path                 string `json:"path"`
	Digest               string `json:"digest"`
	Size                 int    `json:"size"`
	LengthPrefixedDigest string `json:"length_prefixed_digest"`
}

type PackageInventoryEntry struct {
	Path          string   `json:"path"`
	ModulePath    string   `json:"module_path"`
	ModuleVersion string   `json:"module_version"`
	Files         []string `json:"files"`
	Imports       []string `json:"imports"`
}

type Diagnostic struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type AnalysisBundleManifest struct {
	SchemaVersion    string                  `json:"schema_version"`
	Assurance        string                  `json:"assurance"`
	CaptureKind      string                  `json:"capture_kind"`
	GeneratedAt      string                  `json:"generated_at"`
	Producer         Producer                `json:"producer"`
	BuildProfile     BuildProfile            `json:"build_profile"`
	Roots            []string                `json:"roots"`
	ModuleGraph      moduleGraphManifest     `json:"module_graph"`
	PackageInventory []PackageInventoryEntry `json:"package_inventory"`
	Diagnostics      []Diagnostic            `json:"diagnostics"`
	Content          []ContentEntry          `json:"content"`
	SourceDigest     string                  `json:"source_digest"`
	BundleDigest     string                  `json:"bundle_digest"`
}

type moduleGraphManifest struct {
	Main         string      `json:"main"`
	Requirements []ModuleRef `json:"requirements"`
}

type CaptureOptions struct {
	ModuleDir         string
	OutputPath        string
	Goos              string
	Goarch            string
	BuildTags         []string
	CGOPolicy         string
	ProducerID        string
	ProducerName      string
	ProducerVersion   string
	ProducerGoVersion string
	GeneratedAt       string
}

type capturedSourceFile struct {
	path   string
	digest string
	size   int
	data   []byte
}

// CaptureBundle captures a deterministic AnalysisBundle into OutputPath.
func CaptureBundle(ctx context.Context, options CaptureOptions) (AnalysisBundleManifest, error) {
	moduleRoot, err := filepath.Abs(options.ModuleDir)
	if err != nil || moduleRoot == "" {
		return AnalysisBundleManifest{}, fmt.Errorf("resolve module directory: %w", err)
	}

	if options.OutputPath == "" {
		return AnalysisBundleManifest{}, fmt.Errorf("output path is required")
	}

	buildProfile, err := buildProfileFromOptions(options)
	if err != nil {
		return AnalysisBundleManifest{}, err
	}
	generatedAt, err := normalizedGeneratedAt(options.GeneratedAt)
	if err != nil {
		return AnalysisBundleManifest{}, err
	}
	toolchainVersion, err := goToolchainVersion(ctx, moduleRoot, buildProfile.Goos, buildProfile.Goarch)
	if err != nil {
		return AnalysisBundleManifest{}, err
	}
	if options.ProducerGoVersion != "" && options.ProducerGoVersion != toolchainVersion {
		return AnalysisBundleManifest{}, fmt.Errorf("requested Go version %q does not match the Go toolchain used for capture %q", options.ProducerGoVersion, toolchainVersion)
	}

	modules, mainPath, mainVersion, err := captureModules(ctx, moduleRoot, buildProfile.Goos, buildProfile.Goarch)
	if err != nil {
		return AnalysisBundleManifest{}, err
	}

	packages, sourceFiles, err := capturePackages(ctx, moduleRoot, buildProfile.Goos, buildProfile.Goarch, buildProfile.CGOPolicy, mainPath, mainVersion, options.BuildTags)
	if err != nil {
		return AnalysisBundleManifest{}, err
	}

	if len(packages) == 0 {
		return AnalysisBundleManifest{}, fmt.Errorf("no module packages selected for capture")
	}

	rootPackages := packagePaths(packages)
	if len(rootPackages) == 0 {
		return AnalysisBundleManifest{}, fmt.Errorf("capture produced no root packages")
	}

	contentEntries, err := captureContentEntries(moduleRoot, sourceFiles)
	if err != nil {
		return AnalysisBundleManifest{}, err
	}

	sort.Strings(rootPackages)

	manifest := AnalysisBundleManifest{
		SchemaVersion: schemaVersion,
		Assurance:     assuranceProjectEvidence,
		CaptureKind:   captureKindNativeGoList,
		GeneratedAt:   generatedAt,
		Producer: Producer{
			ID:        firstNonEmpty(options.ProducerID, "vulncheck-bundle"),
			Name:      firstNonEmpty(options.ProducerName, "vulncheck companion"),
			Version:   firstNonEmpty(options.ProducerVersion, "dev"),
			GoVersion: toolchainVersion,
		},
		BuildProfile:     buildProfile,
		Roots:            rootPackages,
		ModuleGraph:      modules,
		PackageInventory: packages,
		Diagnostics:      make([]Diagnostic, 0),
		Content:          contentEntries,
		SourceDigest:     "",
	}

	manifest.SourceDigest = computeSourceDigest(contentEntries)
	manifest.BundleDigest = computeBundleDigest(manifest, zeroDigestPlaceholder)

	data, err := json.Marshal(manifest)
	if err != nil {
		return AnalysisBundleManifest{}, fmt.Errorf("encode manifest: %w", err)
	}
	if err := validateArchiveByteLimit(data, contentEntries); err != nil {
		return AnalysisBundleManifest{}, err
	}
	sourceContent := map[string][]byte{}
	for _, entry := range contentEntries {
		sourceContent[entry.Path] = sourceFiles[entry.Path].data
	}

	if err := writeBundle(options.OutputPath, manifest, sourceContent, data); err != nil {
		return AnalysisBundleManifest{}, err
	}

	return manifest, nil
}

func captureModules(ctx context.Context, moduleRoot, goos, goarch string) (moduleGraphManifest, string, string, error) {
	raw, err := runGoList(ctx, moduleRoot, goos, goarch, []string{"list", "-mod=readonly", "-m", "-json", "all"}, map[string]string{
		"CGO_ENABLED": "0",
	})
	if err != nil {
		return moduleGraphManifest{}, "", "", err
	}

	modules, err := decodeJSONObjects[goModule](raw)
	if err != nil {
		return moduleGraphManifest{}, "", "", err
	}
	if len(modules) == 0 {
		return moduleGraphManifest{}, "", "", fmt.Errorf("go list returned no modules")
	}

	var mainPath, mainVersion string
	requirements := make([]ModuleRef, 0, len(modules))
	for _, module := range modules {
		if module.Main {
			mainPath = module.Path
			mainVersion = module.Version
		}
	}
	if mainPath == "" {
		return moduleGraphManifest{}, "", "", fmt.Errorf("module list did not include a main module")
	}
	if mainVersion == "" {
		mainVersion = "devel"
	}

	for _, module := range modules {
		if module.Main {
			continue
		}
		if module.Path == "" || module.Version == "" || module.Sum == "" {
			return moduleGraphManifest{}, "", "", fmt.Errorf("invalid module requirement: %s@%s", module.Path, module.Version)
		}
		if !isValidModuleSum(module.Sum) {
			return moduleGraphManifest{}, "", "", fmt.Errorf("unsupported module sum format for %s", module.Path)
		}
		requirements = append(requirements, ModuleRef{
			Path:    module.Path,
			Version: module.Version,
			Sum:     module.Sum,
		})
	}

	if len(requirements) == 0 {
		requirements = make([]ModuleRef, 0)
	}

	if len(requirements) > maxBundleFileCount {
		return moduleGraphManifest{}, "", "", fmt.Errorf("module graph exceeds bundle file budget")
	}
	sort.Slice(requirements, func(i, j int) bool {
		left := fmt.Sprintf("%s@%s", requirements[i].Path, requirements[i].Version)
		right := fmt.Sprintf("%s@%s", requirements[j].Path, requirements[j].Version)
		return left < right
	})

	return moduleGraphManifest{
		Main:         mainPath,
		Requirements: requirements,
	}, mainPath, mainVersion, nil
}

func capturePackages(
	ctx context.Context,
	moduleRoot,
	goos,
	goarch string,
	cgo string,
	mainPath string,
	mainVersion string,
	buildTags []string,
) ([]PackageInventoryEntry, map[string]capturedSourceFile, error) {
	args := []string{"list", "-mod=readonly", "-deps", "-json", "./..."}
	if len(buildTags) > 0 {
		args = append([]string{"list", "-mod=readonly", "-deps", "-json", "-tags=" + strings.Join(buildTags, ",")}, "./...")
	}
	raw, err := runGoList(ctx, moduleRoot, goos, goarch, args, map[string]string{
		"CGO_ENABLED": cgoEnabledFromPolicy(cgo),
	})
	if err != nil {
		return nil, nil, err
	}
	pkgs, err := decodeJSONObjects[goPackage](raw)
	if err != nil {
		return nil, nil, err
	}

	seenPackages := map[string]struct{}{}
	inventories := make([]PackageInventoryEntry, 0, len(pkgs))
	contentFiles := map[string]capturedSourceFile{}
	for _, pkg := range pkgs {
		if pkg.Module == nil {
			continue
		}
		if pkg.Module.Path != mainPath {
			continue
		}
		if _, seen := seenPackages[pkg.ImportPath]; seen {
			continue
		}
		seenPackages[pkg.ImportPath] = struct{}{}

		moduleVersion := pkg.Module.Version
		if moduleVersion == "" {
			moduleVersion = mainVersion
		}

		files := uniqueSortedBundlePaths(pkg.GoFiles, pkg.CgoFiles)
		imports := uniqueSortedStrings(pkg.Imports)
		bundleFiles := make([]string, 0, len(files))

		for _, file := range files {
			bundlePath, err := addSourceFile(contentFiles, moduleRoot, pkg.Dir, file)
			if err != nil {
				return nil, nil, fmt.Errorf("capture package file %q: %w", file, err)
			}
			bundleFiles = append(bundleFiles, bundlePath)
		}

		inventories = append(inventories, PackageInventoryEntry{
			Path:          pkg.ImportPath,
			ModulePath:    pkg.Module.Path,
			ModuleVersion: moduleVersion,
			Files:         uniqueSortedStrings(bundleFiles),
			Imports:       imports,
		})
	}

	if len(inventories) > maxBundleFileCount {
		return nil, nil, fmt.Errorf("package inventory exceeds file budget")
	}
	sort.Slice(inventories, func(i, j int) bool {
		return inventories[i].Path < inventories[j].Path
	})

	for i := range inventories {
		sort.Strings(inventories[i].Files)
		sort.Strings(inventories[i].Imports)
	}
	return inventories, contentFiles, nil
}

func captureContentEntries(moduleRoot string, contentFiles map[string]capturedSourceFile) ([]ContentEntry, error) {
	entries := make([]ContentEntry, 0, len(contentFiles))
	for _, source := range contentFiles {
		if err := validateBundlePath(source.path, moduleRoot); err != nil {
			return nil, err
		}
		if source.size > maxContentFileBytes {
			return nil, fmt.Errorf("source file %q exceeds bundle byte limit", source.path)
		}
		entries = append(entries, ContentEntry{
			Path:                 source.path,
			Digest:               source.digest,
			Size:                 source.size,
			LengthPrefixedDigest: lengthPrefixedDigest(source.size, source.digest),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Path < entries[j].Path
	})

	if len(entries) > maxBundleFileCount {
		return nil, fmt.Errorf("bundle contains too many files")
	}
	return entries, nil
}

func computeBundleDigest(manifest AnalysisBundleManifest, bundleDigest string) string {
	payloadBytes, _ := marshalCanonicalJSON(bundleDigestValue(manifest, bundleDigest))
	sum := sha256.Sum256(payloadBytes)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func computeSourceDigest(content []ContentEntry) string {
	entries := make([]map[string]any, len(content))
	for i, file := range content {
		entries[i] = map[string]any{
			"digest":                 file.Digest,
			"length_prefixed_digest": lengthPrefixedDigest(file.Size, file.Digest),
			"path":                   file.Path,
			"size":                   file.Size,
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i]["path"].(string) < entries[j]["path"].(string)
	})

	payload, _ := marshalCanonicalJSON(entries)
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func writeBundle(outPath string, manifest AnalysisBundleManifest, content map[string][]byte, manifestBytes []byte) error {
	file, err := os.Create(outPath)
	if err != nil {
		return err
	}
	zipWriter := zip.NewWriter(file)
	defer func() {
		_ = zipWriter.Close()
		_ = file.Close()
	}()

	manifestHeader := &zip.FileHeader{
		Name:     manifestPath,
		Method:   zip.Store,
		Modified: zipEpoch,
	}
	if err := writeZipEntry(zipWriter, manifestHeader, manifestBytes); err != nil {
		return err
	}

	for _, entry := range manifest.Content {
		raw, found := content[entry.Path]
		if !found {
			return fmt.Errorf("manifest content file missing from capture map: %s", entry.Path)
		}
		header := &zip.FileHeader{
			Name:     entry.Path,
			Method:   zip.Store,
			Modified: zipEpoch,
		}
		if err := writeZipEntry(zipWriter, header, raw); err != nil {
			return err
		}
	}

	if err := zipWriter.Close(); err != nil {
		return err
	}
	return file.Close()
}

func writeZipEntry(writer *zip.Writer, header *zip.FileHeader, data []byte) error {
	header.CRC32 = crc32.ChecksumIEEE(data)
	header.CompressedSize64 = uint64(len(data))
	header.UncompressedSize64 = uint64(len(data))
	target, err := writer.CreateRaw(header)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, bytes.NewReader(data)); err != nil {
		return err
	}
	return nil
}

func validateArchiveByteLimit(manifest []byte, content []ContentEntry) error {
	// CreateRaw writes a local header and central-directory record for each
	// entry, plus the single end-of-central-directory record. All payloads are
	// stored, so this is the exact ZIP byte count before writing the output.
	size := int64(22 + 30 + 46 + 2*len(manifestPath) + len(manifest))
	for _, entry := range content {
		size += int64(30 + 46 + 2*len(entry.Path) + entry.Size)
		if size > maxBundleArchiveBytes {
			return fmt.Errorf("bundle archive exceeds byte limit")
		}
	}
	if size > maxBundleArchiveBytes {
		return fmt.Errorf("bundle archive exceeds byte limit")
	}
	return nil
}

func packagePaths(packages []PackageInventoryEntry) []string {
	paths := make([]string, 0, len(packages))
	for _, entry := range packages {
		paths = append(paths, entry.Path)
	}
	return paths
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func uniqueSortedBundlePaths(paths ...[]string) []string {
	all := make([]string, 0, 256)
	for _, fileSet := range paths {
		all = append(all, fileSet...)
	}
	return uniqueSortedStrings(all)
}

func runGoList(ctx context.Context, moduleRoot, goos, goarch string, args []string, env map[string]string) ([]byte, error) {
	output, err := runGoCommand(ctx, moduleRoot, goos, goarch, args, env)
	if err != nil {
		return nil, fmt.Errorf("go list failed: %w", err)
	}
	return output, nil
}

func goToolchainVersion(ctx context.Context, moduleRoot, goos, goarch string) (string, error) {
	raw, err := runGoCommand(ctx, moduleRoot, goos, goarch, []string{"env", "GOVERSION"}, nil)
	if err != nil {
		return "", fmt.Errorf("query Go toolchain version: %w", err)
	}
	version := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(version, "go") || len(version) < 4 {
		return "", fmt.Errorf("Go toolchain reported an invalid version %q", version)
	}
	return version, nil
}

func runGoCommand(ctx context.Context, moduleRoot, goos, goarch string, args []string, env map[string]string) ([]byte, error) {
	command := exec.CommandContext(ctx, "go", args...)
	command.Dir = moduleRoot

	overrides := map[string]string{
		"GOOS":        goos,
		"GOARCH":      goarch,
		"GO111MODULE": "on",
	}
	for key, value := range env {
		overrides[key] = value
	}
	command.Env = environmentWithOverrides(overrides)

	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%w: %s", err, string(output))
	}
	return output, nil
}

func environmentWithOverrides(overrides map[string]string) []string {
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	environment := make([]string, 0, len(os.Environ())+len(overrides))
	for _, value := range os.Environ() {
		key, _, found := strings.Cut(value, "=")
		if found {
			if _, overridden := overrides[key]; overridden {
				continue
			}
		}
		environment = append(environment, value)
	}
	for _, key := range keys {
		environment = append(environment, key+"="+overrides[key])
	}
	return environment
}

func decodeJSONObjects[T any](input []byte) ([]T, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	objects := []T{}
	for {
		var value T
		err := decoder.Decode(&value)
		if err == io.EOF {
			return objects, nil
		}
		if err != nil {
			return nil, err
		}
		objects = append(objects, value)
	}
}

func validateBundlePath(candidate, moduleRoot string) error {
	if strings.Contains(candidate, "\x00") || strings.Contains(candidate, "\\") || strings.HasPrefix(candidate, "/") {
		return fmt.Errorf("invalid bundle path: %q", candidate)
	}
	pathParts := strings.Split(candidate, "/")
	if len(pathParts) > 32 {
		return fmt.Errorf("bundle path depth too deep: %q", candidate)
	}
	for _, part := range pathParts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("bundle path contains traversal segment: %q", candidate)
		}
	}

	if filepath.IsAbs(candidate) {
		return fmt.Errorf("bundle path is absolute: %q", candidate)
	}
	joined := filepath.Join(moduleRoot, filepath.FromSlash(candidate))
	clean := filepath.Clean(joined)
	if rel, err := filepath.Rel(moduleRoot, clean); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("bundle path escapes module root: %q", candidate)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func normalizedGeneratedAt(value string) (string, error) {
	if value == "" {
		return time.Now().UTC().Format(time.RFC3339Nano), nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", fmt.Errorf("generated_at must be RFC3339: %w", err)
	}
	return parsed.UTC().Format(time.RFC3339Nano), nil
}

func isValidModuleSum(value string) bool {
	return strings.HasPrefix(value, "h1:") && len(value) >= 20
}

func addSourceFile(content map[string]capturedSourceFile, moduleRoot, packageDir, file string) (string, error) {
	absPath := file
	if !filepath.IsAbs(file) {
		absPath = filepath.Join(packageDir, file)
	}
	if _, err := os.Stat(absPath); err != nil {
		return "", err
	}
	relativePath, err := filepath.Rel(moduleRoot, absPath)
	if err != nil {
		return "", err
	}
	relativePath = filepath.ToSlash(relativePath)
	if err := validateBundlePath(relativePath, moduleRoot); err != nil {
		return "", err
	}
	if _, found := content[relativePath]; found {
		return relativePath, nil
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", err
	}
	size := len(data)
	sum := sha256.Sum256(data)
	content[relativePath] = capturedSourceFile{
		path:   relativePath,
		digest: "sha256:" + hex.EncodeToString(sum[:]),
		size:   size,
		data:   data,
	}
	return relativePath, nil
}

func buildProfileFromOptions(options CaptureOptions) (BuildProfile, error) {
	normalized := BuildProfile{
		Goos:      firstNonEmpty(options.Goos, runtime.GOOS),
		Goarch:    firstNonEmpty(options.Goarch, runtime.GOARCH),
		BuildTags: uniqueSortedStrings(options.BuildTags),
	}
	if len(normalized.BuildTags) > 128 {
		return BuildProfile{}, fmt.Errorf("build tags exceed bundle limit")
	}
	for _, tag := range normalized.BuildTags {
		if len(tag) > 128 || strings.ContainsAny(tag, " \t\r\n") {
			return BuildProfile{}, fmt.Errorf("invalid build tag %q", tag)
		}
	}

	cgo := firstNonEmpty(options.CGOPolicy, "disabled")
	switch cgo {
	case "1":
		cgo = "enabled"
	case "0":
		cgo = "disabled"
	case "":
		cgo = "disabled"
	}
	if cgo == "" {
		cgo = "disabled"
	}
	if _, found := supportedCGOPolicies[cgo]; !found {
		return BuildProfile{}, fmt.Errorf("unsupported cgo policy: %q", options.CGOPolicy)
	}
	normalized.CGOPolicy = cgo
	return normalized, nil
}

var zipEpoch = time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC)

func lengthPrefixedDigest(size int, digest string) string {
	return fmt.Sprintf("%d:%s", size, digest)
}

func marshalCanonicalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func bundleDigestValue(manifest AnalysisBundleManifest, bundleDigest string) map[string]any {
	requirements := make([]map[string]any, len(manifest.ModuleGraph.Requirements))
	for index, requirement := range manifest.ModuleGraph.Requirements {
		requirements[index] = map[string]any{
			"path":    requirement.Path,
			"sum":     requirement.Sum,
			"version": requirement.Version,
		}
	}
	packages := make([]map[string]any, len(manifest.PackageInventory))
	for index, pkg := range manifest.PackageInventory {
		packages[index] = map[string]any{
			"files":          pkg.Files,
			"imports":        pkg.Imports,
			"module_path":    pkg.ModulePath,
			"module_version": pkg.ModuleVersion,
			"path":           pkg.Path,
		}
	}
	diagnostics := make([]map[string]any, len(manifest.Diagnostics))
	for index, diagnostic := range manifest.Diagnostics {
		diagnostics[index] = map[string]any{
			"code":    diagnostic.Code,
			"message": diagnostic.Message,
		}
	}
	content := make([]map[string]any, len(manifest.Content))
	for index, entry := range manifest.Content {
		content[index] = map[string]any{
			"digest":                 entry.Digest,
			"length_prefixed_digest": lengthPrefixedDigest(entry.Size, entry.Digest),
			"path":                   entry.Path,
			"size":                   entry.Size,
		}
	}
	return map[string]any{
		"assurance": manifest.Assurance,
		"build_profile": map[string]any{
			"build_tags": manifest.BuildProfile.BuildTags,
			"cgo_policy": manifest.BuildProfile.CGOPolicy,
			"goarch":     manifest.BuildProfile.Goarch,
			"goos":       manifest.BuildProfile.Goos,
		},
		"bundle_digest": bundleDigest,
		"capture_kind":  manifest.CaptureKind,
		"content":       content,
		"diagnostics":   diagnostics,
		"generated_at":  manifest.GeneratedAt,
		"module_graph": map[string]any{
			"main":         manifest.ModuleGraph.Main,
			"requirements": requirements,
		},
		"package_inventory": packages,
		"producer": map[string]any{
			"go_version": manifest.Producer.GoVersion,
			"id":         manifest.Producer.ID,
			"name":       manifest.Producer.Name,
			"version":    manifest.Producer.Version,
		},
		"roots":          manifest.Roots,
		"schema_version": manifest.SchemaVersion,
		"source_digest":  manifest.SourceDigest,
	}
}

func cgoEnabledFromPolicy(policy string) string {
	switch policy {
	case "enabled":
		return "1"
	case "disabled", "":
		return "0"
	default:
		return "0"
	}
}
