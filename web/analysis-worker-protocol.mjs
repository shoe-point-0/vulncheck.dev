import { assuranceProjectEvidence } from "./analysis-bundle.mjs";
import { resolveAnalysisJobBudget } from "./analysis-job-budget.mjs";
import { ingestionError } from "./ingestion-error.mjs";

export const analysisWorkerProtocolVersion = "v1";

export const analysisLifecycleState = Object.freeze({
  created: "created",
  loading: "loading",
  running: "running",
  cancelling: "cancelling",
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed",
  disposed: "disposed"
});

export function projectFactsFromSnapshot(snapshot, budget) {
  const resolvedBudget = resolveAnalysisJobBudget(budget);
  if (!snapshot || typeof snapshot !== "object" || snapshot.schema_version !== "v1" || snapshot.assurance !== assuranceProjectEvidence || !validDigest(snapshot.bundle_digest)) {
    throw ingestionError("analysis-snapshot-invalid", "analysis workers require a validated v1 Project Evidence snapshot");
  }
  if (!snapshot.build_profile || !boundedString(snapshot.build_profile.goos) || !boundedString(snapshot.build_profile.goarch) || !Array.isArray(snapshot.roots) || !Array.isArray(snapshot.package_inventory)) {
    throw ingestionError("analysis-snapshot-invalid", "analysis worker snapshot facts are incomplete");
  }
  if (snapshot.package_inventory.length === 0 || snapshot.package_inventory.length > resolvedBudget.maxPackages) {
    throw ingestionError("analysis-package-limit", "analysis worker package facts exceed the job budget");
  }

  const packagePaths = new Set();
  const packages = snapshot.package_inventory.map((entry) => {
    if (!entry || typeof entry !== "object" || !boundedString(entry.path) || !boundedString(entry.module_path) || !boundedString(entry.module_version) || !Array.isArray(entry.imports) || packagePaths.has(entry.path)) {
      throw ingestionError("analysis-snapshot-invalid", "analysis worker package facts are invalid");
    }
    packagePaths.add(entry.path);
    const imports = entry.imports.map((path) => {
      if (!boundedString(path)) throw ingestionError("analysis-snapshot-invalid", "analysis worker import facts are invalid");
      return path;
    }).sort(compareStrings);
    return Object.freeze({
      path: entry.path,
      module_path: entry.module_path,
      module_version: entry.module_version,
      imports: Object.freeze(imports)
    });
  }).sort((left, right) => compareStrings(left.path, right.path));

  const roots = snapshot.roots.map((root) => {
    if (!boundedString(root) || !packagePaths.has(root)) {
      throw ingestionError("analysis-snapshot-invalid", "analysis worker roots must name captured packages");
    }
    return root;
  }).sort(compareStrings);
  const importEdges = [];
  for (const pkg of packages) {
    for (const imported of pkg.imports) {
      importEdges.push(Object.freeze({ from: pkg.path, to: imported }));
    }
  }
  importEdges.sort((left, right) => compareStrings(`${left.from}\u0000${left.to}`, `${right.from}\u0000${right.to}`));

  // The current bundle has package import edges, not a proven call graph.
  // Keep an explicit empty call-edge field so future kernels can serialize
  // validated compact call facts without ever sharing ASTs or Go heap data.
  return Object.freeze({
    schema_version: "v1",
    bundle_digest: snapshot.bundle_digest,
    build_profile: Object.freeze({ goos: snapshot.build_profile.goos, goarch: snapshot.build_profile.goarch }),
    roots: Object.freeze(roots),
    package_facts: Object.freeze(packages),
    import_edges: Object.freeze(importEdges),
    call_edges: Object.freeze([])
  });
}

export function createAnalysisStartMessage(jobID, facts, capabilityReport, budget) {
  assertJobID(jobID);
  const resolvedBudget = resolveAnalysisJobBudget(budget);
  assertProjectFacts(facts, resolvedBudget);
  assertCapabilityReport(capabilityReport);
  return Object.freeze({
    protocol_version: analysisWorkerProtocolVersion,
    type: "analysis-start",
    job_id: jobID,
    facts,
    capability_report: capabilityReport,
    budget: resolvedBudget
  });
}

