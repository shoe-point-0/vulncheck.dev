import { assertNotCancelled, ingestionError } from "./ingestion-error.mjs";

// These are the browser representation of contract.DefaultResourceBudget.
// Callers may lower a value for one analysis, but never raise a v1 hard limit.
export const hardResourceBudget = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxFiles: 10_000,
  maxPathDepth: 32,
  maxNesting: 8,
  maxCpuTimeMs: 5_000,
  maxMemoryBytes: 128 * 1024 * 1024,
  maxWallTimeMs: 10_000,
  maxCompressionRatio: 100
});

export function resolveResourceBudget(lowerLimits = {}) {
  if (!lowerLimits || typeof lowerLimits !== "object" || Array.isArray(lowerLimits)) {
    throw ingestionError("resource-budget-invalid", "resource budget must be an object");
  }
  const budget = {};
  for (const [name, hardLimit] of Object.entries(hardResourceBudget)) {
    const value = lowerLimits[name] ?? hardLimit;
    if (!Number.isFinite(value) || value <= 0 || value > hardLimit) {
      throw ingestionError("resource-budget-invalid", "resource budget must be positive and no greater than the v1 hard limit");
    }
    budget[name] = value;
  }
  for (const name of Object.keys(lowerLimits)) {
    if (!(name in hardResourceBudget)) {
      throw ingestionError("resource-budget-invalid", "resource budget contains an unsupported limit");
    }
  }
  return Object.freeze(budget);
}

export function assertResourceBudget(metrics, budget = hardResourceBudget, boundary = "input", signal) {
  assertNotCancelled(signal);
  const resolved = resolveResourceBudget(budget);
  const values = {
    declaredBytes: 0,
    observedBytes: 0,
    compressedBytes: 0,
    files: 0,
    pathDepth: 0,
    nesting: 0,
    cpuTimeMs: 0,
    memoryBytes: 0,
    wallTimeMs: 0,
    ...metrics
  };
  for (const value of Object.values(values)) {
    if (!Number.isFinite(value) || value < 0) {
      throw ingestionError("input-metrics-invalid", "input metrics must be finite non-negative values");
    }
  }
  if (values.declaredBytes > resolved.maxBytes || values.observedBytes > resolved.maxBytes) {
    throw limitError(boundary, "byte limit exceeded");
  }
  if (values.files > resolved.maxFiles) throw limitError(boundary, "file-count limit exceeded");
  if (values.pathDepth > resolved.maxPathDepth) throw limitError(boundary, "path-depth limit exceeded");
  if (values.nesting > resolved.maxNesting) throw limitError(boundary, "nesting limit exceeded");
  if (values.cpuTimeMs > resolved.maxCpuTimeMs) throw limitError(boundary, "cpu-time limit exceeded");
  if (values.memoryBytes > resolved.maxMemoryBytes) throw limitError(boundary, "memory limit exceeded");
  if (values.wallTimeMs > resolved.maxWallTimeMs) throw limitError(boundary, "wall-time limit exceeded");
  if (values.observedBytes > 0 && values.compressedBytes === 0) {
    throw ingestionError("input-compression-invalid", "compressed input bytes are required when observed bytes are present");
  }
  if (values.compressedBytes > 0 && values.observedBytes / values.compressedBytes > resolved.maxCompressionRatio) {
    throw limitError(boundary, "compression-ratio limit exceeded");
  }
  return resolved;
}

function limitError(boundary, message) {
  return ingestionError(`${boundary}-limit`, message);
}
