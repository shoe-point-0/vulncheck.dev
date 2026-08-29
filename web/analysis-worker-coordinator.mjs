import { planWorkerConcurrency, resolveAnalysisJobBudget } from "./analysis-job-budget.mjs";
import { ingestionError } from "./ingestion-error.mjs";
import { analysisLifecycleState, assertAnalysisWorkerEvent, createAnalysisCancelMessage, createAnalysisStartMessage, projectFactsFromSnapshot } from "./analysis-worker-protocol.mjs";

// createAnalysisWorkerCoordinator owns scheduling and every terminal report.
// A worker can supply progress or a bounded intermediate report, but it never
// gets authority to publish partial, stale, or terminal UI state.
export function createAnalysisWorkerCoordinator(options = {}) {
  const capabilityReport = options.capabilityReport;
  const spawnWorker = resolveWorkerSpawner(options);
  const runtime = options.runtime ?? globalThis;
  const timerAPI = options.timerAPI ?? globalThis;
  const now = options.now ?? defaultNow;
  const concurrencyPlan = planWorkerConcurrency(capabilityReport, runtime);
  const jobs = new Map();
  const queue = [];
  let active;
  let disposed = false;

  return Object.freeze({
    submit(snapshot, { jobID, budget, onProgress } = {}) {
      if (disposed) throw ingestionError("analysis-coordinator-disposed", "analysis worker coordinator is disposed");
      const resolvedBudget = resolveAnalysisJobBudget(budget);
      const facts = projectFactsFromSnapshot(snapshot, resolvedBudget);
      if (!validJobID(jobID)) throw ingestionError("analysis-job-id-invalid", "analysis job id must be a bounded lower-case identifier");
      if (jobs.has(jobID)) throw ingestionError("analysis-job-duplicate", "analysis job id is already in use");
      if (onProgress !== undefined && typeof onProgress !== "function") throw ingestionError("analysis-progress-handler-invalid", "analysis progress handler must be a function");

      let resolveCompletion;
      const completion = new Promise((resolve) => { resolveCompletion = resolve; });
      const job = {
        id: jobID,
        facts,
        budget: resolvedBudget,
        onProgress,
        state: analysisLifecycleState.created,
        createdAt: now(),
        completion,
        resolveCompletion,
        worker: undefined,
        listeners: undefined,
        wallTimer: undefined,
        graceTimer: undefined,
        cancellationCode: undefined
      };
      jobs.set(jobID, job);
      queue.push(job);
      activateNext();
      return Object.freeze({
        job_id: jobID,
        completion,
        cancel() { cancel(job, "analysis-cancelled"); },
        state() { return job.state; }
      });
    },
    cancel(jobID) {
      const job = jobs.get(jobID);
      if (!job) return false;
      cancel(job, "analysis-cancelled");
      return true;
    },
    state(jobID) {
      return jobs.get(jobID)?.state;
    },
    activeJobCount() {
      return active ? 1 : 0;
    },
    concurrencyPlan() {
      return concurrencyPlan;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const job of [...queue]) finish(job, analysisLifecycleState.disposed, "analysis-coordinator-disposed");
      if (active) finish(active, analysisLifecycleState.disposed, "analysis-coordinator-disposed");
    }
  });

  function activateNext() {
    if (disposed || active) return;
    const next = queue.shift();
    if (!next) return;
    if (terminal(next)) return activateNext();
    active = next;
    next.state = analysisLifecycleState.loading;
    let worker;
    try {
      worker = spawnWorker();
      assertWorker(worker);
    } catch (error) {
      finish(next, analysisLifecycleState.failed, error?.code ?? "analysis-worker-unavailable");
      return;
    }
    next.worker = worker;
    const onMessage = (event) => handleWorkerEvent(next, event?.data);
    const onError = () => finish(next, analysisLifecycleState.failed, "analysis-worker-crashed");
    next.listeners = { onMessage, onError };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    next.state = analysisLifecycleState.running;
    try {
      worker.postMessage(createAnalysisStartMessage(next.id, next.facts, capabilityReport, next.budget));
    } catch (error) {
      finish(next, analysisLifecycleState.failed, error?.code ?? "analysis-worker-post-failed");
      return;
    }
    next.wallTimer = timerAPI.setTimeout(() => cancel(next, "analysis-wall-timeout"), next.budget.maxWallTimeMs);
  }

  function handleWorkerEvent(job, event) {
    if (active !== job || terminal(job)) return;
    let workerEvent;
    try {
      workerEvent = assertAnalysisWorkerEvent(event);
      if (workerEvent.job_id !== job.id) throw ingestionError("analysis-worker-output-invalid", "analysis worker output belongs to a different job");
    } catch {
      finish(job, analysisLifecycleState.failed, "analysis-worker-malformed-output");
      return;
    }
    if (workerEvent.type === "analysis-progress") {
      if (job.state === analysisLifecycleState.running) {
        job.onProgress?.(Object.freeze({
          job_id: job.id,
          phase: workerEvent.phase,
          completed: workerEvent.completed,
          total: workerEvent.total
        }));
      }
      return;
    }
    if (workerEvent.type === "analysis-completed") {
      if (job.state !== analysisLifecycleState.running || workerEvent.report.bundle_digest !== job.facts.bundle_digest || workerEvent.metrics.package_count !== job.facts.package_facts.length || workerEvent.metrics.cpu_time_ms > job.budget.maxCpuTimeMs || workerEvent.metrics.wall_time_ms > job.budget.maxWallTimeMs || workerEvent.metrics.estimated_memory_bytes > job.budget.maxMemoryBytes || encodedBytes(workerEvent.report) > job.budget.maxOutputBytes) {
        finish(job, analysisLifecycleState.failed, "analysis-worker-malformed-output");
        return;
      }
      finish(job, analysisLifecycleState.completed, undefined, workerEvent);
      return;
    }
    if (workerEvent.type === "analysis-cancelled") {
      finish(job, analysisLifecycleState.cancelled, job.cancellationCode ?? workerEvent.code);
      return;
    }
    finish(job, analysisLifecycleState.failed, workerEvent.code);
  }

  function cancel(job, code) {
    if (terminal(job)) return;
    job.cancellationCode = code;
    if (job.state === analysisLifecycleState.created) {
      finish(job, analysisLifecycleState.cancelled, code);
      return;
    }
    if (job.state !== analysisLifecycleState.running && job.state !== analysisLifecycleState.loading) return;
    job.state = analysisLifecycleState.cancelling;
    try {
      job.worker?.postMessage(createAnalysisCancelMessage(job.id));
    } catch {
      // The grace timer still owns termination and terminal result assembly.
    }
    job.graceTimer = timerAPI.setTimeout(() => finish(job, analysisLifecycleState.cancelled, code), job.budget.maxCancellationGraceMs);
  }

  function finish(job, state, code, workerEvent) {
    if (terminal(job)) return;
    if (job.wallTimer !== undefined) timerAPI.clearTimeout(job.wallTimer);
    if (job.graceTimer !== undefined) timerAPI.clearTimeout(job.graceTimer);
    if (job.worker) {
      if (job.listeners && typeof job.worker.removeEventListener === "function") {
        job.worker.removeEventListener("message", job.listeners.onMessage);
        job.worker.removeEventListener("error", job.listeners.onError);
      }
      try { job.worker.terminate(); } catch { /* already stopped */ }
    }
    job.state = state;
    const elapsed = Math.max(0, now() - job.createdAt);
    const completed = state === analysisLifecycleState.completed;
    const result = Object.freeze({
      schema_version: "v1",
      type: "analysis-job-result",
      job_id: job.id,
      lifecycle: state,
      status: "inconclusive",
      capability_report: capabilityReport,
      transport: "transferable-message",
      concurrency: concurrencyPlan,
      metrics: Object.freeze({
        package_count: job.facts.package_facts.length,
        elapsed_ms: elapsed,
        ...(completed ? workerEvent.metrics : {})
      }),
      diagnostics: Object.freeze(completed
        ? workerEvent.report.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))
        : [Object.freeze({ code: code ?? "analysis-worker-failed", message: terminalMessage(code) })]),
      ...(completed ? { report: workerEvent.report } : {})
    });
    job.resolveCompletion(result);
    if (active === job) active = undefined;
    activateNext();
  }
}

