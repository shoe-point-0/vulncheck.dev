import assert from "node:assert/strict";
import test from "node:test";

import { MemoryAnalysisStorage } from "./memory-storage.mjs";
import { createAnalysisStorage, OpfsAnalysisStorage, opfsStorageRootName } from "./opfs-storage.mjs";
import { sha256Digest } from "./analysis-bundle.mjs";
import { detectCapabilities } from "./capabilities.mjs";
import { handleIngestionMessage } from "./ingestion-worker.mjs";
import { createAnalysisBundleInput } from "./input.mjs";
import { finalizeManifest, manifestBase } from "./analysis-bundle-fixture.mjs";
import { makeStoredZip } from "./test-zip.mjs";

test("OPFS storage keeps bounded input in per-analysis namespaces and reloads usage", async () => {
  const root = new FakeDirectory("root");
  const storage = new OpfsAnalysisStorage({ rootDirectory: root, quotaBytes: 32 });
  await storage.put("analysis-1", "bundle.zip", new Blob(["first"]));
  await storage.put("analysis-2", "bundle.zip", new Blob(["second"]));
  assert.equal(await (await storage.get("analysis-1", "bundle.zip")).text(), "first");
  assert.equal(storage.usedBytes, 11);

  const reloaded = new OpfsAnalysisStorage({ rootDirectory: root, quotaBytes: 32 });
  assert.equal(await (await reloaded.get("analysis-2", "bundle.zip")).text(), "second");
  assert.equal(reloaded.usedBytes, 11);

  await reloaded.purgeAnalysis("analysis-1");
  assert.equal(await reloaded.get("analysis-1", "bundle.zip"), undefined);
  assert.equal(await (await reloaded.get("analysis-2", "bundle.zip")).text(), "second");
  await reloaded.purge();
  assert.equal(reloaded.usedBytes, 0);
  await assert.rejects(root.getDirectoryHandle(opfsStorageRootName), { name: "NotFoundError" });
});

test("OPFS storage reports quota, cancels an active write, cleans failed input, and closes", async () => {
  const root = new FakeDirectory("root");
  const storage = new OpfsAnalysisStorage({ rootDirectory: root, quotaBytes: 4 });
  await assert.rejects(storage.put("analysis-1", "bundle.zip", new Blob(["five!"])), { code: "storage-quota-exceeded" });

  const quotaRoot = new FakeDirectory("root");
  const quotaStorage = new OpfsAnalysisStorage({ rootDirectory: quotaRoot, quotaBytes: 32 });
  quotaRoot.nextWriteError = new DOMException("quota", "QuotaExceededError");
  await assert.rejects(quotaStorage.put("analysis-1", "bundle.zip", new Blob(["one"])), { code: "storage-quota-exceeded" });
  assert.equal(await quotaStorage.get("analysis-1", "bundle.zip"), undefined);

  const writeGate = new Promise(() => {});
  const cancellableRoot = new FakeDirectory("root", { writeGate });
  const cancellable = new OpfsAnalysisStorage({ rootDirectory: cancellableRoot, quotaBytes: 32 });
  const controller = new AbortController();
  const pending = cancellable.put("analysis-1", "bundle.zip", new Blob(["one"]), { signal: controller.signal });
  await cancellableRoot.writeStarted;
  controller.abort();
  await assert.rejects(pending, { code: "input-cancelled" });
  assert.equal(cancellableRoot.abortCalls, 1);
  assert.equal(await cancellable.get("analysis-1", "bundle.zip"), undefined);

  await cancellable.close();
  await assert.rejects(cancellable.get("analysis-1", "bundle.zip"), { code: "storage-closed" });
});

test("OPFS storage serializes concurrent mutations before applying its quota", async () => {
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const root = new FakeDirectory("root", { writeGate });
  const storage = new OpfsAnalysisStorage({ rootDirectory: root, quotaBytes: 4 });
  const first = storage.put("analysis-1", "first.zip", new Blob(["four"]));
  await root.writeStarted;
  const second = storage.put("analysis-1", "second.zip", new Blob(["four"]));
  releaseWrite();

  await first;
  await assert.rejects(second, { code: "storage-quota-exceeded" });
  assert.equal(storage.usedBytes, 4);
  assert.equal(await (await storage.get("analysis-1", "first.zip")).text(), "four");
  assert.equal(await storage.get("analysis-1", "second.zip"), undefined);
});

