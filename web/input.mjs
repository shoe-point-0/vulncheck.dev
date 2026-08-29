import { ingestionError } from "./ingestion-error.mjs";
import { validateModuleCoordinate } from "./module-coordinate.mjs";

export const inputKind = Object.freeze({
  module: "module-input",
  analysisBundle: "analysis-bundle-input"
});

// ModuleInput has deliberately less authority than an AnalysisBundleInput.
// In particular, no caller can use a module archive or coordinate to request
// Project Evidence reachability.
export function createModuleInput({ coordinate, archive } = {}) {
  const hasCoordinate = coordinate !== undefined;
  const hasArchive = archive !== undefined;
  if (hasCoordinate === hasArchive) {
    throw ingestionError("module-input-invalid", "module input requires exactly one coordinate or archive");
  }
  if (hasCoordinate) {
    return Object.freeze({ kind: inputKind.module, coordinate: validateModuleCoordinate(coordinate) });
  }
  return Object.freeze({ kind: inputKind.module, archive: validateArchive(archive) });
}

export function createAnalysisBundleInput(archive) {
  return Object.freeze({ kind: inputKind.analysisBundle, archive: validateArchive(archive) });
}

// assertAnalysisInput repeats all structural checks at the browser-message
// boundary because structured cloning removes Object.freeze().
export function assertAnalysisInput(value) {
  if (!value || typeof value !== "object") {
    throw ingestionError("input-invalid", "analysis input must be an object");
  }
  if (value.kind === inputKind.module) {
    assertOnlyKeys(value, ["kind", "coordinate", "archive"], "module-input-invalid", "module input contains unsupported fields");
    return createModuleInput(value);
  }
  if (value.kind === inputKind.analysisBundle) {
    assertOnlyKeys(value, ["kind", "archive"], "analysis-bundle-input-invalid", "analysis bundle input contains unsupported fields");
    return createAnalysisBundleInput(value.archive);
  }
  throw ingestionError("input-kind-unsupported", "analysis input kind is unsupported");
}

export function assertProjectEvidenceInput(value) {
  const input = assertAnalysisInput(value);
  if (input.kind !== inputKind.analysisBundle) {
    throw ingestionError("project-evidence-required", "project reachability requires a verified analysis bundle");
  }
  return input;
}

function validateArchive(value) {
  if (!value || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.slice !== "function") {
    throw ingestionError("archive-input-invalid", "archive input must be a Blob or File with a finite size");
  }
  return value;
}

function assertOnlyKeys(value, allowed, code, message) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw ingestionError(code, message);
  }
}
