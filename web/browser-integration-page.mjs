import { sha256Digest } from "./analysis-bundle.mjs";
import { createAnalysisInputWorkflowController } from "./analysis-input-workflow.mjs";
import { detectCapabilities } from "./capabilities.mjs";
import { createAnalysisBundleInput, createModuleInput } from "./input.mjs";
import { createAnalysisStorage, OpfsAnalysisStorage } from "./opfs-storage.mjs";
import { createPublicModuleConsentController } from "./public-module-consent.mjs";
import { planModuleRoute } from "./public-module-retrieval.mjs";
import { makeStoredZip } from "./test-zip.mjs";

const firstNavigationKey = "vulncheck-browser-integration-first-navigation";
const resultsElement = document.querySelector("#results");
const consentButton = document.querySelector("#accept-public-module");
const requiresIsolation = new URL(location.href).searchParams.get("isolation") === "required";

void run().catch((error) => finish("failed", {
  error: error instanceof Error ? error.message : String(error)
}));

async function run() {
  const initialResponseHeaders = await observeIsolationResponseHeaders();
  assertExpectedIsolationResponseHeaders(initialResponseHeaders, "initial navigation");
  const serviceWorker = await establishControlledNavigation(initialResponseHeaders);
  if (!serviceWorker) return;

  const controlledResponseHeaders = await observeIsolationResponseHeaders();
  assertExpectedIsolationResponseHeaders(controlledResponseHeaders, "service-worker-controlled navigation");
  const capabilityReport = detectCapabilities();
  assert(capabilityReport.selected_profile !== "unavailable", "the browser baseline must be available");
  assert(serviceWorker.before_isolated === requiresIsolation, "the initial navigation reported an unexpected cross-origin-isolation state");
  assert(serviceWorker.after_isolated === requiresIsolation, "service-worker control changed cross-origin isolation");
  if (requiresIsolation) {
    assert(capabilityReport.selected_profile === "isolated-parallel", "an isolated browser must select the optional isolated profile");
  }

  const storage = await verifyBrowserStorage();
  const worker = new Worker("./browser-integration-worker.mjs", { type: "module" });
  try {
    const workerResults = await verifyWorkerInputs(worker);
    await waitForTrustedConsentClick();
    finish("passed", Object.freeze({
      test_origin: location.origin,
      user_agent: navigator.userAgent,
      capability_report: capabilityReport,
      service_worker: Object.freeze({
        ...serviceWorker,
        after_response_headers: controlledResponseHeaders
      }),
      storage,
      worker: workerResults,
      consent: Object.freeze({ trusted_click: true, posted_messages: 1 })
    }));
  } finally {
    worker.terminate();
  }
}

async function establishControlledNavigation(initialResponseHeaders) {
  if (!navigator.serviceWorker) {
    throw new Error("service workers are unavailable at the browser integration origin");
  }

  const isolated = globalThis.crossOriginIsolated === true;
  if (!navigator.serviceWorker.controller) {
    sessionStorage.setItem(firstNavigationKey, JSON.stringify({
      isolated,
      response_headers: initialResponseHeaders
    }));
    await navigator.serviceWorker.register("./browser-integration-sw.mjs", { scope: "./" });
    await navigator.serviceWorker.ready;
    location.reload();
    return undefined;
  }

  const firstNavigation = sessionStorage.getItem(firstNavigationKey);
  if (!firstNavigation) {
    throw new Error("service-worker-controlled navigation has no initial capability record");
  }
  sessionStorage.removeItem(firstNavigationKey);
  const initialNavigation = JSON.parse(firstNavigation);
  return Object.freeze({
    controlled: true,
    before_isolated: initialNavigation.isolated === true,
    after_isolated: isolated,
    before_response_headers: initialNavigation.response_headers
  });
}

async function observeIsolationResponseHeaders() {
  const response = await fetch(location.href, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error"
  });
  assert(response.ok, `the integration document header observation failed with HTTP ${response.status}`);
  return Object.freeze({
    cross_origin_opener_policy: response.headers.get("cross-origin-opener-policy"),
    cross_origin_embedder_policy: response.headers.get("cross-origin-embedder-policy")
  });
}

