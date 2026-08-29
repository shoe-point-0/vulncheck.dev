import { assertNotCancelled, ingestionError } from "./ingestion-error.mjs";
import { hardResourceBudget } from "./resource-budget.mjs";
import { assertStorageBlob, assertStorageKey } from "./analysis-storage.mjs";
import { MemoryAnalysisStorage } from "./memory-storage.mjs";

// The fixed root makes ownership explicit and lets purge remove only data
// created by this application. Each analysis remains a separate OPFS
// directory, never a caller-controlled path.
export const opfsStorageRootName = "vulncheck-analysis-v1";

export class OpfsAnalysisStorage {
  #rootDirectory;
  #root;
  #quotaBytes;
  #usedBytes = 0;
  #knownSizes = new Map();
  #usageLoaded = false;
  #closed = false;
  #writables = new Set();
  #operationTail = Promise.resolve();
  #closePromise;

  constructor({ rootDirectory, quotaBytes = hardResourceBudget.maxMemoryBytes } = {}) {
    if (!rootDirectory || typeof rootDirectory.getDirectoryHandle !== "function" || typeof rootDirectory.removeEntry !== "function") {
      throw ingestionError("opfs-root-invalid", "an origin-private file system root directory is required");
    }
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 || quotaBytes > hardResourceBudget.maxMemoryBytes) {
      throw ingestionError("storage-quota-invalid", "storage quota must be positive and within the v1 memory limit");
    }
    this.#rootDirectory = rootDirectory;
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

    return this.#runExclusive(() => this.#put(analysisID, key, blob, { signal }));
  }

  async #put(analysisID, key, blob, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);

    const root = await this.#getRoot();
    this.#assertOpen();
    assertNotCancelled(signal);
    const entryID = storageEntryID(analysisID, key);
    const existingSize = this.#knownSizes.get(entryID) ?? 0;
    const nextUsedBytes = this.#usedBytes - existingSize + blob.size;
    if (nextUsedBytes > this.#quotaBytes) {
      throw ingestionError("storage-quota-exceeded", "local analysis storage quota exceeded");
    }

    let writable;
    let removeAbortListener;
    const hadExistingEntry = this.#knownSizes.has(entryID);
    let analysisDirectory;
    try {
      analysisDirectory = await root.getDirectoryHandle(analysisID, { create: true });
      this.#assertOpen();
      assertNotCancelled(signal);
      const fileHandle = await analysisDirectory.getFileHandle(key, { create: true });
      writable = await fileHandle.createWritable({ keepExistingData: false });
      if (!writable || typeof writable.write !== "function" || typeof writable.close !== "function") {
        throw ingestionError("opfs-write-invalid", "origin-private storage returned an invalid writable handle");
      }
      this.#writables.add(writable);
      removeAbortListener = abortOnSignal(signal, writable);
      assertNotCancelled(signal);
      await writable.write(blob);
      assertNotCancelled(signal);
      this.#assertOpen();
      await writable.close();
      this.#writables.delete(writable);
      this.#assertOpen();
      this.#knownSizes.set(entryID, blob.size);
      this.#usedBytes = nextUsedBytes;
    } catch (cause) {
      this.#writables.delete(writable);
      removeAbortListener?.();
      await abortWritable(writable);
      if (!hadExistingEntry && analysisDirectory) await removeEntryIfPresent(analysisDirectory, key);
      if (signal?.aborted) assertNotCancelled(signal);
      if (this.#closed) throw ingestionError("storage-closed", "local analysis storage is closed");
      throw normalizeOpfsError(cause, "storage-write-failed", "origin-private storage could not retain analysis input");
    } finally {
      this.#writables.delete(writable);
      removeAbortListener?.();
    }
  }

  async get(analysisID, key, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    assertStorageKey(analysisID, "analysis id");
    assertStorageKey(key, "storage key");

    return this.#runExclusive(() => this.#get(analysisID, key, { signal }));
  }

  async #get(analysisID, key, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    const root = await this.#getRoot();
    this.#assertOpen();
    assertNotCancelled(signal);
    const analysisDirectory = await getDirectoryIfPresent(root, analysisID);
    if (!analysisDirectory) return undefined;
    const fileHandle = await getFileIfPresent(analysisDirectory, key);
    if (!fileHandle) return undefined;
    try {
      const file = await fileHandle.getFile();
      assertStorageBlob(file);
      return file;
    } catch (cause) {
      throw normalizeOpfsError(cause, "storage-read-failed", "origin-private storage could not read analysis input");
    }
  }

  async purgeAnalysis(analysisID, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    assertStorageKey(analysisID, "analysis id");

    return this.#runExclusive(() => this.#purgeAnalysis(analysisID, { signal }));
  }

  async #purgeAnalysis(analysisID, { signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    const root = await this.#getRoot();
    this.#assertOpen();
    assertNotCancelled(signal);
    await removeEntryIfPresent(root, analysisID, { recursive: true });
    this.#forgetAnalysis(analysisID);
  }

  async purge({ signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);

    return this.#runExclusive(() => this.#purge({ signal }));
  }

  async #purge({ signal } = {}) {
    this.#assertOpen();
    assertNotCancelled(signal);
    try {
      await removeEntryIfPresent(this.#rootDirectory, opfsStorageRootName, { recursive: true });
      this.#root = undefined;
      this.#usageLoaded = true;
      this.#knownSizes.clear();
      this.#usedBytes = 0;
    } catch (cause) {
      throw normalizeOpfsError(cause, "storage-purge-failed", "origin-private storage could not purge analysis input");
    }
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = Promise.allSettled([...this.#writables].map((writable) => abortWritable(writable))).then(async () => {
      await this.#operationTail;
      this.#writables.clear();
      this.#root = undefined;
    });
    return this.#closePromise;
  }

  #runExclusive(operation) {
    const scheduled = this.#operationTail.then(operation);
    this.#operationTail = scheduled.catch(() => undefined);
    return scheduled;
  }

  async #getRoot() {
    this.#assertOpen();
    if (!this.#root) {
      try {
        this.#root = await this.#rootDirectory.getDirectoryHandle(opfsStorageRootName, { create: true });
      } catch (cause) {
        throw normalizeOpfsError(cause, "opfs-unavailable", "origin-private storage is unavailable");
      }
    }
    if (!this.#usageLoaded) await this.#loadUsage();
    return this.#root;
  }

  async #loadUsage() {
    if (typeof this.#root.values !== "function") {
      throw ingestionError("opfs-enumeration-unsupported", "origin-private storage cannot enumerate its analysis namespace");
    }
    let usedBytes = 0;
    const knownSizes = new Map();
    try {
      for await (const entry of this.#root.values()) {
        if (!entry || entry.kind !== "directory" || !isStorageName(entry.name)) {
          throw ingestionError("storage-layout-invalid", "origin-private storage contains an invalid analysis namespace");
        }
        if (typeof entry.values !== "function") {
          throw ingestionError("opfs-enumeration-unsupported", "origin-private storage cannot enumerate an analysis namespace");
        }
        for await (const fileHandle of entry.values()) {
          if (!fileHandle || fileHandle.kind !== "file" || !isStorageName(fileHandle.name) || typeof fileHandle.getFile !== "function") {
            throw ingestionError("storage-layout-invalid", "origin-private storage contains an invalid analysis entry");
          }
          const file = await fileHandle.getFile();
          assertStorageBlob(file);
          usedBytes += file.size;
          if (usedBytes > this.#quotaBytes) {
            throw ingestionError("storage-quota-exceeded", "local analysis storage quota exceeded");
          }
          knownSizes.set(storageEntryID(entry.name, fileHandle.name), file.size);
        }
      }
    } catch (cause) {
      throw normalizeOpfsError(cause, "storage-read-failed", "origin-private storage could not inspect analysis input");
    }
    this.#usedBytes = usedBytes;
    this.#knownSizes = knownSizes;
    this.#usageLoaded = true;
  }

  #forgetAnalysis(analysisID) {
    const prefix = `${analysisID}\u0000`;
    for (const [entryID, size] of this.#knownSizes) {
      if (entryID.startsWith(prefix)) {
        this.#knownSizes.delete(entryID);
        this.#usedBytes -= size;
      }
    }
  }

  #assertOpen() {
    if (this.#closed) throw ingestionError("storage-closed", "local analysis storage is closed");
  }
}

