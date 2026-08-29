import { sha256Digest, assuranceProjectEvidence, __sourceDigestPayloadForTests, __canonicalizeSnapshotForTests } from "./analysis-bundle.mjs";

const zeroDigestPlaceholder = `sha256:${"0".repeat(64)}`;

export function manifestBase(contentPath, digest, byteLength, options = {}) {
  const now = options.generatedAt ?? "2026-08-29T00:00:00Z";
  const root = options.rootPackage ?? "example.com/project";
  const modulePath = options.modulePath ?? "example.com/project";
  return {
    schema_version: "v1",
    assurance: assuranceProjectEvidence,
    capture_kind: "native-go-list",
    generated_at: now,
    producer: {
      id: "vulncheck-local",
      name: "vulncheck-bundle",
      version: "0.1.0",
      go_version: "go1.23.0"
    },
    build_profile: {
      goos: "linux",
      goarch: "amd64",
      build_tags: options.buildTags ?? [],
      cgo_policy: "disabled"
    },
    roots: [root],
    module_graph: {
      main: modulePath,
      requirements: options.requirements ?? []
    },
    package_inventory: [{
      path: root,
      module_path: modulePath,
      module_version: options.moduleVersion ?? "devel",
      files: [contentPath],
      imports: []
    }],
    diagnostics: [],
    content: [{
      path: contentPath,
      size: byteLength,
      digest,
      length_prefixed_digest: `${String(byteLength)}:${digest}`
    }],
    source_digest: "",
    bundle_digest: ""
  };
}

export async function finalizeManifest(manifest) {
  manifest.source_digest = await sha256Digest(new TextEncoder().encode(__sourceDigestPayloadForTests(manifest.content)));
  manifest.bundle_digest = await sha256Digest(new TextEncoder().encode(__canonicalizeSnapshotForTests({
    ...manifest,
    content: manifest.content,
    bundle_digest: zeroDigestPlaceholder
  })));
  return manifest;
}
