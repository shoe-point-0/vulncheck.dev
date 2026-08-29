import assert from "node:assert/strict";
import test from "node:test";

import { createPublicModuleConsentController } from "./public-module-consent.mjs";
import { planModuleRoute } from "./public-module-retrieval.mjs";

const plan = planModuleRoute({ pathname: "/m/example.com/demo@v1.2.3", search: "", hash: "" }, {
  cache_status: "missing",
  selected_endpoint: "https://proxy.example.test"
});

test("a browser-host consent controller discloses retrieval details and posts one message only for a trusted click", () => {
  const messages = [];
  const controller = createPublicModuleConsentController(plan, {
    worker: { postMessage(message) { messages.push(message); } },
    requestID: "request-1",
    analysisID: "analysis-1"
  });
  assert.equal(controller.disclosure.source_endpoint, "https://proxy.example.test");
  assert.equal(controller.disclosure.module_path, "example.com/demo");
  assert.equal(controller.disclosure.transfer.expected_size_bytes, "unknown");

  assert.throws(() => controller.accept({ isTrusted: false }), { code: "module-consent-user-gesture-required" });
  assert.equal(messages.length, 0);

  const authorization = controller.accept({ isTrusted: true });
  assert.equal(authorization.source_endpoint, "https://proxy.example.test");
  assert.deepEqual(messages[0], {
    type: "retrieve-public-module",
    request_id: "request-1",
    analysis_id: "analysis-1",
    authorization
  });
  assert.strictEqual(controller.accept({ isTrusted: true }), authorization);
  assert.equal(messages.length, 1);
});

test("consent controllers reject invalid worker ports and identifiers before rendering", () => {
  assert.throws(() => createPublicModuleConsentController(plan, {
    worker: {}, requestID: "request-1", analysisID: "analysis-1"
  }), { code: "module-consent-worker-invalid" });
  assert.throws(() => createPublicModuleConsentController(plan, {
    worker: { postMessage() {} }, requestID: "UPPER", analysisID: "analysis-1"
  }), { code: "module-consent-identifier-invalid" });
});