export function createAnalysisCancelMessage(jobID) {
  assertJobID(jobID);
  return Object.freeze({ protocol_version: analysisWorkerProtocolVersion, type: "analysis-cancel", job_id: jobID });
}

export function assertAnalysisWorkerMessage(message) {
  if (!message || typeof message !== "object" || message.protocol_version !== analysisWorkerProtocolVersion || !validJobID(message.job_id) || typeof message.type !== "string") {
    throw ingestionError("analysis-worker-protocol-invalid", "analysis worker message is invalid");
  }
  if (message.type === "analysis-start" && hasOnlyKeys(message, ["protocol_version", "type", "job_id", "facts", "capability_report", "budget"])) {
    const budget = resolveAnalysisJobBudget(message.budget);
    assertProjectFacts(message.facts, budget);
    assertCapabilityReport(message.capability_report);
    return message;
  }
  if (message.type === "analysis-cancel" && hasOnlyKeys(message, ["protocol_version", "type", "job_id"])) return message;
  throw ingestionError("analysis-worker-protocol-invalid", "analysis worker message is unsupported");
}

export function assertAnalysisWorkerEvent(event) {
  if (!event || typeof event !== "object" || event.protocol_version !== analysisWorkerProtocolVersion || !validJobID(event.job_id) || typeof event.type !== "string") {
    throw ingestionError("analysis-worker-output-invalid", "analysis worker output is invalid");
  }
  if (event.type === "analysis-progress" && hasOnlyKeys(event, ["protocol_version", "type", "job_id", "phase", "completed", "total"]) && boundedString(event.phase) && validCount(event.completed) && validCount(event.total) && event.completed <= event.total) return event;
  if (event.type === "analysis-completed" && hasOnlyKeys(event, ["protocol_version", "type", "job_id", "report", "metrics"])) {
    assertWorkerReport(event.report);
    assertWorkerMetrics(event.metrics);
    return event;
  }
  if ((event.type === "analysis-cancelled" || event.type === "analysis-failed") && hasOnlyKeys(event, ["protocol_version", "type", "job_id", "code"]) && boundedString(event.code)) return event;
  throw ingestionError("analysis-worker-output-invalid", "analysis worker output is unsupported");
}

function assertProjectFacts(facts, budget) {
  if (!facts || typeof facts !== "object" || !hasOnlyKeys(facts, ["schema_version", "bundle_digest", "build_profile", "roots", "package_facts", "import_edges", "call_edges"]) || facts.schema_version !== "v1" || !validDigest(facts.bundle_digest) || !facts.build_profile || !hasOnlyKeys(facts.build_profile, ["goos", "goarch"]) || !boundedString(facts.build_profile.goos) || !boundedString(facts.build_profile.goarch) || !Array.isArray(facts.roots) || !Array.isArray(facts.package_facts) || !Array.isArray(facts.import_edges) || !Array.isArray(facts.call_edges)) {
    throw ingestionError("analysis-worker-protocol-invalid", "analysis worker facts are invalid");
  }
  if (facts.package_facts.length === 0 || facts.package_facts.length > budget.maxPackages || encodedBytes(facts) > budget.maxMemoryBytes) {
    throw ingestionError("analysis-worker-protocol-invalid", "analysis worker facts exceed the job budget");
  }
  const packagePaths = new Set();
  for (const entry of facts.package_facts) {
    if (!entry || typeof entry !== "object" || !hasOnlyKeys(entry, ["path", "module_path", "module_version", "imports"]) || !boundedString(entry.path) || !boundedString(entry.module_path) || !boundedString(entry.module_version) || !Array.isArray(entry.imports) || packagePaths.has(entry.path)) {
      throw ingestionError("analysis-worker-protocol-invalid", "analysis worker package facts are invalid");
    }
    packagePaths.add(entry.path);
    for (const imported of entry.imports) {
      if (!boundedString(imported)) throw ingestionError("analysis-worker-protocol-invalid", "analysis worker import facts are invalid");
    }
  }
  for (const root of facts.roots) {
    if (!boundedString(root) || !packagePaths.has(root)) throw ingestionError("analysis-worker-protocol-invalid", "analysis worker roots are invalid");
  }
  assertEdges(facts.import_edges, budget, "import");
  assertEdges(facts.call_edges, budget, "call");
}

