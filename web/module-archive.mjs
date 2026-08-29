import { ingestionError } from "./ingestion-error.mjs";
import { assertAnalysisInput, inputKind } from "./input.mjs";
import { validateModuleCoordinate } from "./module-coordinate.mjs";
import { hardResourceBudget, resolveResourceBudget } from "./resource-budget.mjs";
import { readStrictZip } from "./zip-reader.mjs";

// hydrateModuleArchive validates a locally supplied module ZIP in the worker.
// It derives one canonical module coordinate from the required Go ZIP prefix,
// then exposes only paths relative to that prefix. This remains Module View
// input: it intentionally produces no ProjectSnapshot or reachability claim.
export async function hydrateModuleArchive(input, options = {}) {
  const moduleInput = assertModuleArchiveInput(input);
  return readModuleZip(moduleInput.archive, options);
}

// readModuleZip also accepts an expected coordinate for a future consent-bound
// fetch adapter. The expected coordinate is optional for a local archive, but
// when supplied it must exactly match the coordinate declared by the ZIP.
export async function readModuleZip(archive, options = {}) {
  const budget = resolveResourceBudget(options.budget ?? hardResourceBudget);
  const expectedCoordinate = options.coordinate === undefined
    ? undefined
    : validateModuleCoordinate(options.coordinate);
  const zip = await readStrictZip(archive, {
    budget,
    boundary: "module-archive",
    signal: options.signal,
    now: options.now,
    decompress: options.decompress
  });
  const module = validateModuleArchivePrefix(zip.archivePaths, expectedCoordinate);
  const entries = zip.entries.map((entry) => Object.freeze({
    path: entry.path.slice(module.prefix.length),
    bytes: entry.bytes,
    crc: entry.crc,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize
  }));
  return Object.freeze({
    coordinate: module.coordinate,
    entries: Object.freeze(entries)
  });
}

function assertModuleArchiveInput(value) {
  const input = assertAnalysisInput(value);
  if (input.kind !== inputKind.module || !input.archive) {
    throw ingestionError("module-archive-required", "module archive validation requires a local module archive input");
  }
  return input;
}

function validateModuleArchivePrefix(archivePaths, expectedCoordinate) {
  if (!Array.isArray(archivePaths) || archivePaths.length === 0) {
    throw ingestionError("module-zip-prefix-invalid", "module zip requires entries under one module path and version prefix");
  }
  let module;
  for (const archivePath of archivePaths) {
    const candidate = moduleFromArchivePath(archivePath);
    if (!module) {
      module = candidate;
    }
    if (candidate.prefix !== module.prefix || !archivePath.startsWith(module.prefix)) {
      throw ingestionError("module-zip-prefix-invalid", "module zip entries must share one canonical module path and version prefix");
    }
  }
  if (expectedCoordinate && (expectedCoordinate.path !== module.coordinate.path || expectedCoordinate.version !== module.coordinate.version)) {
    throw ingestionError("module-zip-coordinate-mismatch", "module zip prefix does not match the requested module coordinate");
  }
  return module;
}

function moduleFromArchivePath(archivePath) {
  if (typeof archivePath !== "string") {
    throw ingestionError("module-zip-prefix-invalid", "module zip entry path is invalid");
  }
  const at = archivePath.indexOf("@");
  const prefixEnd = at < 1 ? -1 : archivePath.indexOf("/", at);
  if (prefixEnd < 0) {
    throw ingestionError("module-zip-prefix-invalid", "module zip entry lacks the required module path and version prefix");
  }
  let coordinate;
  try {
    coordinate = validateModuleCoordinate({
      path: archivePath.slice(0, at),
      version: archivePath.slice(at + 1, prefixEnd)
    });
  } catch {
    throw ingestionError("module-zip-prefix-invalid", "module zip prefix must contain a canonical Go module coordinate");
  }
  return Object.freeze({
    coordinate,
    prefix: `${coordinate.path}@${coordinate.version}/`
  });
}
