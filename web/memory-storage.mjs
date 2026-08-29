import { assertNotCancelled, ingestionError } from "./ingestion-error.mjs";
import { hardResourceBudget } from "./resource-budget.mjs";
import { analysisStorageMethods, assertStorageBlob, assertStorageKey } from "./analysis-storage.mjs";

// AnalysisStorage is the narrow adapter contract used by the worker. An OPFS
// implementation can replace this adapter later without changing ingestion.
export { analysisStorageMethods };

export class MemoryAnalysisStorage {
  #entries = new Map();
  #quotaBytes;
  #usedBytes = 0;
  #closed = false;

  constructor({ quotaBytes = hardResourceBudget.maxMemoryBytes } = {}) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 || quotaBytes > hardResourceBudget.maxMemoryBytes) {
      throw ingestionError("storage-quota-invalid", "storage quota must be positive and within the v1 memory limit");
    }
    this.#quotaBytes = quotaBytes;
  }

  get usedBytes() {
    return this.#usedBytes;
  }

  get quotaBytes() {
    return this.#quotaBytes;
  }

  async put(analysisID, key, blob, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    assertStorageKey(analysisID, "analysis id");
    assertStorageKey(key, "storage key");
    assertStorageBlob(blob);

    const entryKey = `${analysisID}\u0000${key}`;
    const previous = this.#entries.get(entryKey);
    const nextUsedBytes = this.#usedBytes - (previous?.blob.size ?? 0) + blob.size;
    if (nextUsedBytes > this.#quotaBytes) {
      throw ingestionError("storage-quota-exceeded", "local analysis storage quota exceeded");
    }
    assertNotCancelled(signal);
    this.#entries.set(entryKey, Object.freeze({ analysisID, key, blob }));
    this.#usedBytes = nextUsedBytes;
  }

  async get(analysisID, key, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    assertStorageKey(analysisID, "analysis id");
    assertStorageKey(key, "storage key");
    return this.#entries.get(`${analysisID}\u0000${key}`)?.blob;
  }

  async purgeAnalysis(analysisID, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    assertStorageKey(analysisID, "analysis id");
    for (const [entryKey, entry] of this.#entries) {
      assertNotCancelled(signal);
      if (entry.analysisID === analysisID) {
        this.#entries.delete(entryKey);
        this.#usedBytes -= entry.blob.size;
      }
    }
  }

  async purge({ signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    this.#entries.clear();
    this.#usedBytes = 0;
  }

  async close() {
    if (this.#closed) return;
    this.#entries.clear();
    this.#usedBytes = 0;
    this.#closed = true;
  }

  #assertOpen() {
    if (this.#closed) {
      throw ingestionError("storage-closed", "local analysis storage is closed");
    }
  }
}
