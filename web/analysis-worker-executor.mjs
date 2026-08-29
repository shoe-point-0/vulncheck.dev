import { resolveAnalysisJobBudget } from "./analysis-job-budget.mjs";
import { ingestionError } from "./ingestion-error.mjs";

// executeProjectFacts is deliberately a compact-fact tracer bullet, not a Go
// parser. The later kernel can replace its report calculation without changing
// the cancellation, budgeting, or host-owned terminal-report protocol.
export async function executeProjectFacts(facts, budget, options = {}) {
  const resolvedBudget = resolveAnalysisJobBudget(budget);
  const now = options.now ?? defaultNow;
  const yieldControl = options.yieldControl ?? yieldToWorkerEventLoop;
  const isCancelled = options.isCancelled ?? (() => false);
  const onProgress = options.onProgress ?? (() => {});
  const stageConcurrency = options.stageConcurrency ?? 1;
  if (!Number.isSafeInteger(stageConcurrency) || stageConcurrency < 1 || stageConcurrency > facts.package_facts.length) {
    throw ingestionError("analysis-stage-invalid", "analysis worker stage count is invalid");
  }

  const startedAt = now();
  const estimatedInputBytes = encodedBytes(facts);
  if (estimatedInputBytes > resolvedBudget.maxMemoryBytes) {
    throw ingestionError("analysis-memory-limit", "analysis worker facts exceed the memory budget");
  }
  const packageFacts = facts.package_facts.map((entry) => ({ ...entry, imports: [...entry.imports] }));
  const partitions = partition(packageFacts, stageConcurrency);
  const completed = [];
  let completedCount = 0;
  onProgress(Object.freeze({ phase: "package-facts", completed: 0, total: packageFacts.length }));

  await Promise.all(partitions.map(async (entries) => {
    for (const entry of entries) {
      assertWithinBudget(startedAt, now, resolvedBudget, isCancelled);
      completed.push(entry);
      completedCount += 1;
      onProgress(Object.freeze({ phase: "package-facts", completed: completedCount, total: packageFacts.length }));
      // Yield a task, rather than just a microtask, so a queued cancellation
      // message can reach this dedicated worker during a large analysis.
      await yieldControl();
      assertWithinBudget(startedAt, now, resolvedBudget, isCancelled);
    }
  }));

  const report = normalizedInconclusiveReport(facts, completed);
  const estimatedOutputBytes = encodedBytes(report);
  if (estimatedOutputBytes > resolvedBudget.maxOutputBytes) {
    throw ingestionError("analysis-output-limit", "analysis worker report exceeds the output budget");
  }
  const elapsed = Math.max(0, now() - startedAt);
  if (estimatedInputBytes + estimatedOutputBytes > resolvedBudget.maxMemoryBytes) {
    throw ingestionError("analysis-memory-limit", "analysis worker report exceeds the memory budget");
  }
  if (elapsed > resolvedBudget.maxCpuTimeMs) {
    throw ingestionError("analysis-cpu-limit", "analysis worker exceeded the cpu budget");
  }
  if (elapsed > resolvedBudget.maxWallTimeMs) {
    throw ingestionError("analysis-wall-limit", "analysis worker exceeded the wall-time budget");
  }
  return Object.freeze({
    report,
    metrics: Object.freeze({
      package_count: completed.length,
      import_edge_count: facts.import_edges.length,
      call_edge_count: facts.call_edges.length,
      cpu_time_ms: elapsed,
      wall_time_ms: elapsed,
      estimated_memory_bytes: estimatedInputBytes + estimatedOutputBytes
    })
  });
}

// normalizeProjectFactsForStages makes the future multi-worker merge seam
// explicit. Each partition is sorted before the same canonical report is
// assembled, so staged execution cannot change the final report bytes.
export function normalizedInconclusiveReport(facts, packageFacts = facts.package_facts) {
  const normalizedPackages = packageFacts.map((entry) => Object.freeze({
    path: entry.path,
    module_path: entry.module_path,
    module_version: entry.module_version,
    imports: Object.freeze([...entry.imports].sort(compareStrings))
  })).sort((left, right) => compareStrings(left.path, right.path));
  const importEdges = facts.import_edges.map((edge) => Object.freeze({ from: edge.from, to: edge.to }))
    .sort((left, right) => compareStrings(`${left.from}\u0000${left.to}`, `${right.from}\u0000${right.to}`));
  const callEdges = facts.call_edges.map((edge) => Object.freeze({ from: edge.from, to: edge.to }))
    .sort((left, right) => compareStrings(`${left.from}\u0000${left.to}`, `${right.from}\u0000${right.to}`));
  return Object.freeze({
    schema_version: "v1",
    bundle_digest: facts.bundle_digest,
    build_profile: Object.freeze({ ...facts.build_profile }),
    roots: Object.freeze([...facts.roots].sort(compareStrings)),
    package_facts: Object.freeze(normalizedPackages),
    import_edges: Object.freeze(importEdges),
    call_edges: Object.freeze(callEdges),
    status: "inconclusive",
    diagnostics: Object.freeze([Object.freeze({
      code: "analysis-kernel-unavailable",
      message: "the bounded worker processed project facts but no reachability kernel is available"
    })])
  });
}

function assertWithinBudget(startedAt, now, budget, isCancelled) {
  if (isCancelled()) throw ingestionError("analysis-cancelled", "analysis worker cancellation was requested");
  const elapsed = Math.max(0, now() - startedAt);
  if (elapsed > budget.maxCpuTimeMs) throw ingestionError("analysis-cpu-limit", "analysis worker exceeded the cpu budget");
  if (elapsed > budget.maxWallTimeMs) throw ingestionError("analysis-wall-limit", "analysis worker exceeded the wall-time budget");
}

function partition(entries, count) {
  const partitions = Array.from({ length: count }, () => []);
  for (let index = 0; index < entries.length; index += 1) {
    partitions[index % count].push(entries[index]);
  }
  return partitions;
}

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function yieldToWorkerEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
