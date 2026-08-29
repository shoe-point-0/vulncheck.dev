import { ingestionError } from "./ingestion-error.mjs";
import { analysisWorkerProtocolVersion, assertAnalysisWorkerMessage } from "./analysis-worker-protocol.mjs";
import { executeProjectFacts } from "./analysis-worker-executor.mjs";

// installAnalysisWorker connects a pure compact-fact executor to one dedicated
// worker. The worker never assembles a terminal host report and never receives
// source bytes, mutable ASTs, Go heap pointers, or binary IR.
export function installAnalysisWorker(scope, options = {}) {
  if (!scope || typeof scope.addEventListener !== "function" || typeof scope.postMessage !== "function") {
    throw ingestionError("analysis-worker-scope-invalid", "analysis worker requires a dedicated worker scope");
  }
  const executor = options.executor ?? executeProjectFacts;
  const yieldControl = options.yieldControl;
  const now = options.now;
  const active = new Map();

  scope.addEventListener("message", (event) => {
    let message;
    try {
      message = assertAnalysisWorkerMessage(event.data);
    } catch (error) {
      const jobID = typeof event.data?.job_id === "string" ? event.data.job_id : undefined;
      if (jobID) post(scope, failedEvent(jobID, error?.code ?? "analysis-worker-protocol-invalid"));
      return;
    }
    if (message.type === "analysis-cancel") {
      const control = active.get(message.job_id);
      if (control) control.cancelled = true;
      return;
    }
    if (active.size > 0) {
      post(scope, failedEvent(message.job_id, "analysis-worker-busy"));
      return;
    }
    const control = { cancelled: false };
    active.set(message.job_id, control);
    void runJob(scope, message, control, { executor, yieldControl, now }).finally(() => active.delete(message.job_id));
  });
}

async function runJob(scope, message, control, { executor, yieldControl, now }) {
  try {
    const result = await executor(message.facts, message.budget, {
      isCancelled: () => control.cancelled,
      onProgress(progress) {
        post(scope, Object.freeze({
          protocol_version: analysisWorkerProtocolVersion,
          type: "analysis-progress",
          job_id: message.job_id,
          ...progress
        }));
      },
      ...(yieldControl ? { yieldControl } : {}),
      ...(now ? { now } : {})
    });
    if (control.cancelled) {
      post(scope, cancelledEvent(message.job_id));
      return;
    }
    post(scope, Object.freeze({
      protocol_version: analysisWorkerProtocolVersion,
      type: "analysis-completed",
      job_id: message.job_id,
      report: result.report,
      metrics: result.metrics
    }));
  } catch (error) {
    if (control.cancelled || error?.code === "analysis-cancelled") {
      post(scope, cancelledEvent(message.job_id));
      return;
    }
    post(scope, failedEvent(message.job_id, error?.code ?? "analysis-worker-failed"));
  }
}

function post(scope, event) {
  scope.postMessage(event);
}

function cancelledEvent(jobID) {
  return Object.freeze({ protocol_version: analysisWorkerProtocolVersion, type: "analysis-cancelled", job_id: jobID, code: "analysis-cancelled" });
}

function failedEvent(jobID, code) {
  return Object.freeze({ protocol_version: analysisWorkerProtocolVersion, type: "analysis-failed", job_id: jobID, code });
}
