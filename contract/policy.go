package contract

import (
	"context"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"
)

// InputBoundary names a hostile-input boundary. New adapters must select one
// before parsing or retaining bytes.
type InputBoundary string

const (
	BoundaryModuleArchive  InputBoundary = "module-archive"
	BoundaryAnalysisBundle InputBoundary = "analysis-bundle"
	BoundarySourceFile     InputBoundary = "source-file"
	BoundaryOSVRecord      InputBoundary = "osv-record"
	BoundaryPermalink      InputBoundary = "permalink-state"
	BoundaryCachedData     InputBoundary = "cached-data"
	BoundaryBrowserMessage InputBoundary = "browser-message"
)

// ResourceBudget is a non-negotiable ceiling. Product settings may lower, but
// never raise, these values without a new contract version and review.
type ResourceBudget struct {
	MaxBytes            int64
	MaxFiles            int
	MaxPathDepth        int
	MaxNesting          int
	MaxCPUTime          time.Duration
	MaxMemoryBytes      int64
	MaxWallTime         time.Duration
	MaxCompressionRatio float64
}

// DefaultResourceBudget is intentionally conservative until task-specific
// measurement can justify a tighter supported input profile.
func DefaultResourceBudget() ResourceBudget {
	return ResourceBudget{
		MaxBytes:            64 << 20,
		MaxFiles:            10_000,
		MaxPathDepth:        32,
		MaxNesting:          8,
		MaxCPUTime:          5 * time.Second,
		MaxMemoryBytes:      128 << 20,
		MaxWallTime:         10 * time.Second,
		MaxCompressionRatio: 100,
	}
}

// InputMetrics must be populated from declared and observed input facts. A
// parser must check it before and while it reads hostile bytes.
type InputMetrics struct {
	DeclaredBytes   int64
	ObservedBytes   int64
	CompressedBytes int64
	Files           int
	PathDepth       int
	Nesting         int
	CPUTime         time.Duration
	MemoryBytes     int64
	WallTime        time.Duration
}

// PolicyError has a stable code suitable for an inconclusive diagnostic.
type PolicyError struct {
	Code string
	Text string
}

func (e *PolicyError) Error() string { return e.Text }

// Check rejects a limit violation or cancellation. The boundary is retained in
// the error code so adapters can report the failure without exposing input.
func (b ResourceBudget) Check(ctx context.Context, boundary InputBoundary, m InputMetrics) error {
	if err := ctx.Err(); err != nil {
		return &PolicyError{Code: "input-cancelled", Text: "input processing cancelled"}
	}
	if err := b.validate(); err != nil {
		return err
	}
	if boundary == "" {
		return &PolicyError{Code: "input-boundary-missing", Text: "input boundary is required"}
	}
	if m.DeclaredBytes < 0 || m.ObservedBytes < 0 || m.CompressedBytes < 0 || m.Files < 0 || m.PathDepth < 0 || m.Nesting < 0 || m.CPUTime < 0 || m.MemoryBytes < 0 || m.WallTime < 0 {
		return &PolicyError{Code: "input-metrics-invalid", Text: "input metrics must not be negative"}
	}
	if m.DeclaredBytes > b.MaxBytes || m.ObservedBytes > b.MaxBytes {
		return limitError(boundary, "byte limit exceeded")
	}
	if m.Files > b.MaxFiles {
		return limitError(boundary, "file-count limit exceeded")
	}
	if m.PathDepth > b.MaxPathDepth {
		return limitError(boundary, "path-depth limit exceeded")
	}
	if m.Nesting > b.MaxNesting {
		return limitError(boundary, "nesting limit exceeded")
	}
	if m.CPUTime > b.MaxCPUTime {
		return limitError(boundary, "cpu-time limit exceeded")
	}
	if m.MemoryBytes > b.MaxMemoryBytes {
		return limitError(boundary, "memory limit exceeded")
	}
	if m.WallTime > b.MaxWallTime {
		return limitError(boundary, "wall-time limit exceeded")
	}
	if m.ObservedBytes > 0 && m.CompressedBytes == 0 {
		return &PolicyError{Code: "input-compression-invalid", Text: "compressed input bytes are required when observed bytes are present"}
	}
	if m.CompressedBytes > 0 && float64(m.ObservedBytes)/float64(m.CompressedBytes) > b.MaxCompressionRatio {
		return limitError(boundary, "compression-ratio limit exceeded")
	}
	return nil
}