function assertWorkerReport(report) {
  if (!report || typeof report !== "object" || !hasOnlyKeys(report, ["schema_version", "bundle_digest", "build_profile", "roots", "package_facts", "import_edges", "call_edges", "status", "diagnostics"]) || report.schema_version !== "v1" || report.status !== "inconclusive" || !validDigest(report.bundle_digest) || !report.build_profile || !hasOnlyKeys(report.build_profile, ["goos", "goarch"]) || !boundedString(report.build_profile.goos) || !boundedString(report.build_profile.goarch) || !Array.isArray(report.roots) || !Array.isArray(report.package_facts) || !Array.isArray(report.import_edges) || !Array.isArray(report.call_edges) || !Array.isArray(report.diagnostics)) {
    throw ingestionError("analysis-worker-output-invalid", "analysis worker report is invalid");
  }
  for (const entry of report.package_facts) {
    if (!entry || typeof entry !== "object" || !hasOnlyKeys(entry, ["path", "module_path", "module_version", "imports"]) || !boundedString(entry.path) || !boundedString(entry.module_path) || !boundedString(entry.module_version) || !Array.isArray(entry.imports)) {
      throw ingestionError("analysis-worker-output-invalid", "analysis worker report package facts are invalid");
    }
  }
  for (const diagnostic of report.diagnostics) {
    if (!diagnostic || typeof diagnostic !== "object" || !hasOnlyKeys(diagnostic, ["code", "message"]) || !boundedString(diagnostic.code) || !boundedString(diagnostic.message)) {
      throw ingestionError("analysis-worker-output-invalid", "analysis worker report diagnostics are invalid");
    }
  }
}

function assertEdges(edges, budget, kind) {
  if (edges.length > budget.maxPackages * 16) {
    throw ingestionError("analysis-worker-protocol-invalid", `analysis worker ${kind} edges exceed the job budget`);
  }
  for (const edge of edges) {
    if (!edge || typeof edge !== "object" || !hasOnlyKeys(edge, ["from", "to"]) || !boundedString(edge.from) || !boundedString(edge.to)) {
      throw ingestionError("analysis-worker-protocol-invalid", `analysis worker ${kind} edges are invalid`);
    }
  }
}

function assertWorkerMetrics(metrics) {
  if (!metrics || typeof metrics !== "object" || !validCount(metrics.package_count) || !validCount(metrics.import_edge_count) || !validCount(metrics.call_edge_count) || !Number.isFinite(metrics.cpu_time_ms) || metrics.cpu_time_ms < 0 || !Number.isFinite(metrics.wall_time_ms) || metrics.wall_time_ms < 0 || !Number.isSafeInteger(metrics.estimated_memory_bytes) || metrics.estimated_memory_bytes < 0) {
    throw ingestionError("analysis-worker-output-invalid", "analysis worker metrics are invalid");
  }
}

function assertCapabilityReport(report) {
  if (!report || typeof report !== "object" || report.schema_version !== "v1" || !boundedString(report.selected_profile) || !boundedString(report.selected_fallback) || !Array.isArray(report.features)) {
    throw ingestionError("analysis-capability-report-invalid", "analysis job requires a v1 capability report");
  }
}

function assertJobID(value) {
  if (!validJobID(value)) throw ingestionError("analysis-job-id-invalid", "analysis job id must be a bounded lower-case identifier");
}

function validJobID(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
}

function validDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function boundedString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
