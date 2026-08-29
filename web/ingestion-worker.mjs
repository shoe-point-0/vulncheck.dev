import { assuranceProjectEvidence, hydrateAnalysisBundle } from "./analysis-bundle.mjs";
import { assertNotCancelled, ingestionError } from "./ingestion-error.mjs";
import { assertAnalysisInput, createModuleInput, inputKind } from "./input.mjs";
import { hydrateModuleArchive } from "./module-archive.mjs";
import { assertAnalysisStorage } from "./analysis-storage.mjs";
import { fetchAuthorizedModuleArchive } from "./public-module-fetch.mjs";

const bundleStorageKey = "analysis-bundle.zip";
const moduleStorageKey = "module-archive.zip";

// handleIngestionMessage is the testable worker core. It accepts only a
// structured-clone-safe message, validates the input again, and returns a
// source-free summary plus the capability report that must accompany analysis.
export async function handleIngestionMessage(message, dependencies) {
  const { capabilityReport, signal, storage } = dependencies ?? {};
  const messageType = assertWorkerMessage(message);
  assertCapabilityReport(capabilityReport);
  assertStorage(storage);
  assertNotCancelled(signal);
  if (messageType === "retrieve-public-module") {
    return retrievePublicModule(message, dependencies);
  }
  const input = assertAnalysisInput(message.input);
  if (input.kind === inputKind.module) {
    if (input.archive) {
      const module = await hydrateModuleArchive(input, dependencies);
      assertNotCancelled(signal);
      await storage.put(message.analysis_id, moduleStorageKey, input.archive, { signal });
      return Object.freeze({
        type: "module-archive-validated",
        request_id: message.request_id,
        capability_report: capabilityReport,
        module_coordinate: module.coordinate,
        content_paths: Object.freeze(module.entries.map((entry) => entry.path)),
        reachability: "inconclusive"
      });
    }
    return Object.freeze({
      type: "module-view-planned",
      request_id: message.request_id,
      capability_report: capabilityReport,
      reachability: "inconclusive"
    });
  }
  const bundle = await hydrateAnalysisBundle(input, dependencies);
  if (bundle.assurance !== assuranceProjectEvidence) {
    throw ingestionError("project-evidence-required", "project reachability requires a validated native-captured analysis bundle");
  }
  assertNotCancelled(signal);
  await storage.put(message.analysis_id, bundleStorageKey, input.archive, { signal });
  return Object.freeze({
    type: "analysis-bundle-validated",
    request_id: message.request_id,
    capability_report: capabilityReport,
    schema_version: bundle.schema_version,
    content_paths: Object.freeze(bundle.content.map((entry) => entry.path)),
    assurance: bundle.assurance,
    bundle_snapshot: Object.freeze({
      assurance: bundle.assurance,
      generated_at: bundle.generated_at,
      producer: bundle.producer,
      build_profile: bundle.build_profile,
      roots: bundle.roots,
      content_count: bundle.content.length
    })
  });
}

async function retrievePublicModule(message, dependencies) {
  const { capabilityReport, signal, storage } = dependencies ?? {};
  const fetched = await fetchAuthorizedModuleArchive(message.authorization, dependencies);
  assertNotCancelled(signal);
  const module = await hydrateModuleArchive(createModuleInput({ archive: fetched.archive }), {
    ...dependencies,
    budget: { ...dependencies?.budget, maxBytes: fetched.maximum_bytes },
    coordinate: fetched.coordinate
  });
  assertNotCancelled(signal);
  await storage.put(message.analysis_id, moduleStorageKey, fetched.archive, { signal });
  return Object.freeze({
    type: "public-module-retrieved-and-validated",
    request_id: message.request_id,
    capability_report: capabilityReport,
    module_coordinate: module.coordinate,
    content_paths: Object.freeze(module.entries.map((entry) => entry.path)),
    source_endpoint: fetched.source_endpoint,
    transfer_bytes: fetched.transfer_bytes,
    reachability: "inconclusive"
  });
}

// installIngestionWorker connects the same core to a dedicated Worker global.
// It is intentionally a one-worker baseline; the actor mesh owns parallelism.
export function installIngestionWorker(scope, dependencies) {
  if (!scope || typeof scope.addEventListener !== "function" || typeof scope.postMessage !== "function") {
    throw ingestionError("worker-scope-invalid", "dedicated worker scope is required");
  }
  scope.addEventListener("message", async (event) => {
    try {
      scope.postMessage(await handleIngestionMessage(event.data, dependencies));
    } catch (error) {
      scope.postMessage(Object.freeze({
        type: "analysis-ingestion-failed",
        request_id: typeof event.data?.request_id === "string" ? event.data.request_id : "unknown",
        code: error?.code ?? "analysis-ingestion-failed"
      }));
    }
  });
}

function assertWorkerMessage(message) {
  if (!message || typeof message !== "object" || !isID(message.request_id) || !isID(message.analysis_id)) {
    throw ingestionError("browser-message-invalid", "ingestion worker message is invalid");
  }
  if (message.type === "ingest-analysis-input" && hasOnlyKeys(message, ["type", "request_id", "analysis_id", "input"])) return message.type;
  if (message.type === "retrieve-public-module" && hasOnlyKeys(message, ["type", "request_id", "analysis_id", "authorization"])) return message.type;
  throw ingestionError("browser-message-invalid", "ingestion worker message is invalid");
}

function assertCapabilityReport(report) {
  if (!report || typeof report !== "object" || report.schema_version !== "v1" || typeof report.selected_profile !== "string" || typeof report.selected_fallback !== "string") {
    throw ingestionError("capability-report-invalid", "v1 capability report is required for ingestion");
  }
}

function assertStorage(storage) {
  assertAnalysisStorage(storage);
}

function isID(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
