import assert from "node:assert/strict";
import test from "node:test";

import { sha256Digest } from "./analysis-bundle.mjs";
import { detectCapabilities } from "./capabilities.mjs";
import { createAnalysisBundleInput, createModuleInput } from "./input.mjs";
import { handleIngestionMessage, installIngestionWorker } from "./ingestion-worker.mjs";
import { MemoryAnalysisStorage } from "./memory-storage.mjs";
import { authorizePublicModuleRetrieval, planModuleRoute } from "./public-module-retrieval.mjs";
import { makeStoredZip } from "./test-zip.mjs";

test("one worker validates a bundle, retains it in the fallback store, and returns capabilities", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const manifest = JSON.stringify({ schema_version: "v1", files: [{ path: "sources/demo.go", digest: await sha256Digest(source) }] });
  const archive = makeStoredZip([{ path: "manifest.json", content: manifest }, { path: "sources/demo.go", bytes: source }]);
  const storage = new MemoryAnalysisStorage();
  const capabilityReport = detectCapabilities({ Worker: class Worker {}, ArrayBuffer, navigator: { storage: {} } }, "2026-08-22T00:00:00.000Z");

  const result = await handleIngestionMessage({
    type: "ingest-analysis-input",
    request_id: "request-1",
    analysis_id: "analysis-1",
    input: createAnalysisBundleInput(archive)
  }, { storage, capabilityReport });
  assert.equal(result.type, "analysis-bundle-validated");
  assert.deepEqual(result.content_paths, ["sources/demo.go"]);
  assert.equal((await storage.get("analysis-1", "analysis-bundle.zip")).size, archive.size);
});

test("one worker plans Module View without reachability or network side effects", async () => {
  const storage = new MemoryAnalysisStorage();
  const capabilityReport = detectCapabilities({ Worker: class Worker {}, ArrayBuffer, navigator: { storage: {} } }, "2026-08-22T00:00:00.000Z");
  const result = await handleIngestionMessage({
    type: "ingest-analysis-input",
    request_id: "request-2",
    analysis_id: "analysis-2",
    input: createModuleInput({ coordinate: { path: "example.com/demo", version: "v1.2.3" } })
  }, { storage, capabilityReport });
  assert.equal(result.type, "module-view-planned");
  assert.equal(result.reachability, "inconclusive");
  assert.equal(storage.usedBytes, 0);
});

test("one worker validates and retains a local Module View archive without project reachability", async () => {
  const archive = makeStoredZip([
    { path: "example.com/demo@v1.2.3/go.mod", content: "module example.com/demo\n" },
    { path: "example.com/demo@v1.2.3/main.go", content: "package demo\n" }
  ]);
  const storage = new MemoryAnalysisStorage();
  const capabilityReport = detectCapabilities({ Worker: class Worker {}, ArrayBuffer, navigator: { storage: {} } }, "2026-08-22T00:00:00.000Z");
  const result = await handleIngestionMessage({
    type: "ingest-analysis-input",
    request_id: "request-archive",
    analysis_id: "analysis-archive",
    input: createModuleInput({ archive })
  }, { storage, capabilityReport });
  assert.equal(result.type, "module-archive-validated");
  assert.deepEqual(result.module_coordinate, { path: "example.com/demo", version: "v1.2.3" });
  assert.deepEqual(result.content_paths, ["go.mod", "main.go"]);
  assert.equal(result.reachability, "inconclusive");
  assert.equal((await storage.get("analysis-archive", "module-archive.zip")).size, archive.size);
});

test("one worker fetches only a consent-authorized Module View archive and validates its requested coordinate", async () => {
  const archive = makeStoredZip([
    { path: "example.com/demo@v1.2.3/go.mod", content: "module example.com/demo\n" },
    { path: "example.com/demo@v1.2.3/main.go", content: "package demo\n" }
  ]);
  const plan = planModuleRoute({ pathname: "/m/example.com/demo@v1.2.3", search: "", hash: "" }, {
    cache_status: "missing",
    selected_endpoint: "https://proxy.example.test"
  });
  const authorization = authorizePublicModuleRetrieval(plan, {
    accepted: true,
    selected_endpoint: "https://proxy.example.test",
    module_path: "example.com/demo"
  });
  const storage = new MemoryAnalysisStorage();
  const capabilityReport = detectCapabilities({ Worker: class Worker {}, ArrayBuffer, navigator: { storage: {} } }, "2026-08-22T00:00:00.000Z");
  const calls = [];
  const result = await handleIngestionMessage({
    type: "retrieve-public-module",
    request_id: "request-fetch",
    analysis_id: "analysis-fetch",
    authorization
  }, {
    storage,
    capabilityReport,
    async fetchAPI(url, options) {
      calls.push({ url, options });
      return new Response(archive, { status: 200, headers: { "content-length": String(archive.size) } });
    }
  });
  assert.equal(result.type, "public-module-retrieved-and-validated");
  assert.deepEqual(result.module_coordinate, { path: "example.com/demo", version: "v1.2.3" });
  assert.deepEqual(result.content_paths, ["go.mod", "main.go"]);
  assert.equal(result.source_endpoint, "https://proxy.example.test");
  assert.equal(result.transfer_bytes, archive.size);
  assert.equal(result.reachability, "inconclusive");
  assert.equal(calls.length, 1);
  assert.equal((await storage.get("analysis-fetch", "module-archive.zip")).size, archive.size);
});

test("the dedicated-worker entry returns a typed quota failure", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const manifest = JSON.stringify({ schema_version: "v1", files: [{ path: "sources/demo.go", digest: await sha256Digest(source) }] });
  const archive = makeStoredZip([{ path: "manifest.json", content: manifest }, { path: "sources/demo.go", bytes: source }]);
  const messages = [];
  let listener;
  const scope = {
    addEventListener(type, handler) {
      assert.equal(type, "message");
      listener = handler;
    },
    postMessage(message) {
      messages.push(message);
    }
  };
  installIngestionWorker(scope, {
    storage: new MemoryAnalysisStorage({ quotaBytes: 1 }),
    capabilityReport: detectCapabilities({ Worker: class Worker {}, ArrayBuffer, navigator: { storage: {} } }, "2026-08-22T00:00:00.000Z")
  });
  await listener({ data: {
    type: "ingest-analysis-input",
    request_id: "request-3",
    analysis_id: "analysis-3",
    input: createAnalysisBundleInput(archive)
  } });
  assert.deepEqual(messages, [{ type: "analysis-ingestion-failed", request_id: "request-3", code: "storage-quota-exceeded" }]);
});
