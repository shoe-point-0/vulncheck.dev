import { ingestionError } from "./ingestion-error.mjs";
import { assertProjectEvidenceInput } from "./input.mjs";
import { hardResourceBudget, resolveResourceBudget } from "./resource-budget.mjs";
import { readStrictZip } from "./zip-reader.mjs";

export const analysisBundleSchemaVersion = "v1";
export const assuranceModuleView = "module-view";
export const assuranceProjectEvidence = "project-evidence";
const manifestPath = "manifest.json";
const zeroDigestPlaceholder = `sha256:${"0".repeat(64)}`;
const captureKindNativeGoList = "native-go-list";
const captureKindModuleArchive = "module-archive";

const maxTagLength = 128;
const maxBundleFileCount = 10_000;
const maxContentFileBytes = hardResourceBudget.maxBytes;
const supportedCGOPolicies = new Set(["disabled", "enabled"]);
const modulePathPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/;
const knownManifestFields = Object.freeze({
  schema_version: true,
  assurance: true,
  capture_kind: true,
  generated_at: true,
  producer: true,
  build_profile: true,
  roots: true,
  module_graph: true,
  package_inventory: true,
  diagnostics: true,
  content: true,
  source_digest: true,
  bundle_digest: true
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function assertString(value, field, code, message) {
  if (!isNonEmptyString(value)) {
    throw ingestionError(code, message);
  }
}

function parseDigest(value, field) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw ingestionError(`bundle-${field}-invalid`, `analysis bundle ${field} must be a lower-case sha256 digest`);
  }
  return value;
}

