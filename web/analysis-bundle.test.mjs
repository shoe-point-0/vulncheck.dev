import assert from "node:assert/strict";
import test from "node:test";

import { assuranceModuleView, assuranceProjectEvidence, hydrateAnalysisBundle, sha256Digest } from "./analysis-bundle.mjs";
import { createAnalysisBundleInput } from "./input.mjs";
import { makeStoredZip } from "./test-zip.mjs";
import { finalizeManifest, manifestBase } from "./analysis-bundle-fixture.mjs";

test("hydrates a canonical, immutable v1 ProjectSnapshot", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const manifest = await validManifest(source);
  const archive = makeArchive(manifest, source);

  const first = await hydrateAnalysisBundle(createAnalysisBundleInput(archive));
  const second = await hydrateAnalysisBundle(createAnalysisBundleInput(archive));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.package_inventory), true);
  assert.equal(first.schema_version, "v1");
  assert.deepEqual(first.content, [{ path: "sources/demo.go", digest: await sha256Digest(source), size: source.byteLength }]);
  assert.deepEqual(first.roots, ["example.com/project"]);
  assert.equal(first.assurance, assuranceProjectEvidence);
  assert.equal(first.capture_kind, "native-go-list");
});

test("fails closed for corrupt content, schema, oversized input, and incomplete profile", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const manifest = await validManifest(source);

  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeStoredZip([{ path: "manifest.json", content: "{}" }]))),
    { code: "bundle-schema-invalid" }
  );
  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(manifest, new TextEncoder().encode("package evil\n")))),
    { code: "bundle-digest-mismatch" }
  );
  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(manifest, source)), { budget: { maxBytes: 1 } }),
    { code: "analysis-bundle-limit" }
  );

  const incomplete = structuredClone(manifest);
  delete incomplete.build_profile.goos;
  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(incomplete, source))),
    { code: "bundle-build-profile-invalid" }
  );
});

test("rejects duplicate identifiers, missing source, undeclared package, and malformed length-prefixed digest", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const manifest = await validManifest(source);

  const duplicateContent = structuredClone(manifest);
  duplicateContent.content.push(structuredClone(duplicateContent.content[0]));
  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(duplicateContent, source))),
    { code: "bundle-content-invalid" }
  );

  const missingSource = structuredClone(manifest);
  missingSource.package_inventory[0].files = ["sources/missing.go"];
  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(missingSource, source))),
    { code: "bundle-content-invalid" }
  );

  const undeclaredPackage = structuredClone(manifest);
  undeclaredPackage.package_inventory[0].imports = ["example.com/project/absent"];
  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(undeclaredPackage, source))),
    { code: "bundle-package-inventory-invalid" }
  );

  const malformedLengthPrefix = structuredClone(manifest);
  malformedLengthPrefix.content[0].length_prefixed_digest = "0:sha256:wrong";
  await assert.rejects(
    hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(malformedLengthPrefix, source))),
    { code: "bundle-content-invalid" }
  );
});

test("distinguishes a native Project Evidence bundle from a Module View bundle", async () => {
  const source = new TextEncoder().encode("package demo\n");
  const manifest = await validManifest(source);
  manifest.assurance = assuranceModuleView;
  manifest.capture_kind = "module-archive";
  await finalizeManifest(manifest);

  const snapshot = await hydrateAnalysisBundle(createAnalysisBundleInput(makeArchive(manifest, source)));
  assert.equal(snapshot.assurance, assuranceModuleView);
  assert.equal(snapshot.capture_kind, "module-archive");
});

async function validManifest(source) {
  const manifest = manifestBase("sources/demo.go", await sha256Digest(source), source.byteLength);
  await finalizeManifest(manifest);
  return manifest;
}

function makeArchive(manifest, source) {
  return makeStoredZip([
    { path: "manifest.json", content: JSON.stringify(manifest) },
    { path: "sources/demo.go", bytes: source }
  ]);
}
