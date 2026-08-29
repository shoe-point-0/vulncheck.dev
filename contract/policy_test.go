package contract

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestThreatModelFixturesFailClosed(t *testing.T) {
	budget := DefaultResourceBudget()

	t.Run("zip bomb", func(t *testing.T) {
		err := budget.Check(context.Background(), BoundaryModuleArchive, InputMetrics{ObservedBytes: 32 << 20, CompressedBytes: 1 << 10})
		assertPolicyCode(t, err, "module-archive-limit")
	})
	t.Run("path traversal", func(t *testing.T) {
		assertPolicyCode(t, ValidateRelativePath("../private/go.mod", budget.MaxPathDepth), "path-traversal")
	})
	t.Run("malformed source", func(t *testing.T) {
		assertPolicyCode(t, ValidateSourceText([]byte{0xff}, budget.MaxBytes), "source-malformed")
	})
	t.Run("cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		assertPolicyCode(t, budget.Check(ctx, BoundarySourceFile, InputMetrics{}), "input-cancelled")
	})
	t.Run("stale data", func(t *testing.T) {
		policy := FreshnessPolicy{MaxAge: time.Hour}
		got := policy.Evaluate(time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC), time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC))
		if got != FreshnessStale {
			t.Fatalf("freshness = %q, want stale", got)
		}
	})
	t.Run("unverified assets", func(t *testing.T) {
		assertError(t, IntegrityResult{Status: IntegrityVerified, ArtifactChecksPassed: true}.Validate())
	})
	t.Run("offline egress", func(t *testing.T) {
		assertPolicyCode(t, AcquisitionPolicy{Offline: true, SelectedEndpoint: "https://proxy.golang.org"}.Authorize("https://proxy.golang.org"), "offline-egress")
	})
}

func TestAcquisitionPolicyUsesOnlyTheSelectedEndpoint(t *testing.T) {
	policy := AcquisitionPolicy{SelectedEndpoint: "https://proxy.golang.org"}
	if err := policy.Authorize("https://proxy.golang.org"); err != nil {
		t.Fatalf("selected endpoint rejected: %v", err)
	}
	assertPolicyCode(t, policy.Authorize("https://example.invalid"), "endpoint-not-selected")
}

func FuzzInputBoundaryValidation(f *testing.F) {
	f.Add("go.mod", []byte("module example.com/fuzz\n"))
	f.Add("../private", []byte{0xff})
	f.Fuzz(func(t *testing.T, inputPath string, source []byte) {
		budget := DefaultResourceBudget()
		_ = ValidateRelativePath(inputPath, budget.MaxPathDepth)
		_ = ValidateSourceText(source, budget.MaxBytes)
		observed := int64(len(source))
		metrics := InputMetrics{ObservedBytes: observed, CompressedBytes: observed}
		_ = budget.Check(context.Background(), BoundaryBrowserMessage, metrics)
	})
}

func assertPolicyCode(t *testing.T, err error, want string) {
	t.Helper()
	var policyErr *PolicyError
	if !errors.As(err, &policyErr) {
		t.Fatalf("error = %v, want policy error %q", err, want)
	}
	if policyErr.Code != want {
		t.Fatalf("policy code = %q, want %q", policyErr.Code, want)
	}
}

func assertError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
}
