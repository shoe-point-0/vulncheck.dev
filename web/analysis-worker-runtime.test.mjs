import assert from "node:assert/strict";
import test from "node:test";

import { installAnalysisWorker } from "./analysis-worker-runtime.mjs";
import { createAnalysisCancelMessage, createAnalysisStartMessage, projectFactsFromSnapshot } from "./analysis-worker-protocol.mjs";
import { capabilityReport, snapshot } from "./analysis-worker-test-fixture.mjs";

test("worker runtime emits progress and bounded completion for one compact-fact job", async () => {
  const scope = new FakeScope();
  installAnalysisWorker(scope, { yieldControl: async () => {}, now: () => 0 });
  const message = createAnalysisStartMessage("job-1", projectFactsFromSnapshot(snapshot()), capabilityReport, {});
  scope.emit(message);
  await eventually(() => scope.messages.some((event) => event.type === "analysis-completed"));
  assert.deepEqual(scope.messages.map((event) => event.type), ["analysis-progress", "analysis-progress", "analysis-progress", "analysis-completed"]);
  assert.equal(scope.messages.at(-1).report.status, "inconclusive");
});

test("worker runtime processes a cancel message between cooperative yields", async () => {
  let releaseYield;
  const yieldGate = new Promise((resolve) => { releaseYield = resolve; });
  const scope = new FakeScope();
  installAnalysisWorker(scope, { yieldControl: () => yieldGate, now: () => 0 });
  const message = createAnalysisStartMessage("job-cancel", projectFactsFromSnapshot(snapshot()), capabilityReport, {});
  scope.emit(message);
  await eventually(() => scope.messages.some((event) => event.type === "analysis-progress"));
  scope.emit(createAnalysisCancelMessage("job-cancel"));
  releaseYield();
  await eventually(() => scope.messages.some((event) => event.type === "analysis-cancelled"));
  assert.equal(scope.messages.at(-1).code, "analysis-cancelled");
  assert.equal(scope.messages.some((event) => event.type === "analysis-completed"), false);
});

class FakeScope {
  constructor() { this.listener = undefined; this.messages = []; }
  addEventListener(type, listener) { assert.equal(type, "message"); this.listener = listener; }
  postMessage(message) { this.messages.push(message); }
  emit(data) { this.listener({ data }); }
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("expected asynchronous worker result");
}