function validateManifestPath(path, maxPathDepth) {
  if (!isNonEmptyString(path) || path.length > 4_096 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw ingestionError("bundle-path-invalid", "analysis bundle paths must be bounded, relative slash-separated identifiers");
  }
  const parts = path.split("/");
  if (parts.length > maxPathDepth) {
    throw ingestionError("bundle-path-depth", "analysis bundle path depth exceeds budget");
  }
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw ingestionError("bundle-path-invalid", "analysis bundle paths must not contain traversal or redundant segments");
    }
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function compareIdentifiers(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalizeModuleGraph(graph) {
  return {
    main: graph.main,
    requirements: graph.requirements.map((moduleRef) => ({
      path: moduleRef.path,
      version: moduleRef.version,
      sum: moduleRef.sum
    })).sort((a, b) => compareIdentifiers(`${a.path}@${a.version}`, `${b.path}@${b.version}`))
  };
}

function canonicalizePackages(packages) {
  return packages.map((pkg) => ({
    path: pkg.path,
    module_path: pkg.module_path,
    module_version: pkg.module_version,
    files: [...pkg.files],
    imports: [...pkg.imports]
  })).sort((a, b) => compareIdentifiers(a.path, b.path)).map((pkg) => ({
    ...pkg,
    files: pkg.files.sort(),
    imports: pkg.imports.sort()
  }));
}

function canonicalizeContent(content) {
  return content.map((entry) => ({
    path: entry.path,
    size: entry.size,
    digest: entry.digest,
    length_prefixed_digest: `${String(entry.size)}:${entry.digest}`
  })).sort((a, b) => compareIdentifiers(a.path, b.path));
}

function canonicalizeSnapshotForDigest(snapshot) {
  return stableStringify({
    schema_version: snapshot.schema_version,
    assurance: snapshot.assurance,
    capture_kind: snapshot.capture_kind,
    generated_at: snapshot.generated_at,
    producer: snapshot.producer,
    build_profile: snapshot.build_profile,
    roots: [...snapshot.roots],
    module_graph: canonicalizeModuleGraph(snapshot.module_graph),
    package_inventory: canonicalizePackages(snapshot.package_inventory),
    diagnostics: snapshot.diagnostics,
    content: canonicalizeContent(snapshot.content),
    source_digest: snapshot.source_digest,
    bundle_digest: snapshot.bundle_digest
  });
}

function sourceDigestPayload(contentEntries) {
  return stableStringify(contentEntries.map((entry) => ({
    path: entry.path,
    size: entry.size,
    digest: entry.digest,
    length_prefixed_digest: `${String(entry.size)}:${entry.digest}`
  })).sort((a, b) => compareIdentifiers(a.path, b.path)));
}

function parseModuleGraph(manifest, budget) {
  const rawGraph = manifest.module_graph;
  if (!isObject(rawGraph)) {
    throw ingestionError("bundle-module-graph-invalid", "analysis bundle module graph must be an object");
  }
  const main = rawGraph.main;
  if (!isNonEmptyString(main)) {
    throw ingestionError("bundle-module-graph-invalid", "analysis bundle module graph requires main");
  }
  if (!modulePathPattern.test(main)) {
    throw ingestionError("bundle-module-graph-invalid", "analysis bundle module graph main is invalid");
  }
  validateManifestPath(main, budget.maxPathDepth);
  if (!Array.isArray(rawGraph.requirements)) {
    throw ingestionError("bundle-module-graph-invalid", "analysis bundle module graph requirements must be an array");
  }
  if (rawGraph.requirements.length > maxBundleFileCount || rawGraph.requirements.length > budget.maxFiles) {
    throw ingestionError("bundle-module-graph-invalid", "analysis bundle module graph requirements exceed budget");
  }
  const modules = [];
  const seen = new Set();
  for (const entry of rawGraph.requirements) {
    if (!isObject(entry)) {
      throw ingestionError("bundle-module-graph-invalid", "analysis bundle module requirements must be objects");
    }
    if (!isNonEmptyString(entry.path) || !isNonEmptyString(entry.version) || !isNonEmptyString(entry.sum)) {
      throw ingestionError("bundle-module-graph-invalid", "analysis bundle module requirement entries require path, version, and sum");
    }
    if (!modulePathPattern.test(entry.path) || entry.version.length > 256) {
      throw ingestionError("bundle-module-graph-invalid", "analysis bundle module requirement path or version is invalid");
    }
    if (entry.sum.length > 256) {
      throw ingestionError("bundle-module-graph-invalid", "analysis bundle module requirement sum exceeds budget");
    }
    if (!/^h1:[A-Za-z0-9+/=]{16,}$/.test(entry.sum)) {
      throw ingestionError("bundle-module-graph-invalid", "analysis bundle module sum is malformed");
    }
    const key = `${entry.path}@${entry.version}`;
    if (seen.has(key)) {
      throw ingestionError("bundle-module-graph-invalid", "analysis bundle module requirements must be unique");
    }
    seen.add(key);
    modules.push(Object.freeze({ path: entry.path, version: entry.version, sum: entry.sum }));
  }
  return Object.freeze({ main, requirements: Object.freeze(modules) });
}

function parseBuildProfile(manifest, budget) {
  const profile = manifest.build_profile;
  if (!isObject(profile)) {
    throw ingestionError("bundle-build-profile-invalid", "analysis bundle build profile is required");
  }
  assertString(profile.goos, "build_profile.goos", "bundle-build-profile-invalid", "analysis bundle build profile requires goos");
  assertString(profile.goarch, "build_profile.goarch", "bundle-build-profile-invalid", "analysis bundle build profile requires goarch");
  assertString(profile.cgo_policy, "build_profile.cgo_policy", "bundle-build-profile-invalid", "analysis bundle build profile requires cgo_policy");
  if (!supportedCGOPolicies.has(profile.cgo_policy)) {
    throw ingestionError("bundle-build-profile-invalid", "analysis bundle cgo policy is unsupported");
  }
  if (!Array.isArray(profile.build_tags)) {
    throw ingestionError("bundle-build-profile-invalid", "analysis bundle build profile build_tags must be an array");
  }
  if (profile.build_tags.length > 128) {
    throw ingestionError("bundle-build-profile-invalid", "analysis bundle build tags exceed budget");
  }
  const tags = [];
  const seen = new Set();
  for (const tag of profile.build_tags) {
    if (!isNonEmptyString(tag) || tag.length > maxTagLength || /\s/.test(tag)) {
      throw ingestionError("bundle-build-profile-invalid", "analysis bundle build tags must be bounded strings");
    }
    if (seen.has(tag)) {
      throw ingestionError("bundle-build-profile-invalid", "analysis bundle build tags must be unique");
    }
    seen.add(tag);
    tags.push(tag);
  }
  if (profile.goos.length > budget.maxPathDepth) {
    throw ingestionError("bundle-build-profile-invalid", "analysis bundle goos exceeds budget");
  }
  if (profile.goarch.length > budget.maxPathDepth) {
    throw ingestionError("bundle-build-profile-invalid", "analysis bundle goarch exceeds budget");
  }
  return Object.freeze({
    goos: profile.goos,
    goarch: profile.goarch,
    build_tags: Object.freeze(tags),
    cgo_policy: profile.cgo_policy
  });
}

function parseCaptureKind(manifest) {
  if (manifest.assurance === assuranceProjectEvidence && manifest.capture_kind !== captureKindNativeGoList) {
    throw ingestionError("bundle-capture-kind-invalid", "project evidence requires a native-go-list capture");
  }
  if (manifest.assurance === assuranceModuleView && manifest.capture_kind !== captureKindModuleArchive) {
    throw ingestionError("bundle-capture-kind-invalid", "module view requires a module-archive capture");
  }
  return manifest.capture_kind;
}

function parseProducer(manifest) {
  const producer = manifest.producer;
  if (!isObject(producer)) {
    throw ingestionError("bundle-producer-invalid", "analysis bundle producer is required");
  }
  assertString(producer.id, "producer.id", "bundle-producer-invalid", "analysis bundle producer id is required");
  assertString(producer.name, "producer.name", "bundle-producer-invalid", "analysis bundle producer name is required");
  assertString(producer.version, "producer.version", "bundle-producer-invalid", "analysis bundle producer version is required");
  assertString(producer.go_version, "producer.go_version", "bundle-producer-invalid", "analysis bundle go toolchain version is required");
  return Object.freeze({
    id: producer.id,
    name: producer.name,
    version: producer.version,
    go_version: producer.go_version
  });
}

function parseRoots(manifest) {
  const roots = manifest.roots;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw ingestionError("bundle-root-packages-invalid", "analysis bundle roots must be a non-empty array");
  }
  const normalized = [];
  const seen = new Set();
  for (const root of roots) {
    if (!isNonEmptyString(root)) {
      throw ingestionError("bundle-root-packages-invalid", "analysis bundle root packages must be strings");
    }
    if (root.includes(" ") || root.length > 256) {
      throw ingestionError("bundle-root-packages-invalid", "analysis bundle root packages must be bounded");
    }
    if (seen.has(root)) {
      throw ingestionError("bundle-root-packages-invalid", "analysis bundle root packages must be unique");
    }
    seen.add(root);
    normalized.push(root);
  }
  return Object.freeze(normalized);
}