test("the capability-gated factory uses OPFS when available and a memory fallback otherwise", async () => {
  const root = new FakeDirectory("root");
  const opfs = await createAnalysisStorage({ runtime: { navigator: { storage: { async getDirectory() { return root; } } } } });
  assert.ok(opfs instanceof OpfsAnalysisStorage);

  const unavailable = await createAnalysisStorage({ runtime: { navigator: { storage: {} } } });
  assert.ok(unavailable instanceof MemoryAnalysisStorage);

  const denied = await createAnalysisStorage({ runtime: { navigator: { storage: { async getDirectory() { throw new DOMException("denied", "NotAllowedError"); } } } } });
  assert.ok(denied instanceof MemoryAnalysisStorage);
});

test("the dedicated ingestion core uses OPFS through the same storage contract", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const manifest = manifestBase("sources/demo.go", await sha256Digest(source), source.byteLength);
  await finalizeManifest(manifest);
  const archive = makeStoredZip([{ path: "manifest.json", content: JSON.stringify(manifest) }, { path: "sources/demo.go", bytes: source }]);
  const storage = new OpfsAnalysisStorage({ rootDirectory: new FakeDirectory("root"), quotaBytes: 32_768 });
  const result = await handleIngestionMessage({
    type: "ingest-analysis-input",
    request_id: "request-1",
    analysis_id: "analysis-1",
    input: createAnalysisBundleInput(archive)
  }, {
    storage,
    capabilityReport: detectCapabilities({ Worker: class Worker {}, ArrayBuffer, navigator: { storage: { getDirectory() {} } } }, "2026-08-22T00:00:00.000Z")
  });
  assert.equal(result.type, "analysis-bundle-validated");
  assert.equal((await storage.get("analysis-1", "analysis-bundle.zip")).size, archive.size);
});

class FakeDirectory {
  kind = "directory";
  directories = new Map();
  files = new Map();
  nextWriteError;
  abortCalls = 0;
  #writeGate;
  #writeStarted;

  constructor(name, { writeGate } = {}) {
    this.name = name;
    this.#writeGate = writeGate;
    this.#writeStarted = Promise.withResolvers();
  }

  get root() {
    return this.name === "root" ? this : this.parent.root;
  }

  get writeStarted() {
    return this.#writeStarted.promise;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!create) throw notFound();
    const directory = new FakeDirectory(name);
    directory.parent = this;
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name, { create = false } = {}) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!create) throw notFound();
    const file = new FakeFile(name, this);
    this.files.set(name, file);
    return file;
  }

  async removeEntry(name, { recursive = false } = {}) {
    if (this.files.delete(name)) return;
    const directory = this.directories.get(name);
    if (!directory) throw notFound();
    if (!recursive && (directory.files.size > 0 || directory.directories.size > 0)) throw new DOMException("not empty", "InvalidModificationError");
    this.directories.delete(name);
  }

  async *values() {
    yield* this.directories.values();
    yield* this.files.values();
  }

  async waitForWrite(aborted) {
    this.root.#writeStarted.resolve();
    if (this.root.#writeGate) {
      const outcome = await Promise.race([
        this.root.#writeGate.then(() => "released"),
        aborted?.then(() => "aborted")
      ]);
      if (outcome === "aborted") throw new DOMException("aborted", "AbortError");
    }
    if (this.root.nextWriteError) {
      const error = this.root.nextWriteError;
      this.root.nextWriteError = undefined;
      throw error;
    }
  }
}

class FakeFile {
  kind = "file";
  bytes = new Blob([]);

  constructor(name, directory) {
    this.name = name;
    this.directory = directory;
  }

  async getFile() {
    return this.bytes;
  }

  async createWritable() {
    const file = this;
    let pending;
    let closed = false;
    let abort;
    const aborted = new Promise((resolve) => { abort = resolve; });
    return {
      async write(value) {
        await file.directory.waitForWrite(aborted);
        pending = value;
      },
      async close() {
        if (closed) throw new DOMException("closed", "InvalidStateError");
        file.bytes = pending instanceof Blob ? pending : new Blob([pending]);
        closed = true;
      },
      async abort() {
        if (!closed) file.directory.root.abortCalls += 1;
        closed = true;
        abort();
      }
    };
  }
}

function notFound() {
  return new DOMException("missing", "NotFoundError");
}
