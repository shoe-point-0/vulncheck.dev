import assert from "node:assert/strict";
import test from "node:test";

import { hardAnalysisJobBudget, planWorkerConcurrency, resolveAnalysisJobBudget } from "./analysis-job-budget.mjs";
import { normalizedInconclusiveReport, executeProjectFacts } from "./analysis-worker-executor.mjs";
import { createAnalysisCancelMessage, createAnalysisStartMessage, projectFactsFromSnapshot } from "./analysis-worker-protocol.mjs";
import { capabilityReport, snapshot } from "./analysis-worker-test-fixture.mjs";

test("project facts retain only compact immutable package and edge data", () => {
  const facts = projectFactsFromSnapshot(snapshot());
  assert.equal(Object.isFrozen(facts), true);
  assert.deepEqual(facts.package_facts.map((entry) => entry.path), ["example.com/project", "example.com/project/dep"]);
  assert.deepEqual(facts.import_edges, [{ from: "example.com/project", to: "example.com/project/dep" }]);
  assert.deepEqual(facts.call_edges, []);
  assert.equal("content" in facts, false);
  assert.equal("files" in facts.package_facts[0], false);

  const start = createAnalysisStartMessage("job-1", facts, capabilityReport, { maxPackages: 2 });
  assert.equal(start.protocol_version, "v1");
  assert.deepEqual(createAnalysisCancelMessage("job-1"), { protocol_version: "v1", type: "analysis-cancel", job_id: "job-1" });
});

test("single and staged compact-fact execution normalize to byte-identical reports", async () => {
  const facts = projectFactsFromSnapshot(snapshot());
  const options = { yieldControl: async () => {}, now: (() => { let tick = 0; return () => tick += 1; })() };
  const single = await executeProjectFacts(facts, {}, { ...options, stageConcurrency: 1 });
  const staged = await executeProjectFacts(facts, {}, { ...options, stageConcurrency: 2 });
  assert.equal(JSON.stringify(single.report), JSON.stringify(staged.report));
  assert.deepEqual(single.report, normalizedInconclusiveReport(facts));
});

test("executor observes cancellation and resource budgets in cooperative loops", async () => {
  const facts = projectFactsFromSnapshot(snapshot());
  let cancelled = false;
  await assert.rejects(
    executeProjectFacts(facts, {}, {
      isCancelled: () => cancelled,
      async yieldControl() { cancelled = true; },
      now: () => 0
    }),
    { code: "analysis-cancelled" }
  );
  await assert.rejects(
    executeProjectFacts(facts, { maxOutputBytes: 1 }, { yieldControl: async () => {}, now: () => 0 }),
    { code: "analysis-output-limit" }
  );
  let tick = 0;
  await assert.rejects(
    executeProjectFacts(facts, { maxCpuTimeMs: 1 }, { yieldControl: async () => {}, now: () => tick += 2 }),
    { code: "analysis-cpu-limit" }
  );
  assert.equal(hardAnalysisJobBudget.maxPackages, 10_000);
  assert.throws(() => resolveAnalysisJobBudget({ unexpected: 1 }), { code: "analysis-job-budget-invalid" });
});

test("protocol rejects non-fact data and oversized fact edges before worker execution", () => {
  const facts = structuredClone(projectFactsFromSnapshot(snapshot()));
  facts.package_facts[0].files = ["source.go"];
  assert.throws(
    () => createAnalysisStartMessage("job-invalid", facts, capabilityReport, {}),
    { code: "analysis-worker-protocol-invalid" }
  );
  const tooManyEdges = structuredClone(projectFactsFromSnapshot(snapshot()));
  tooManyEdges.import_edges = Array.from({ length: 33 }, () => ({ from: "example.com/project", to: "example.com/project/dep" }));
  assert.throws(
    () => createAnalysisStartMessage("job-edges", tooManyEdges, capabilityReport, { maxPackages: 2 }),
    { code: "analysis-worker-protocol-invalid" }
  );
});

test("hardware concurrency stays advisory and optional shared memory is disabled", () => {
  const isolated = { ...capabilityReport, selected_profile: "isolated-parallel" };
  const plan = planWorkerConcurrency(isolated, { navigator: { hardwareConcurrency: 64 } });
  assert.deepEqual(plan, {
    active_workers: 1,
    hardware_hint: 64,
    shared_memory_enabled: false,
    reason: "parallel worker stages are disabled until isolated browser profiling is retained"
  });
});
