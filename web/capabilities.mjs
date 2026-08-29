export const capabilitySchemaVersion = "v1";

const profile = Object.freeze({
  baseline: "baseline-worker",
  enhancedStorage: "enhanced-storage",
  isolatedParallel: "isolated-parallel",
  unavailable: "unavailable"
});

// detectCapabilities has no side effects. The worker host calls it once per
// analysis and attaches its result unchanged to the normalized report.
export function detectCapabilities(runtime = globalThis, observedAt = new Date().toISOString()) {
  const worker = typeof runtime.Worker === "function";
  const transferable = typeof runtime.ArrayBuffer === "function";
  const opfs = typeof runtime.navigator?.storage?.getDirectory === "function";
  const isolated = runtime.crossOriginIsolated === true;
  const sharedMemory = typeof runtime.SharedArrayBuffer === "function";

  let selectedProfile = profile.unavailable;
  let selectedFallback = "analysis-unavailable";
  if (worker && transferable && isolated && sharedMemory) {
    selectedProfile = profile.isolatedParallel;
    selectedFallback = opfs ? profile.enhancedStorage : profile.baseline;
  } else if (worker && transferable && opfs) {
    selectedProfile = profile.enhancedStorage;
    selectedFallback = profile.baseline;
  } else if (worker && transferable) {
    selectedProfile = profile.baseline;
    selectedFallback = "in-memory-blob-storage";
  }

  return Object.freeze({
    schema_version: capabilitySchemaVersion,
    observed_at: observedAt,
    selected_profile: selectedProfile,
    selected_fallback: selectedFallback,
    features: Object.freeze([
      feature("dedicated-worker", worker),
      feature("transferable-array-buffer", transferable),
      feature("origin-private-file-system", opfs),
      feature("cross-origin-isolation", isolated),
      feature("shared-array-buffer", sharedMemory)
    ])
  });
}

function feature(name, available) {
  return Object.freeze({ name, available, detail: available ? "available" : "unavailable" });
}

export { profile };
