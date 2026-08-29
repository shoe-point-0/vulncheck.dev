import { ingestionError } from "./ingestion-error.mjs";
import { hardResourceBudget } from "./resource-budget.mjs";

// Analysis jobs have their own limits because an accepted archive is not a
// license for unbounded worker CPU, report output, or package processing.
export const hardAnalysisJobBudget = Object.freeze({
  maxCpuTimeMs: hardResourceBudget.maxCpuTimeMs,
  maxMemoryBytes: hardResourceBudget.maxMemoryBytes,
  maxWallTimeMs: hardResourceBudget.maxWallTimeMs,
  maxPackages: hardResourceBudget.maxFiles,
  maxOutputBytes: 4 * 1024 * 1024,
  maxCancellationGraceMs: 250
});

export function resolveAnalysisJobBudget(lowerLimits = {}) {
  if (!lowerLimits || typeof lowerLimits !== "object" || Array.isArray(lowerLimits)) {
    throw ingestionError("analysis-job-budget-invalid", "analysis job budget must be an object");
  }
  const resolved = {};
  for (const [name, hardLimit] of Object.entries(hardAnalysisJobBudget)) {
    const value = lowerLimits[name] ?? hardLimit;
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimit) {
      throw ingestionError("analysis-job-budget-invalid", "analysis job budget must be a positive integer no greater than the hard limit");
    }
    resolved[name] = value;
  }
  for (const name of Object.keys(lowerLimits)) {
    if (!(name in hardAnalysisJobBudget)) {
      throw ingestionError("analysis-job-budget-invalid", "analysis job budget contains an unsupported limit");
    }
  }
  return Object.freeze(resolved);
}

// A hardware count is advisory. The current release intentionally admits one
// active worker until a published per-stage browser profile authorizes more.
export function planWorkerConcurrency(capabilityReport, runtime = globalThis) {
  const hint = Number.isSafeInteger(runtime.navigator?.hardwareConcurrency)
    ? Math.max(1, runtime.navigator.hardwareConcurrency)
    : 1;
  const isolated = capabilityReport?.selected_profile === "isolated-parallel";
  return Object.freeze({
    active_workers: 1,
    hardware_hint: hint,
    shared_memory_enabled: false,
    reason: isolated
      ? "parallel worker stages are disabled until isolated browser profiling is retained"
      : "baseline transferable-message transport requires one active worker"
  });
}