function resolveWorkerSpawner(options) {
  if (typeof options.spawnWorker === "function") return options.spawnWorker;
  if (typeof options.Worker === "function" && typeof options.workerURL === "string" && options.workerURL !== "") {
    return () => new options.Worker(options.workerURL, { type: "module" });
  }
  throw ingestionError("analysis-worker-unavailable", "analysis worker coordinator requires a worker factory");
}

function assertWorker(worker) {
  if (!worker || typeof worker.postMessage !== "function" || typeof worker.addEventListener !== "function" || typeof worker.terminate !== "function") {
    throw ingestionError("analysis-worker-unavailable", "analysis worker factory returned an invalid worker");
  }
}

function terminal(job) {
  return job.state === analysisLifecycleState.cancelled || job.state === analysisLifecycleState.completed || job.state === analysisLifecycleState.failed || job.state === analysisLifecycleState.disposed;
}

function validJobID(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function terminalMessage(code) {
  const messages = {
    "analysis-cancelled": "analysis was cancelled and partial worker output was discarded",
    "analysis-wall-timeout": "analysis exceeded its wall-time budget and partial worker output was discarded",
    "analysis-worker-crashed": "analysis worker crashed and no report was retained",
    "analysis-worker-malformed-output": "analysis worker returned malformed output and no report was retained",
    "analysis-coordinator-disposed": "analysis worker coordinator was disposed and no report was retained"
  };
  return messages[code] ?? "analysis worker failed and no report was retained";
}