function parsePackageInventory(manifest, modules, roots, budget) {
  const packages = manifest.package_inventory;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package inventory must be a non-empty array");
  }
  if (packages.length > budget.maxFiles) {
    throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package inventory exceeds file limit");
  }
  const moduleReferences = new Set(modules.requirements.map((moduleRef) => `${moduleRef.path}@${moduleRef.version}`));
  const normalized = [];
  const packageSet = new Set();
  const rootSet = new Set(roots);
  for (const entry of packages) {
    if (!isObject(entry)) {
      throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package inventory entries must be objects");
    }
    if (!isNonEmptyString(entry.path) || !isNonEmptyString(entry.module_path) || !isNonEmptyString(entry.module_version)) {
      throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package inventory entry is missing required fields");
    }
    if (!Array.isArray(entry.files) || !Array.isArray(entry.imports)) {
      throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package inventory entry requires files and imports");
    }
    const referencesMainModule = entry.module_path === modules.main && entry.module_version === "devel";
    const moduleRef = `${entry.module_path}@${entry.module_version}`;
    if (!referencesMainModule && !moduleReferences.has(moduleRef)) {
      throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package inventory references an unknown module");
    }
    if (packageSet.has(entry.path)) {
      throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package paths must be unique");
    }
    if (entry.path.length > 1_024 || /\s/.test(entry.path) || !modulePathPattern.test(entry.module_path)) {
      throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package inventory path is invalid");
    }
    const files = [];
    const fileSet = new Set();
    for (const filePath of entry.files) {
      if (!isNonEmptyString(filePath)) {
        throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package file references must be strings");
      }
      validateManifestPath(filePath, 32);
      if (fileSet.has(filePath)) {
        throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package file references must be unique");
      }
      fileSet.add(filePath);
      files.push(filePath);
    }
    const imports = [];
    const importSet = new Set();
    for (const imported of entry.imports) {
      if (!isNonEmptyString(imported)) {
        throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package imports must be strings");
      }
      if (imported.length > 1_024) {
        throw ingestionError("bundle-package-inventory-invalid", "analysis bundle import path exceeds budget");
      }
      if (importSet.has(imported)) {
        throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package imports must be unique");
      }
      importSet.add(imported);
      imports.push(imported);
    }
    packageSet.add(entry.path);
    normalized.push(Object.freeze({
      path: entry.path,
      module_path: entry.module_path,
      module_version: entry.module_version,
      files: Object.freeze(files),
      imports: Object.freeze(imports)
    }));
    if (entry.path === modules.main && !rootSet.has(entry.path)) {
      rootSet.add(entry.path);
    }
  }
  for (const root of roots) {
    if (!packageSet.has(root)) {
      throw ingestionError("bundle-root-packages-invalid", "analysis bundle root package must be listed in package inventory");
    }
  }
  for (const pkg of normalized) {
    for (const imported of pkg.imports) {
      if ((imported === modules.main || imported.startsWith(`${modules.main}/`)) && !packageSet.has(imported)) {
        throw ingestionError("bundle-package-inventory-invalid", "analysis bundle package import references an undeclared package");
      }
    }
  }
  return Object.freeze(normalized.sort((a, b) => compareIdentifiers(a.path, b.path)));
}

