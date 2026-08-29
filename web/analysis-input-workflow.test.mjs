import assert from "node:assert/strict";
import test from "node:test";

import { createAnalysisInputWorkflowController, describeAnalysisInput } from "./analysis-input-workflow.mjs";
import { createAnalysisBundleInput, createModuleInput } from "./input.mjs";

test("presents Module View and Project Evidence as distinct workflows before ingestion", () => {
  const module = createModuleInput({ coordinate: { path: "example.com/demo", version: "v1.2.3" } });
  const bundle = createAnalysisBundleInput(new Blob(["bundle"]));

  assert.deepEqual(describeAnalysisInput(module), {
    type: "analysis-input-selection",
    workflow: "module-view",
    assurance: "module-view",
    input_kind: "module-input",
    project_reachability: {
      enabled: false,
      status: "inconclusive",
      reason: "module view has no captured project snapshot"
    }
  });
  assert.deepEqual(describeAnalysisInput(bundle), {
    type: "analysis-input-selection",
    workflow: "project-evidence",
    assurance: "project-evidence",
    input_kind: "analysis-bundle-input",
    project_reachability: {
      enabled: true,
      requirement: "validated native-captured analysis bundle"
    }
  });
});

test("requires a displayed selection and blocks Module View from project-reachability actions", () => {
  const messages = [];
  const controller = createAnalysisInputWorkflowController({
    worker: { postMessage(message) { messages.push(message); } },
    requestID: "request-1",
    analysisID: "analysis-1"
  });
  const module = createModuleInput({ coordinate: { path: "example.com/demo", version: "v1.2.3" } });

  assert.throws(() => controller.beginIngestion(), { code: "analysis-input-selection-required" });
  assert.deepEqual(controller.select(module).project_reachability, {
    enabled: false,
    status: "inconclusive",
    reason: "module view has no captured project snapshot"
  });
  assert.equal(controller.canRequestProjectReachability(), false);
  assert.throws(() => controller.requireProjectEvidence(), { code: "project-evidence-required" });

  const message = controller.beginIngestion();
  assert.deepEqual(message, {
    type: "ingest-analysis-input",
    request_id: "request-1",
    analysis_id: "analysis-1",
    input: module
  });
  assert.strictEqual(controller.beginIngestion(), message);
  assert.equal(messages.length, 1);
  assert.throws(() => controller.select(createAnalysisBundleInput(new Blob(["bundle"]))), { code: "analysis-input-already-selected" });
});

test("permits Project Evidence intake only from an AnalysisBundleInput", () => {
  const controller = createAnalysisInputWorkflowController({
    worker: { postMessage() {} },
    requestID: "request-2",
    analysisID: "analysis-2"
  });
  const bundle = createAnalysisBundleInput(new Blob(["bundle"]));
  controller.select(bundle);

  assert.equal(controller.canRequestProjectReachability(), true);
  assert.deepEqual(controller.requireProjectEvidence(), bundle);
});

test("rejects invalid worker ports and identifiers before a workflow is rendered", () => {
  assert.throws(() => createAnalysisInputWorkflowController({
    worker: {}, requestID: "request-1", analysisID: "analysis-1"
  }), { code: "analysis-input-worker-invalid" });
  assert.throws(() => createAnalysisInputWorkflowController({
    worker: { postMessage() {} }, requestID: "UPPER", analysisID: "analysis-1"
  }), { code: "analysis-input-identifier-invalid" });
});
