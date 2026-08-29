import { ingestionError } from "./ingestion-error.mjs";

// AnalysisStorage is the sole persistence boundary used by ingestion. Concrete
// stores may retain an archive, but never receive decoded project data or a
// ProjectSnapshot.
export const analysisStorageMethods = Object.freeze(["put", "get", "purgeAnalysis", "purge", "close"]);

export function assertAnalysisStorage(storage) {
  if (!storage || typeof storage !== "object" || analysisStorageMethods.some((method) => typeof storage[method] !== "function")) {
    throw ingestionError("storage-adapter-invalid", "analysis storage adapter implements an unsupported contract");
  }
  return storage;
}

export function assertStorageKey(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000/\\]/.test(value)) {
    throw ingestionError("storage-key-invalid", `${label} must be a bounded logical identifier`);
  }
}

export function assertStorageBlob(value) {
  if (!value || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.slice !== "function") {
    throw ingestionError("storage-value-invalid", "storage value must be a Blob or File with a finite size");
  }
}
