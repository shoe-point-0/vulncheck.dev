import assert from "node:assert/strict";
import test from "node:test";

import { detectCapabilities, profile } from "./capabilities.mjs";

const observedAt = "2026-08-22T00:00:00.000Z";

function runtime(overrides = {}) {
  return {
    Worker: class Worker {},
    ArrayBuffer,
    navigator: { storage: {} },
    crossOriginIsolated: false,
    ...overrides
  };
}

test("uses the required transferable-worker baseline", () => {
  const report = detectCapabilities(runtime(), observedAt);
  assert.equal(report.selected_profile, profile.baseline);
  assert.equal(report.selected_fallback, "in-memory-blob-storage");
  assert.equal(report.features.find((feature) => feature.name === "origin-private-file-system").available, false);
});

test("uses optional enhanced profiles only when they are detected", () => {
  const enhanced = detectCapabilities(runtime({ navigator: { storage: { getDirectory() {} } } }), observedAt);
  assert.equal(enhanced.selected_profile, profile.enhancedStorage);
  assert.equal(enhanced.selected_fallback, profile.baseline);

  const isolated = detectCapabilities(runtime({
    navigator: { storage: { getDirectory() {} } },
    crossOriginIsolated: true,
    SharedArrayBuffer
  }), observedAt);
  assert.equal(isolated.selected_profile, profile.isolatedParallel);
  assert.equal(isolated.selected_fallback, profile.enhancedStorage);
});

test("records an explicit unavailable fallback when the baseline is absent", () => {
  const report = detectCapabilities(runtime({ Worker: undefined }), observedAt);
  assert.equal(report.selected_profile, profile.unavailable);
  assert.equal(report.selected_fallback, "analysis-unavailable");
  assert.equal(report.schema_version, "v1");
  assert.equal(report.observed_at, observedAt);
});
