import { ingestionError } from "./ingestion-error.mjs";
import { assertProjectEvidenceInput } from "./input.mjs";
import { hardResourceBudget, resolveResourceBudget } from "./resource-budget.mjs";
import { readStrictZip } from "./zip-reader.mjs";

export const analysisBundleSchemaVersion = "v1";
const manifestPath = "manifest.json";

// hydrateAnalysisBundle is intentionally worker-only: it validates a minimal
// v1 tracer manifest and one or more content digests, but does not create a
// ProjectSnapshot or reachability result. Task 02 owns that domain contract.
export async function hydrateAnalysisBundle(input, options = {}) {
  const bundleInput = assertProjectEvidenceInput(input);
  const budget = resolveResourceBudget(options.budget ?? hardResourceBudget);
  const zip = await readStrictZip(bundleInput.archive, {
    budget,
    boundary: "analysis-bundle",
    signal: options.signal,
    now: options.now,
    decompress: options.decompress
  });
  const manifestEntry = zip.entries.find((entry) => entry.path === manifestPath);
  if (!manifestEntry) {
    throw ingestionError("bundle-manifest-missing", "analysis bundle manifest is required");
  }
  const manifest = parseManifest(manifestEntry.bytes, budget);
  const content = zip.entries.filter((entry) => entry.path !== manifestPath);
  if (content.length !== manifest.files.length) {
    throw ingestionError("bundle-content-mismatch", "analysis bundle content does not match its manifest");
  }
  const declaredFiles = new Map(manifest.files.map((file) => [file.path, file]));
  const cryptoAPI = options.cryptoAPI ?? globalThis.crypto;
  for (const entry of content) {
    const declared = declaredFiles.get(entry.path);
    if (!declared) {
      throw ingestionError("bundle-content-mismatch", "analysis bundle contains undeclared content");
    }
    const digest = await sha256Digest(entry.bytes, cryptoAPI);
    if (digest !== declared.digest) {
      throw ingestionError("bundle-digest-mismatch", "analysis bundle content digest does not match its manifest");
    }
  }
  return Object.freeze({
    schemaVersion: manifest.schema_version,
    content: Object.freeze(content.map((entry) => Object.freeze({ path: entry.path, bytes: entry.bytes, digest: declaredFiles.get(entry.path).digest })))
  });
}

function parseManifest(bytes, budget) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw ingestionError("bundle-manifest-malformed", "analysis bundle manifest must be valid utf-8 json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schema_version !== analysisBundleSchemaVersion || !Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > budget.maxFiles) {
    throw ingestionError("bundle-schema-invalid", "analysis bundle manifest does not satisfy the supported v1 tracer schema");
  }
  const paths = new Set();
  const files = parsed.files.map((file) => {
    if (!file || typeof file !== "object" || Object.keys(file).length !== 2 || typeof file.path !== "string" || !/^sha256:[0-9a-f]{64}$/.test(file.digest)) {
      throw ingestionError("bundle-schema-invalid", "analysis bundle manifest file entries require a path and sha256 digest");
    }
    validateManifestPath(file.path, budget.maxPathDepth);
    if (file.path === manifestPath || paths.has(file.path)) {
      throw ingestionError("bundle-schema-invalid", "analysis bundle manifest file paths must be unique content paths");
    }
    paths.add(file.path);
    return Object.freeze({ path: file.path, digest: file.digest });
  });
  return Object.freeze({ schema_version: parsed.schema_version, files: Object.freeze(files) });
}

function validateManifestPath(path, maxPathDepth) {
  if (!path || path.length > 4_096 || path.includes("\u0000") || path.includes("\\") || path.startsWith("/")) {
    throw ingestionError("bundle-schema-invalid", "analysis bundle content paths must be bounded relative slash-separated paths");
  }
  const segments = path.split("/");
  if (segments.length > maxPathDepth || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw ingestionError("bundle-schema-invalid", "analysis bundle content paths must not contain traversal or redundant segments");
  }
}

export async function sha256Digest(bytes, cryptoAPI = globalThis.crypto) {
  if (!cryptoAPI?.subtle?.digest) {
    throw ingestionError("bundle-digest-unavailable", "sha256 digest support is unavailable in this browser runtime");
  }
  let digest;
  try {
    digest = await cryptoAPI.subtle.digest("SHA-256", bytes);
  } catch (cause) {
    throw ingestionError("bundle-digest-unavailable", "sha256 digest computation failed", { cause });
  }
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