func (b ResourceBudget) validate() error {
	if b.MaxBytes <= 0 || b.MaxFiles <= 0 || b.MaxPathDepth <= 0 || b.MaxNesting <= 0 || b.MaxCPUTime <= 0 || b.MaxMemoryBytes <= 0 || b.MaxWallTime <= 0 || b.MaxCompressionRatio <= 0 {
		return &PolicyError{Code: "resource-budget-invalid", Text: "resource budget values must be positive"}
	}
	return nil
}

func limitError(boundary InputBoundary, text string) error {
	return &PolicyError{Code: string(boundary) + "-limit", Text: text}
}

// ValidateRelativePath rejects paths that could escape an archive or bundle
// namespace. It accepts slash-separated, non-empty relative identifiers only.
func ValidateRelativePath(value string, maxDepth int) error {
	if maxDepth <= 0 {
		return &PolicyError{Code: "path-depth-invalid", Text: "path depth limit must be positive"}
	}
	if value == "" || strings.ContainsRune(value, '\x00') || strings.Contains(value, "\\") || strings.HasPrefix(value, "/") {
		return &PolicyError{Code: "path-invalid", Text: "path must be a non-empty relative slash-separated identifier"}
	}
	if path.Clean(value) != value {
		return &PolicyError{Code: "path-traversal", Text: "path must not contain traversal or redundant segments"}
	}
	segments := strings.Split(value, "/")
	if len(segments) > maxDepth {
		return &PolicyError{Code: "path-depth", Text: "path exceeds the configured depth"}
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return &PolicyError{Code: "path-traversal", Text: "path must not contain traversal segments"}
		}
	}
	return nil
}

// ValidateSourceText performs only boundary validation; parsing belongs to a
// later adapter and must use ResourceBudget before inspecting syntax.
func ValidateSourceText(value []byte, maxBytes int64) error {
	if int64(len(value)) > maxBytes {
		return &PolicyError{Code: "source-file-limit", Text: "source exceeds the configured byte limit"}
	}
	if !utf8.Valid(value) {
		return &PolicyError{Code: "source-malformed", Text: "source is not valid utf-8"}
	}
	return nil
}

type FreshnessPolicy struct {
	MaxAge time.Duration
}

// EvaluateFreshness never upgrades missing or stale data to a current state.
func (p FreshnessPolicy) Evaluate(now, observed time.Time) FreshnessStatus {
	if p.MaxAge <= 0 || observed.IsZero() || now.IsZero() {
		return FreshnessUnknown
	}
	if observed.After(now) || now.Sub(observed) > p.MaxAge {
		return FreshnessStale
	}
	return FreshnessCurrent
}

// AcquisitionPolicy binds a single analysis to its disclosed endpoint. It has
// no fallback endpoint and disables all acquisition in offline mode.
type AcquisitionPolicy struct {
	Offline          bool
	SelectedEndpoint string
}

func (p AcquisitionPolicy) Authorize(endpoint string) error {
	if p.Offline {
		return &PolicyError{Code: "offline-egress", Text: "network acquisition is disabled in offline mode"}
	}
	if err := validateEndpoint(p.SelectedEndpoint); err != nil {
		return err
	}
	if endpoint != p.SelectedEndpoint {
		return &PolicyError{Code: "endpoint-not-selected", Text: "endpoint was not selected for this analysis"}
	}
	return nil
}

func validateEndpoint(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return &PolicyError{Code: "endpoint-invalid", Text: "selected endpoint must be an absolute https url without credentials, query, or fragment"}
	}
	return nil
}

// ValidateDisplayText rejects labels that convert bounded static evidence into
// a certification claim. It applies to user-visible status labels only.
func ValidateDisplayText(value string) error {
	prohibited := map[string]struct{}{
		"safe":       {},
		"guaranteed": {},
		"certified":  {},
		"remediated": {},
	}
	for _, token := range strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
		return r < 'a' || r > 'z'
	}) {
		if _, found := prohibited[token]; found {
			return &PolicyError{Code: "prohibited-display-language", Text: fmt.Sprintf("display text contains prohibited claim %q", token)}
		}
	}
	return nil
}
