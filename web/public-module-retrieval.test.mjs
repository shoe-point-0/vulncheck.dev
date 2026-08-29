import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicModuleRetrievalAuthorization, authorizePublicModuleRetrieval, planModuleRoute, publicModuleConsentDisclosure } from "./public-module-retrieval.mjs";

const directRoute = Object.freeze({ pathname: "/m/github.com/Azure/azure-sdk-for-go@v1.2.3", search: "", hash: "" });

test("starts cached Module View locally and otherwise presents a bound consent plan", () => {
  const cached = planModuleRoute(directRoute, { cache_status: "cached" });
  assert.equal(cached.type, "module-view-cached");
  assert.equal(cached.reachability, "inconclusive");

  const consent = planModuleRoute(directRoute, {
    cache_status: "missing",
    selected_endpoint: "https://proxy.example.test/goproxy"
  });
  assert.equal(consent.type, "public-module-consent-required");
  assert.equal(consent.source_endpoint, "https://proxy.example.test/goproxy");
  assert.equal(consent.module_path, "github.com/Azure/azure-sdk-for-go");
  assert.equal(consent.transfer.expected_size_bytes, "unknown");
  assert.equal(consent.transfer.maximum_bytes, 64 * 1024 * 1024);
  assert.equal(consent.archive_url, "https://proxy.example.test/goproxy/github.com/!azure/azure-sdk-for-go/@v/v1.2.3.zip");
});

test("allows a request descriptor only after matching explicit consent and never changes endpoint", () => {
  const consent = planModuleRoute(directRoute, {
    cache_status: "missing",
    selected_endpoint: "https://proxy.golang.org"
  });
  const authorized = authorizePublicModuleRetrieval(consent, {
    accepted: true,
    selected_endpoint: "https://proxy.golang.org",
    module_path: "github.com/Azure/azure-sdk-for-go"
  });
  assert.equal(authorized.type, "public-module-retrieval-authorized");
  assert.deepEqual(authorized.transfer, {
    expected_size_bytes: "unknown",
    maximum_bytes: 64 * 1024 * 1024
  });
  assert.deepEqual(authorized.request, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    url: "https://proxy.golang.org/github.com/!azure/azure-sdk-for-go/@v/v1.2.3.zip"
  });

  assert.throws(() => authorizePublicModuleRetrieval(consent, {
    accepted: true,
    selected_endpoint: "https://other.invalid",
    module_path: "github.com/Azure/azure-sdk-for-go"
  }), { code: "module-consent-mismatch" });
});

test("renders a precise disclosure and revalidates a cloned authorization before worker use", () => {
  const consent = planModuleRoute(directRoute, {
    cache_status: "missing",
    selected_endpoint: "https://proxy.golang.org",
    budget: { maxBytes: 1024 }
  });
  assert.deepEqual(publicModuleConsentDisclosure(consent), {
    assurance: "module-view",
    reachability: "inconclusive",
    canonical_path: "/m/github.com/Azure/azure-sdk-for-go@v1.2.3",
    module_path: "github.com/Azure/azure-sdk-for-go",
    module_version: "v1.2.3",
    source_endpoint: "https://proxy.golang.org",
    archive_url: "https://proxy.golang.org/github.com/!azure/azure-sdk-for-go/@v/v1.2.3.zip",
    transfer: { expected_size_bytes: "unknown", maximum_bytes: 1024 }
  });
  const authorization = authorizePublicModuleRetrieval(consent, {
    accepted: true,
    selected_endpoint: "https://proxy.golang.org",
    module_path: "github.com/Azure/azure-sdk-for-go"
  });
  const cloned = structuredClone(authorization);
  const validated = assertPublicModuleRetrievalAuthorization(cloned);
  assert.deepEqual(validated.coordinate, { path: "github.com/Azure/azure-sdk-for-go", version: "v1.2.3" });
  assert.equal(validated.maximum_bytes, 1024);

  cloned.request.url = "https://other.invalid/archive.zip";
  assert.throws(() => assertPublicModuleRetrievalAuthorization(cloned), { code: "module-retrieval-authorization-invalid" });
});

test("offline cache misses fail closed without creating a consent plan", () => {
  const result = planModuleRoute(directRoute, { cache_status: "missing", offline: true });
  assert.deepEqual(result, {
    type: "module-view-unavailable",
    code: "offline-module-not-cached",
    assurance: "module-view",
    reachability: "inconclusive",
    canonical_path: "/m/github.com/Azure/azure-sdk-for-go@v1.2.3"
  });
});
