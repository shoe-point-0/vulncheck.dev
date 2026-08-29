import { ingestionError } from "./ingestion-error.mjs";
import { assertAnalysisInput, assertProjectEvidenceInput, inputKind } from "./input.mjs";
import { assertUIAction } from "./ui-policy.mjs";

// describeAnalysisInput is the renderer-facing seam between input selection
// and worker ingestion. It deliberately contains no archive bytes, paths, or
// project result: a Module View selection has no captured project graph.
export function describeAnalysisInput(value) {
  return describeVerifiedInput(assertAnalysisInput(value));
}

// createAnalysisInputWorkflowController makes the selection order explicit:
// a renderer presents the distinct workflow before this controller can post
// the source input to the dedicated worker. One controller is one analysis,
// so a changed selection needs a new request and analysis identifier.
export function createAnalysisInputWorkflowController({ worker, requestID, analysisID } = {}) {
  assertWorker(worker);
  assertIdentifier(requestID, "request id");
  assertIdentifier(analysisID, "analysis id");

  let selectedInput;
  let selection;
  let message;

  return Object.freeze({
    select(value) {
      if (selectedInput) {
        throw ingestionError("analysis-input-already-selected", "analysis input is already selected for this request");
      }
      selectedInput = assertAnalysisInput(value);
      selection = describeVerifiedInput(selectedInput);
      return selection;
    },
    selection() {
      return selection;
    },
    canRequestProjectReachability() {
      return selectedInput?.kind === inputKind.analysisBundle;
    },
    requireProjectEvidence() {
      return assertProjectEvidenceInput(requireSelection(selectedInput));
    },
    beginIngestion() {
      assertUIAction("request-analysis");
      const input = requireSelection(selectedInput);
      if (message) return message;
      message = Object.freeze({
        type: "ingest-analysis-input",
        request_id: requestID,
        analysis_id: analysisID,
        input
      });
      worker.postMessage(message);
      return message;
    }
  });
}

function describeVerifiedInput(input) {
  if (input.kind === inputKind.module) {
    return Object.freeze({
      type: "analysis-input-selection",
      workflow: "module-view",
      assurance: "module-view",
      input_kind: inputKind.module,
      project_reachability: Object.freeze({
        enabled: false,
        status: "inconclusive",
        reason: "module view has no captured project snapshot"
      })
    });
  }
  return Object.freeze({
    type: "analysis-input-selection",
    workflow: "project-evidence",
    assurance: "project-evidence",
    input_kind: inputKind.analysisBundle,
    project_reachability: Object.freeze({
      enabled: true,
      requirement: "validated native-captured analysis bundle"
    })
  });
}

function requireSelection(input) {
  if (!input) {
    throw ingestionError("analysis-input-selection-required", "select an analysis input before requesting ingestion");
  }
  return input;
}

function assertWorker(worker) {
  if (!worker || typeof worker.postMessage !== "function") {
    throw ingestionError("analysis-input-worker-invalid", "analysis input workflow requires a dedicated worker message port");
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
    throw ingestionError("analysis-input-identifier-invalid", `${label} must be a bounded lower-case identifier`);
  }
}
