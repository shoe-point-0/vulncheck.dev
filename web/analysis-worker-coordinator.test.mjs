import assert from "node:assert/strict";
import test from "node:test";

import { createAnalysisWorkerCoordinator } from "./analysis-worker-coordinator.mjs";
import { normalizedInconclusiveReport } from "./analysis-worker-executor.mjs";
import { analysisWorkerProtocolVersion } from "./analysis-worker-protocol.mjs";
import { capabilityReport, snapshot } from "./analysis-worker-test-fixture.mjs";

test("one worker reports progress and a host-owned inconclusive terminal result", async () => {
  const factory = new FakeWorkerFactory();
  const progress = [];
  const coordinator = createAnalysisWorkerCoordinator({ capabilityReport, spawnWorker: () => factory.create(), now: monotonicClock() });
  const job = coordinator.submit(snapshot(), { jobID: "job-1", onProgress: (event) => progress.push(event) });
  const worker = factory.workers[0];
  const start = worker.posted[0];
  worker.emitMessage(progressEvent("job-1", 1, 2));
  worker.emitMessage(completedEvent("job-1", start.facts));
  const result = await job.completion;

  assert.equal(result.lifecycle, "completed");
  assert.equal(result.status, "inconclusive");
  assert.equal(result.transport, "transferable-message");
  assert.equal(result.report.bundle_digest, start.facts.bundle_digest);
  assert.deepEqual(progress, [{ job_id: "job-1", phase: "package-facts", completed: 1, total: 2 }]);
  assert.equal(worker.terminated, true);
  assert.equal(coordinator.activeJobCount(), 0);
});

test("repeated cancellation removes queued and active jobs without retaining partial reports", async () => {
  const factory = new FakeWorkerFactory();
  const coordinator = createAnalysisWorkerCoordinator({ capabilityReport, spawnWorker: () => factory.create(), now: monotonicClock() });
  const first = coordinator.submit(snapshot(), { jobID: "job-1" });
  const second = coordinator.submit(snapshot(), { jobID: "job-2" });
  second.cancel();
  const queuedResult = await second.completion;
  assert.equal(queuedResult.lifecycle, "cancelled");
  assert.equal("report" in queuedResult, false);

  const worker = factory.workers[0];
  first.cancel();
  assert.equal(worker.posted.at(-1).type, "analysis-cancel");
  worker.emitMessage({ protocol_version: analysisWorkerProtocolVersion, type: "analysis-cancelled", job_id: "job-1", code: "analysis-cancelled" });
  const activeResult = await first.completion;
  assert.equal(activeResult.lifecycle, "cancelled");
  assert.equal("report" in activeResult, false);
  assert.equal(factory.workers.length, 1);
  assert.equal(coordinator.activeJobCount(), 0);
});

test("crash, memory failure, malformed output, and replacement never publish a stale report", async () => {
  const factory = new FakeWorkerFactory();
  const coordinator = createAnalysisWorkerCoordinator({ capabilityReport, spawnWorker: () => factory.create(), now: monotonicClock() });
  const crashed = coordinator.submit(snapshot(), { jobID: "job-crash" });
  const crashedWorker = factory.workers[0];
  crashedWorker.emitError();
  const crashedResult = await crashed.completion;
  assert.equal(crashedResult.lifecycle, "failed");
  assert.equal(crashedResult.diagnostics[0].code, "analysis-worker-crashed");
  assert.equal("report" in crashedResult, false);

  const memory = coordinator.submit(snapshot(), { jobID: "job-memory" });
  const memoryWorker = factory.workers[1];
  memoryWorker.emitMessage({ protocol_version: analysisWorkerProtocolVersion, type: "analysis-failed", job_id: "job-memory", code: "analysis-memory-limit" });
  const memoryResult = await memory.completion;
  assert.equal(memoryResult.diagnostics[0].code, "analysis-memory-limit");
  assert.equal("report" in memoryResult, false);

  const malformed = coordinator.submit(snapshot(), { jobID: "job-malformed" });
  factory.workers[2].emitMessage({ protocol_version: analysisWorkerProtocolVersion, type: "analysis-completed", job_id: "job-malformed", report: {} });
  const malformedResult = await malformed.completion;
  assert.equal(malformedResult.diagnostics[0].code, "analysis-worker-malformed-output");
  assert.equal("report" in malformedResult, false);

  const replacement = coordinator.submit(snapshot(), { jobID: "job-replacement" });
  const replacementWorker = factory.workers[3];
  replacementWorker.emitMessage(completedEvent("job-replacement", replacementWorker.posted[0].facts));
  const replacementResult = await replacement.completion;
  assert.equal(replacementResult.lifecycle, "completed");
  assert.equal(factory.workers.length, 4);
  crashedWorker.emitMessage(completedEvent("job-crash", crashedWorker.posted[0].facts));
  assert.equal(replacementResult.job_id, "job-replacement");
});

test("wall timeout terminates a stuck worker after its bounded cancellation grace", async () => {
  const timers = new FakeTimers();
  const factory = new FakeWorkerFactory();
  const coordinator = createAnalysisWorkerCoordinator({
    capabilityReport,
    spawnWorker: () => factory.create(),
    timerAPI: timers,
    now: () => 0
  });
  const job = coordinator.submit(snapshot(), { jobID: "job-timeout", budget: { maxWallTimeMs: 1, maxCancellationGraceMs: 1 } });
  const worker = factory.workers[0];
  timers.runNext();
  assert.equal(worker.posted.at(-1).type, "analysis-cancel");
  timers.runNext();
  const result = await job.completion;
  assert.equal(result.lifecycle, "cancelled");
  assert.equal(result.diagnostics[0].code, "analysis-wall-timeout");
  assert.equal(worker.terminated, true);
});

class FakeWorkerFactory {
  constructor() { this.workers = []; }
  create() {
    const worker = new FakeWorker();
    this.workers.push(worker);
    return worker;
  }
}

class FakeWorker {
  constructor() {
    this.listeners = new Map([["message", new Set()], ["error", new Set()]]);
    this.posted = [];
    this.terminated = false;
  }
  addEventListener(type, listener) { this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type).delete(listener); }
  postMessage(message) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  emitMessage(data) { for (const listener of this.listeners.get("message")) listener({ data }); }
  emitError() { for (const listener of this.listeners.get("error")) listener({}); }
}

class FakeTimers {
  constructor() { this.callbacks = []; }
  setTimeout(callback) {
    const token = { callback, cancelled: false };
    this.callbacks.push(token);
    return token;
  }
  clearTimeout(token) { if (token) token.cancelled = true; }
  runNext() {
    const token = this.callbacks.shift();
    if (token && !token.cancelled) token.callback();
  }
}

function completedEvent(jobID, facts) {
  const report = normalizedInconclusiveReport(facts);
  return {
    protocol_version: analysisWorkerProtocolVersion,
    type: "analysis-completed",
    job_id: jobID,
    report,
    metrics: {
      package_count: facts.package_facts.length,
      import_edge_count: facts.import_edges.length,
      call_edge_count: facts.call_edges.length,
      cpu_time_ms: 0,
      wall_time_ms: 0,
      estimated_memory_bytes: 1
    }
  };
}

function progressEvent(jobID, completed, total) {
  return { protocol_version: analysisWorkerProtocolVersion, type: "analysis-progress", job_id: jobID, phase: "package-facts", completed, total };
}

function monotonicClock() {
  let now = 0;
  return () => now += 1;
}
