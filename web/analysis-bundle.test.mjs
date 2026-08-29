import assert from "node:assert/strict";
import test from "node:test";

import { hydrateAnalysisBundle, sha256Digest } from "./analysis-bundle.mjs";
import { createAnalysisBundleInput } from "./input.mjs";
import { makeStoredZip } from "./test-zip.mjs";

test("hydrates a minimal v1 bundle after validating its content digest", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const digest = await sha256Digest(source);
  const manifest = JSON.stringify({ schema_version: "v1", files: [{ path: "sources/demo.go", digest }] });
  const bundle = createAnalysisBundleInput(makeStoredZip([
    { path: "manifest.json", content: manifest },
    { path: "sources/demo.go", bytes: source }
  ]));

  const hydrated = await hydrateAnalysisBundle(bundle);
  assert.equal(hydrated.schemaVersion, "v1");
  assert.deepEqual(hydrated.content.map((entry) => entry.path), ["sources/demo.go"]);
});

test("fails closed for malformed schema and content-digest mismatch", async () => {
  const badSchema = createAnalysisBundleInput(makeStoredZip([{ path: "manifest.json", content: "{}" }]));
  await assert.rejects(hydrateAnalysisBundle(badSchema), { code: "bundle-schema-invalid" });

  const manifest = JSON.stringify({ schema_version: "v1", files: [{ path: "sources/demo.go", digest: `sha256:${"0".repeat(64)}` }] });
  const badDigest = createAnalysisBundleInput(makeStoredZip([
    { path: "manifest.json", content: manifest },
    { path: "sources/demo.go", content: "package demo\n" }
  ]));
  await assert.rejects(hydrateAnalysisBundle(badDigest), { code: "bundle-digest-mismatch" });
});
