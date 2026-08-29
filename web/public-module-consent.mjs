import { ingestionError } from "./ingestion-error.mjs";
import { authorizePublicModuleRetrieval, publicModuleConsentDisclosure } from "./public-module-retrieval.mjs";
import { assertUIAction } from "./ui-policy.mjs";

// createPublicModuleConsentController is the browser-host boundary between a
// renderer and worker acquisition. A renderer displays `disclosure` and calls
// accept only from its affirmative button's trusted click handler. The host
// keeps the resulting receipt so a double click cannot create a second fetch.
export function createPublicModuleConsentController(plan, { worker, requestID, analysisID, onAuthorized } = {}) {
  const disclosure = publicModuleConsentDisclosure(plan);
  assertWorker(worker);
  assertIdentifier(requestID, "request id");
  assertIdentifier(analysisID, "analysis id");
  if (onAuthorized !== undefined && typeof onAuthorized !== "function") {
    throw ingestionError("module-consent-callback-invalid", "module consent callback must be a function");
  }
  let authorization;
  return Object.freeze({
    disclosure,
    accept(event) {
      assertUIAction("request-public-module-consent");
      if (event?.isTrusted !== true) {
        throw ingestionError("module-consent-user-gesture-required", "public module retrieval consent requires a trusted user activation");
      }
      if (authorization) return authorization;
      authorization = authorizePublicModuleRetrieval(plan, {
        accepted: true,
        selected_endpoint: disclosure.source_endpoint,
        module_path: disclosure.module_path
      });
      assertUIAction("request-analysis");
      worker.postMessage(Object.freeze({
        type: "retrieve-public-module",
        request_id: requestID,
        analysis_id: analysisID,
        authorization
      }));
      onAuthorized?.(authorization);
      return authorization;
    },
    authorization() {
      return authorization;
    }
  });
}

function assertWorker(worker) {
  if (!worker || typeof worker.postMessage !== "function") {
    throw ingestionError("module-consent-worker-invalid", "module consent requires a dedicated worker message port");
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
    throw ingestionError("module-consent-identifier-invalid", `${label} must be a bounded lower-case identifier`);
  }
}