function parseDiagnostics(manifest) {
  const diagnostics = manifest.diagnostics;
  if (!Array.isArray(diagnostics)) {
    return Object.freeze([]);
  }
  if (diagnostics.length > 1_024) {
    throw ingestionError("bundle-diagnostic-limit", "analysis bundle diagnostics exceed v1 limits");
  }
  return Object.freeze(diagnostics.map((entry) => {
    if (!isObject(entry) || !isNonEmptyString(entry.code) || !isNonEmptyString(entry.message)) {
      throw ingestionError("bundle-diagnostics-invalid", "analysis bundle diagnostics require code and message");
    }
    return Object.freeze({
      code: entry.code,
      message: entry.message
    });
  }));
}

function parseContent(manifest, budget) {
  const content = manifest.content;
  if (!Array.isArray(content) || content.length === 0 || content.length > budget.maxFiles) {
    throw ingestionError("bundle-content-invalid", "analysis bundle content must be a bounded non-empty array");
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of content) {
    if (!isObject(entry) || isObject(entry) && Array.isArray(entry)) {
      throw ingestionError("bundle-content-invalid", "analysis bundle content entries must be objects");
    }
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > budget.maxBytes || entry.size > maxContentFileBytes) {
      throw ingestionError("bundle-content-invalid", "analysis bundle content entries require bounded sizes");
    }
    const digest = parseDigest(entry.digest, "content-digest");
    validateManifestPath(entry.path, budget.maxPathDepth);
    if (entry.path === manifestPath || seen.has(entry.path)) {
      throw ingestionError("bundle-content-invalid", "analysis bundle content entries must be unique");
    }
    if (entry.length_prefixed_digest !== `${String(entry.size)}:${digest}`) {
      throw ingestionError("bundle-content-invalid", "analysis bundle content length-prefixed digest is invalid");
    }
    seen.add(entry.path);
    normalized.push({
      path: entry.path,
      digest,
      size: entry.size
    });
  }
  return Object.freeze(normalized.map((entry) => Object.freeze({
    path: entry.path,
    digest: entry.digest,
    size: entry.size,
    length_prefixed_digest: `${String(entry.size)}:${entry.digest}`
  })));
}