function assertExpectedIsolationResponseHeaders(headers, navigation) {
  if (requiresIsolation) {
    assert(headers.cross_origin_opener_policy === "same-origin", `${navigation} must send Cross-Origin-Opener-Policy: same-origin`);
    assert(headers.cross_origin_embedder_policy === "require-corp", `${navigation} must send Cross-Origin-Embedder-Policy: require-corp`);
    return;
  }
  assert(headers.cross_origin_opener_policy === null, `${navigation} must not send Cross-Origin-Opener-Policy for the baseline fixture`);
  assert(headers.cross_origin_embedder_policy === null, `${navigation} must not send Cross-Origin-Embedder-Policy for the baseline fixture`);
}

async function verifyBrowserStorage() {
  const opfsAdvertised = typeof navigator.storage?.getDirectory === "function";
  const storage = await createAnalysisStorage({ quotaBytes: 64 });
  if (opfsAdvertised) {
    assert(storage instanceof OpfsAnalysisStorage, "available OPFS must select the OPFS storage adapter");
  }
  await storage.put("browser-storage", "fixture", new Blob(["ok"]));
  const retained = await storage.get("browser-storage", "fixture");
  assert(await retained?.text() === "ok", "browser storage round trip failed");
  await storage.purgeAnalysis("browser-storage");
  assert(await storage.get("browser-storage", "fixture") === undefined, "browser storage purge failed");

  const competingWrites = await Promise.allSettled([
    storage.put("browser-storage", "first", new Blob([new Uint8Array(40)])),
    storage.put("browser-storage", "second", new Blob([new Uint8Array(40)]))
  ]);
  assert(competingWrites[0].status === "fulfilled", "the first bounded write must complete");
  assert(competingWrites[1].status === "rejected" && competingWrites[1].reason?.code === "storage-quota-exceeded", "a concurrent write must observe the retained quota");
  assert(storage.usedBytes === 40, "storage accounting must retain only the successful concurrent write");
  assert(await storage.get("browser-storage", "second") === undefined, "a rejected concurrent write must not become visible");
  await storage.purgeAnalysis("browser-storage");
  assert(storage.usedBytes === 0, "purge must release the retained concurrent write");

  for (let index = 0; index < 16; index += 1) {
    await storage.put("browser-stress", `entry-${index}`, new Blob(["four"]));
  }
  assert(storage.usedBytes === 64, "the browser adapter must account for every retained bounded stress entry");
  await expectError(
    storage.put("browser-stress", "overflow", new Blob(["one!"])),
    "storage-quota-exceeded"
  );
  await storage.purgeAnalysis("browser-stress");
  assert(storage.usedBytes === 0, "stress cleanup must release every bounded entry");

  const cancelled = new AbortController();
  cancelled.abort();
  await expectError(
    storage.put("browser-storage", "cancelled", new Blob(["cancelled"]), { signal: cancelled.signal }),
    "input-cancelled"
  );
  assert(await storage.get("browser-storage", "cancelled") === undefined, "a cancelled write must not become visible");
  await storage.close();

  const fallbackStorage = await createAnalysisStorage({ runtime: { navigator: { storage: {} } }, quotaBytes: 16 });
  assert(!(fallbackStorage instanceof OpfsAnalysisStorage), "the no-OPFS capability path must use in-memory Blob storage");
  await fallbackStorage.put("browser-fallback", "fixture", new Blob(["ok"]));
  assert(await (await fallbackStorage.get("browser-fallback", "fixture")).text() === "ok", "the no-OPFS fallback must retain bounded input");
  await fallbackStorage.purge();
  await fallbackStorage.close();
  const fallbackCapabilityReport = detectCapabilities({
    Worker: globalThis.Worker,
    ArrayBuffer: globalThis.ArrayBuffer,
    navigator: { storage: {} },
    crossOriginIsolated: false
  });
  assert(fallbackCapabilityReport.selected_profile === "baseline-worker", "the no-OPFS path must retain the one-worker baseline profile");

  const constrainedStorage = await createAnalysisStorage({ quotaBytes: 1 });
  await expectError(
    constrainedStorage.put("browser-storage", "limited", new Blob(["too large"])),
    "storage-quota-exceeded"
  );
  await constrainedStorage.close();
  return Object.freeze({
    adapter: storage instanceof OpfsAnalysisStorage ? "opfs" : "in-memory-blob-storage",
    quota_failure: "storage-quota-exceeded",
    concurrent_quota_failure: "storage-quota-exceeded",
    cancelled_write: "input-cancelled",
    stress_entries: 16,
    fallback_adapter: "in-memory-blob-storage",
    fallback_profile: fallbackCapabilityReport.selected_profile
  });
}