// The browser host may call this once when creating its one-worker runtime.
// An unavailable or denied OPFS root deliberately selects the already-tested
// in-memory baseline; later OPFS write quota failures remain typed failures.
export async function createAnalysisStorage({ runtime = globalThis, quotaBytes, rootDirectory } = {}) {
  if (rootDirectory) return new OpfsAnalysisStorage({ rootDirectory, quotaBytes });
  const getDirectory = runtime?.navigator?.storage?.getDirectory;
  if (typeof getDirectory !== "function") return new MemoryAnalysisStorage({ quotaBytes });
  try {
    return new OpfsAnalysisStorage({
      rootDirectory: await getDirectory.call(runtime.navigator.storage),
      quotaBytes
    });
  } catch {
    return new MemoryAnalysisStorage({ quotaBytes });
  }
}

function storageEntryID(analysisID, key) {
  return `${analysisID}\u0000${key}`;
}

function isStorageName(value) {
  try {
    assertStorageKey(value, "storage name");
    return true;
  } catch {
    return false;
  }
}

async function getDirectoryIfPresent(root, name) {
  try {
    return await root.getDirectoryHandle(name);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw normalizeOpfsError(cause, "storage-read-failed", "origin-private storage could not read an analysis namespace");
  }
}

async function getFileIfPresent(directory, name) {
  try {
    return await directory.getFileHandle(name);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw normalizeOpfsError(cause, "storage-read-failed", "origin-private storage could not read an analysis entry");
  }
}

async function removeEntryIfPresent(directory, name, options) {
  try {
    await directory.removeEntry(name, options);
  } catch (cause) {
    if (isNotFound(cause)) return;
    throw cause;
  }
}

async function abortWritable(writable) {
  if (!writable || typeof writable.abort !== "function") return;
  try {
    await writable.abort();
  } catch {
    // A successful close can make a later abort invalid; there is no handle
    // left to clean in that case.
  }
}

function abortOnSignal(signal, writable) {
  if (!signal) return undefined;
  const abort = () => { void abortWritable(writable); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}

function normalizeOpfsError(cause, fallbackCode, message) {
  if (cause?.name === "IngestionError") return cause;
  if (cause?.name === "QuotaExceededError" || cause?.name === "NoModificationAllowedError") {
    return ingestionError("storage-quota-exceeded", "local analysis storage quota exceeded", { cause });
  }
  return ingestionError(fallbackCode, message, { cause });
}

function isNotFound(cause) {
  return cause?.name === "NotFoundError";
}