function parseManifest(bytes, budget) {
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw ingestionError("bundle-manifest-malformed", "analysis bundle manifest must be valid utf-8 json");
  }
  if (!isObject(manifest) || manifest.schema_version !== analysisBundleSchemaVersion) {
    throw ingestionError("bundle-schema-invalid", "analysis bundle manifest does not match supported schema");
  }
  assertString(manifest.assurance, "assurance", "bundle-assurance-invalid", "analysis bundle assurance is required");
  if (manifest.assurance !== assuranceModuleView && manifest.assurance !== assuranceProjectEvidence) {
    throw ingestionError("bundle-assurance-invalid", "analysis bundle assurance must be module-view or project-evidence");
  }
  assertString(manifest.generated_at, "generated_at", "bundle-generated-at-invalid", "analysis bundle generated_at is required");
  if (Number.isNaN(Date.parse(manifest.generated_at))) {
    throw ingestionError("bundle-generated-at-invalid", "analysis bundle generated_at must be a valid timestamp");
  }

  const parsed = {};
  parsed.schema_version = manifest.schema_version;
  parsed.assurance = manifest.assurance;
  parsed.capture_kind = parseCaptureKind(manifest);
  parsed.generated_at = manifest.generated_at;
  parsed.producer = parseProducer(manifest);
  parsed.build_profile = parseBuildProfile(manifest, budget);
  parsed.roots = parseRoots(manifest);
  parsed.module_graph = parseModuleGraph(manifest, budget);
  parsed.content = parseContent(manifest, budget);
  parsed.package_inventory = parsePackageInventory(manifest, parsed.module_graph, parsed.roots, budget);
  parsed.diagnostics = parseDiagnostics(manifest);
  parsed.source_digest = parseDigest(manifest.source_digest, "source-digest");
  parsed.bundle_digest = parseDigest(manifest.bundle_digest, "bundle-digest");
  const unknown_fields = {};
  for (const [name, value] of Object.entries(manifest)) {
    if (!knownManifestFields[name]) {
      unknown_fields[name] = value;
    }
  }
  if (Object.keys(unknown_fields).length > 0) {
    parsed.unknown_fields = Object.freeze(unknown_fields);
  }

  const declaredContent = new Set(parsed.content.map((entry) => entry.path));
  for (const pkg of parsed.package_inventory) {
    for (const file of pkg.files) {
      if (!declaredContent.has(file)) {
        throw ingestionError("bundle-content-invalid", "analysis bundle package file references must be declared");
      }
    }
  }

  return Object.freeze(parsed);
}

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
  const parsed = parseManifest(manifestEntry.bytes, budget);
  const contentEntries = zip.entries.filter((entry) => entry.path !== manifestPath);
  if (contentEntries.length !== parsed.content.length) {
    throw ingestionError("bundle-content-mismatch", "analysis bundle content does not match manifest");
  }
  const expectedDigests = new Map(parsed.content.map((entry) => [entry.path, entry]));
  const cryptoAPI = options.cryptoAPI ?? globalThis.crypto;
  const content = [];
  for (const entry of contentEntries) {
    const declared = expectedDigests.get(entry.path);
    if (!declared) {
      throw ingestionError("bundle-content-mismatch", "analysis bundle contains undeclared content");
    }
    if (entry.bytes.byteLength !== declared.size) {
      throw ingestionError("bundle-content-size-mismatch", "analysis bundle content size does not match manifest");
    }
    const digest = await sha256Digest(entry.bytes, cryptoAPI);
    if (digest !== declared.digest) {
      throw ingestionError("bundle-digest-mismatch", "analysis bundle content digest does not match manifest");
    }
    validateManifestPath(entry.path, budget.maxPathDepth);
    content.push(Object.freeze({
      path: entry.path,
      size: entry.bytes.byteLength,
      digest
    }));
  }
  const sourceDigest = await sha256Digest(new TextEncoder().encode(sourceDigestPayload(content)));
  if (sourceDigest !== parsed.source_digest) {
    throw ingestionError("bundle-source-digest-mismatch", "analysis bundle source digest does not match manifest");
  }
  const manifestForDigest = canonicalizeSnapshotForDigest({ ...parsed, bundle_digest: zeroDigestPlaceholder, content });
  const computedBundleDigest = await sha256Digest(new TextEncoder().encode(manifestForDigest), cryptoAPI);
  if (computedBundleDigest !== parsed.bundle_digest) {
    throw ingestionError("bundle-manifest-digest-mismatch", "analysis bundle manifest digest does not match content");
  }
  return Object.freeze({
    schema_version: parsed.schema_version,
    assurance: parsed.assurance,
    capture_kind: parsed.capture_kind,
    generated_at: parsed.generated_at,
    producer: parsed.producer,
    build_profile: parsed.build_profile,
    roots: parsed.roots,
    module_graph: parsed.module_graph,
    package_inventory: parsed.package_inventory,
    diagnostics: parsed.diagnostics,
    content,
    source_digest: parsed.source_digest,
    bundle_digest: parsed.bundle_digest,
    unknown_fields: parsed.unknown_fields ?? undefined
  });
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

export {
  parseManifest as __parseManifestForTests,
  canonicalizeSnapshotForDigest as __canonicalizeSnapshotForTests,
  sourceDigestPayload as __sourceDigestPayloadForTests,
  stableStringify as __stableStringifyForTests
};