async function verifyWorkerInputs(worker) {
  const archive = await validAnalysisBundleArchive();
  const bundleWorkflow = createAnalysisInputWorkflowController({
    worker,
    requestID: "browser-bundle-request",
    analysisID: "browser-bundle-analysis"
  });
  const bundleSelection = bundleWorkflow.select(createAnalysisBundleInput(archive));
  assert(bundleSelection.project_reachability.enabled === true, "AnalysisBundleInput must enable Project Evidence");
  assert(bundleWorkflow.canRequestProjectReachability(), "AnalysisBundleInput must pass the Project Evidence guard");
  const bundleResultPromise = nextWorkerMessage(worker);
  bundleWorkflow.beginIngestion();
  const bundleResult = await bundleResultPromise;
  assert(bundleResult.type === "analysis-bundle-validated", "AnalysisBundleInput worker result is invalid");

  const moduleWorkflow = createAnalysisInputWorkflowController({
    worker,
    requestID: "browser-module-request",
    analysisID: "browser-module-analysis"
  });
  const moduleSelection = moduleWorkflow.select(createModuleInput({
    coordinate: { path: "example.com/demo", version: "v1.2.3" }
  }));
  assert(moduleSelection.project_reachability.enabled === false, "Module View must disable Project Evidence");
  assert(moduleSelection.project_reachability.status === "inconclusive", "Module View must stay inconclusive");
  await expectThrown(() => moduleWorkflow.requireProjectEvidence(), "project-evidence-required");
  const moduleResultPromise = nextWorkerMessage(worker);
  moduleWorkflow.beginIngestion();
  const moduleResult = await moduleResultPromise;
  assert(moduleResult.type === "module-view-planned", "ModuleInput worker result is invalid");
  assert(moduleResult.reachability === "inconclusive", "Module View reachability must stay inconclusive");

  return Object.freeze({
    bundle_result: bundleResult.type,
    module_result: moduleResult.type,
    worker_profile: bundleResult.capability_report.selected_profile
  });
}

async function validAnalysisBundleArchive() {
  const source = new TextEncoder().encode("package demo\n");
  const digest = await sha256Digest(source);
  return makeStoredZip([
    { path: "manifest.json", content: JSON.stringify({ schema_version: "v1", files: [{ path: "sources/demo.go", digest }] }) },
    { path: "sources/demo.go", bytes: source }
  ]);
}

function waitForTrustedConsentClick() {
  const messages = [];
  const plan = planModuleRoute({
    pathname: "/m/example.com/demo@v1.2.3",
    search: "",
    hash: ""
  }, {
    cache_status: "missing",
    selected_endpoint: "https://proxy.example.test"
  });
  const controller = createPublicModuleConsentController(plan, {
    worker: { postMessage(message) { messages.push(message); } },
    requestID: "browser-consent-request",
    analysisID: "browser-consent-analysis"
  });
  return new Promise((resolve, reject) => {
    consentButton.addEventListener("click", (event) => {
      try {
        const authorization = controller.accept(event);
        assert(event.isTrusted === true, "browser automation must create a trusted click");
        assert(messages.length === 1, "trusted consent must post exactly one worker message");
        assert(messages[0].authorization === authorization, "consent message must contain the immutable authorization");
        resolve();
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    document.body.dataset.testState = "awaiting-consent";
  });
}

function nextWorkerMessage(worker) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("dedicated worker response timed out")), 10_000);
    worker.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    }, { once: true });
    worker.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(event.error ?? new Error(event.message));
    }, { once: true });
  });
}

async function expectError(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error(`expected ${code}`);
}

async function expectThrown(operation, code) {
  try {
    operation();
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finish(state, result) {
  document.body.dataset.testState = state;
  resultsElement.textContent = JSON.stringify(result);
}
